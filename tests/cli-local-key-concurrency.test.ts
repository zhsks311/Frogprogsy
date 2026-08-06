import { afterEach, describe, expect, test } from "bun:test";
import { spawn } from "node:child_process";
import type { ChildProcessByStdio } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, watch, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import type { Readable } from "node:stream";
import { fileURLToPath } from "node:url";

const repoRoot = dirname(fileURLToPath(new URL("../package.json", import.meta.url)));
const cliPath = join(repoRoot, "src", "cli.ts");
type CliChild = ChildProcessByStdio<null, Readable, Readable>;

const homes: string[] = [];
const children = new Set<CliChild>();

interface ChildResult {
  code: number | null;
  signal: NodeJS.Signals | null;
  stdout: string;
  stderr: string;
}

function makeHome(prefix: string): string {
  const home = mkdtempSync(join(tmpdir(), prefix));
  homes.push(home);
  return home;
}

function runCli(home: string, values: string[], env: Record<string, string> = {}): {
  child: CliChild;
  result: Promise<ChildResult>;
} {
  const child = spawn(process.execPath, [cliPath, ...values], {
    cwd: repoRoot,
    env: {
      ...process.env,
      FROGPROGSY_HOME: home,
      NODE_ENV: "test",
      ...env,
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  children.add(child);

  let stdout = "";
  let stderr = "";
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", chunk => { stdout += chunk; });
  child.stderr.on("data", chunk => { stderr += chunk; });

  const { promise: result, resolve, reject } = Promise.withResolvers<ChildResult>();
  child.once("error", reject);
  child.once("close", (code, signal) => {
    children.delete(child);
    resolve({ code, signal, stdout, stderr });
  });
  return { child, result };
}

async function waitForSpawn(child: CliChild): Promise<void> {
  if (child.pid !== undefined) return;
  const { promise, resolve, reject } = Promise.withResolvers<void>();
  child.once("spawn", resolve);
  child.once("error", reject);
  await promise;
}

async function waitForFile(path: string): Promise<void> {
  if (existsSync(path)) return;
  const { promise, resolve } = Promise.withResolvers<void>();
  const watcher = watch(dirname(path), () => {
    if (!existsSync(path)) return;
    watcher.close();
    resolve();
  });
  if (existsSync(path)) {
    watcher.close();
    resolve();
  }
  await promise;
}

async function availablePort(): Promise<number> {
  const { promise, resolve, reject } = Promise.withResolvers<number>();
  const server = createServer();
  server.once("error", reject);
  server.listen({ host: "127.0.0.1", port: 0 }, () => {
    const address = server.address();
    if (!address || typeof address === "string") {
      server.close();
      reject(new Error("failed to reserve a test port"));
      return;
    }
    server.close(error => error ? reject(error) : resolve(address.port));
  });
  return await promise;
}

afterEach(async () => {
  const exits: Promise<void>[] = [];
  for (const child of children) {
    const { promise, resolve } = Promise.withResolvers<void>();
    exits.push(promise);
    child.once("close", resolve);
    child.kill("SIGTERM");
  }
  await Promise.all(exits);
  children.clear();
  for (const home of homes.splice(0)) rmSync(home, { recursive: true, force: true });
});

describe("local-key/start cross-process coordination", () => {
  test("two overlapping local-key adds both persist", async () => {
    const home = makeHome("frogp-local-key-race-");
    const gate = join(home, "release-config-lock");

    const first = runCli(home, ["local-key", "add", "first"], {
      FROGP_TEST_CONFIG_LOCK_GATE: gate,
    });
    await waitForFile(`${gate}.${first.child.pid}.ready`);

    const second = runCli(home, ["local-key", "add", "second"], {
      FROGP_TEST_CONFIG_LOCK_GATE: gate,
    });
    await waitForSpawn(second.child);
    writeFileSync(gate, "release", "utf8");

    const [firstResult, secondResult] = await Promise.all([first.result, second.result]);
    expect(firstResult.code).toBe(0);
    expect(secondResult.code).toBe(0);
    expect(firstResult.stdout).toMatch(/frogp_[A-Za-z0-9_-]{43}/);
    expect(secondResult.stdout).toMatch(/frogp_[A-Za-z0-9_-]{43}/);

    const config = JSON.parse(readFileSync(join(home, "config.json"), "utf8"));
    expect(config.localAccess.keys.map((key: { label?: string }) => key.label).sort()).toEqual(["first", "second"]);
  }, 20_000);

  test("a killed lock holder cannot strand or split later key edits", async () => {
    const home = makeHome("frogp-local-key-killed-holder-");
    const gate = join(home, "release-config-lock");
    const holder = runCli(home, ["local-key", "add", "abandoned"], {
      FROGP_TEST_CONFIG_LOCK_GATE: gate,
    });
    await waitForFile(`${gate}.${holder.child.pid}.ready`);
    holder.child.kill("SIGKILL");
    await holder.result;

    const first = runCli(home, ["local-key", "add", "first"]);
    const second = runCli(home, ["local-key", "add", "second"]);
    const results = await Promise.all([first.result, second.result]);

    expect(results.map(result => result.code)).toEqual([0, 0]);
    const config = JSON.parse(readFileSync(join(home, "config.json"), "utf8"));
    expect(config.localAccess.keys.map((key: { label?: string }) => key.label).sort()).toEqual(["first", "second"]);
  }, 10_000);

  test("test mode refuses the default config home before creating lock files", async () => {
    const home = makeHome("frogp-default-home-guard-");
    const invocation = runCli(home, ["local-key", "add", "blocked"], {
      HOME: home,
      FROGPROGSY_HOME: "",
    });
    const result = await invocation.result;

    expect(result.code).not.toBe(0);
    expect(existsSync(join(home, ".frogprogsy", "locks"))).toBe(false);
  });

  test("an edit queued behind startup sees the published live PID and refuses", async () => {
    const home = makeHome("frogp-start-key-race-");
    const claudeHome = join(home, "claude");
    mkdirSync(claudeHome, { recursive: true });
    const gate = join(home, "release-config-lock");
    const port = await availablePort();
    writeFileSync(join(home, "config.json"), JSON.stringify({
      port,
      providers: {
        anthropic: {
          adapter: "anthropic",
          baseUrl: "https://api.anthropic.com",
          authMode: "forward",
          defaultModel: "claude-sonnet-4-6",
        },
      },
      defaultProvider: "anthropic",
      subagentModels: [],
      websockets: false,
    }, null, 2) + "\n");

    const start = runCli(home, ["start"], {
      CLAUDE_HOME: claudeHome,
      FROGP_DETACHED: "1",
      FROGP_EXTERNAL_SUPERVISOR: "1",
      FROGP_TEST_CONFIG_LOCK_GATE: gate,
    });
    await waitForFile(`${gate}.${start.child.pid}.ready`);

    const edit = runCli(home, ["local-key", "add", "too-late"], {
      FROGP_TEST_CONFIG_LOCK_GATE: gate,
    });
    await waitForSpawn(edit.child);
    writeFileSync(gate, "release", "utf8");

    await waitForFile(join(home, "frogp.pid"));
    const editResult = await edit.result;
    expect(editResult.code).not.toBe(0);
    expect(`${editResult.stdout}${editResult.stderr}`).toContain("Stop the proxy before you add a relay access key");
    expect(`${editResult.stdout}${editResult.stderr}`).not.toMatch(/frogp_[A-Za-z0-9_-]{43}/);
    const config = JSON.parse(readFileSync(join(home, "config.json"), "utf8"));
    expect(config.localAccess?.keys ?? []).toEqual([]);

    start.child.kill("SIGTERM");
    await start.result;
  }, 20_000);

  test("a live PID refuses key edits even while health is unavailable", async () => {
    const home = makeHome("frogp-live-pid-key-edit-");
    writeFileSync(join(home, "frogp.pid"), String(process.pid), "utf8");

    const { result } = runCli(home, ["local-key", "add", "blocked"]);
    const editResult = await result;

    expect(editResult.code).not.toBe(0);
    expect(`${editResult.stdout}${editResult.stderr}`).toContain("Stop the proxy before you add a relay access key");
    expect(`${editResult.stdout}${editResult.stderr}`).not.toMatch(/frogp_[A-Za-z0-9_-]{43}/);
    expect(existsSync(join(home, "config.json"))).toBe(false);
  }, 10_000);

  test("overlapping adds of the same label create one key and reject the loser before printing a secret", async () => {
    const home = makeHome("frogp-local-key-duplicate-");
    const gate = join(home, "release-config-lock");

    const first = runCli(home, ["local-key", "add", "shared"], {
      FROGP_TEST_CONFIG_LOCK_GATE: gate,
    });
    await waitForFile(`${gate}.${first.child.pid}.ready`);
    const second = runCli(home, ["local-key", "add", "shared"], {
      FROGP_TEST_CONFIG_LOCK_GATE: gate,
    });
    await waitForSpawn(second.child);
    writeFileSync(gate, "release", "utf8");

    const results = await Promise.all([first.result, second.result]);
    expect(results.map(result => result.code).sort()).toEqual([0, 1]);
    const rejected = results.find(result => result.code !== 0)!;
    expect(`${rejected.stdout}${rejected.stderr}`).toContain("already exists");
    expect(`${rejected.stdout}${rejected.stderr}`).not.toMatch(/frogp_[A-Za-z0-9_-]{43}/);
    const config = JSON.parse(readFileSync(join(home, "config.json"), "utf8"));
    expect(config.localAccess.keys).toHaveLength(1);
    expect(config.localAccess.keys[0].label).toBe("shared");
  }, 20_000);

  test("remove refuses an ambiguous legacy label without changing config", async () => {
    const home = makeHome("frogp-local-key-ambiguous-remove-");
    const configPath = join(home, "config.json");
    const before = JSON.stringify({
      localAccess: {
        enabled: true,
        keys: [
          { id: "lk_first", label: "shared", secretHash: `sha256:${"a".repeat(64)}` },
          { id: "lk_second", label: "shared", secretHash: `sha256:${"b".repeat(64)}` },
        ],
      },
    }, null, 2) + "\n";
    writeFileSync(configPath, before, "utf8");

    const { result } = runCli(home, ["local-key", "remove", "shared"]);
    const removeResult = await result;

    expect(removeResult.code).not.toBe(0);
    expect(`${removeResult.stdout}${removeResult.stderr}`).toContain("matches multiple relay access keys");
    expect(`${removeResult.stdout}${removeResult.stderr}`).toContain("Remove one by id");
    expect(readFileSync(configPath, "utf8")).toBe(before);
  }, 10_000);

  test("a failed durable save never prints the generated plaintext key", async () => {
    const home = makeHome("frogp-local-key-save-failure-");
    const configPath = join(home, "config.json");
    // A directory at config.json lets loadConfig fall back, but atomic rename cannot publish over it.
    mkdirSync(configPath);

    const { result } = runCli(home, ["local-key", "add", "not-saved"]);
    const editResult = await result;

    expect(editResult.code).not.toBe(0);
    expect(`${editResult.stdout}${editResult.stderr}`).not.toMatch(/frogp_[A-Za-z0-9_-]{43}/);
  }, 10_000);
});

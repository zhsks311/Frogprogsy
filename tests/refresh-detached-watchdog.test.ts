import { describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, watch, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { terminateStaleProxyForRefresh } from "../src/refresh-process";
const cliSource = () => readFileSync(join(import.meta.dir, "..", "src", "cli.ts"), "utf8");

function waitForPath(path: string): Promise<void> {
  if (existsSync(path)) return Promise.resolve();
  const { promise, resolve, reject } = Promise.withResolvers<void>();
  const watcher = watch(dirname(path), () => {
    if (!existsSync(path)) return;
    watcher.close();
    resolve();
  });
  watcher.once("error", error => {
    watcher.close();
    reject(error);
  });
  if (existsSync(path)) {
    watcher.close();
    resolve();
  }
  return promise;
}

describe("frogp refresh detached lifecycle", () => {
  test("refresh termination restores watchdog ownership on failure and accepts an already-dead process", () => {
    const failedEvents: string[] = [];
    const failed = terminateStaleProxyForRefresh(101, {
      writeShutdownIntent: pid => failedEvents.push(`intent:${pid}`),
      terminate: () => {
        failedEvents.push("terminate");
        throw new Error("permission denied");
      },
      isAlive: () => true,
      clearShutdownIntent: () => {
        failedEvents.push("clear-intent");
      },
    });
    expect(failed).toMatchObject({ ok: false, error: new Error("permission denied") });
    expect(failedEvents).toEqual(["intent:101", "terminate", "clear-intent"]);

    let clearedAfterDeath = false;
    const alreadyDead = terminateStaleProxyForRefresh(102, {
      writeShutdownIntent: () => undefined,
      terminate: () => {
        throw new Error("process disappeared during termination");
      },
      isAlive: () => false,
      clearShutdownIntent: () => {
        clearedAfterDeath = true;
      },
    });
    expect(alreadyDead).toEqual({ ok: true });
    expect(clearedAfterDeath).toBe(false);
  });

  test("refresh serializes delayed stale shutdown against a concurrent start", async () => {
    const root = mkdtempSync(join(tmpdir(), "frogp-refresh-stale-build-"));
    const frogHome = join(root, "frog-home");
    const claudeHome = join(root, "claude-home");
    const shutdownReady = join(root, "shutdown-ready");
    const shutdownRelease = join(root, "shutdown-release");
    const fixturePath = join(root, "stale-server.ts");
    const cliPath = join(import.meta.dir, "..", "src", "cli.ts");
    mkdirSync(frogHome, { recursive: true });
    mkdirSync(claudeHome, { recursive: true });
    writeFileSync(fixturePath, [
      'import { existsSync, unlinkSync, watch, writeFileSync } from "node:fs";',
      'import { dirname, join } from "node:path";',
      "const [frogHome, shutdownReady, shutdownRelease] = process.argv.slice(2);",
      "const server = Bun.serve({",
      '  hostname: "127.0.0.1",',
      "  port: 0,",
      "  fetch(request) {",
      "    const url = new URL(request.url);",
      '    if (url.pathname === "/healthz") {',
      '      return Response.json({ status: "ok", serverBuildId: "frogprogsy-server@0.0.0-stale" });',
      "    }",
      '    return new Response("not found", { status: 404 });',
      "  },",
      "});",
      "console.log(server.port);",
      'process.on("SIGTERM", async () => {',
      '  try { unlinkSync(join(frogHome!, "frogp.pid")); } catch {}',
      '  try { unlinkSync(join(frogHome!, "frogp.port")); } catch {}',
      '  writeFileSync(shutdownReady!, "ready");',
      "  if (!existsSync(shutdownRelease!)) {",
      "    const { promise, resolve } = Promise.withResolvers<void>();",
      "    const watcher = watch(dirname(shutdownRelease!), () => {",
      "      if (!existsSync(shutdownRelease!)) return;",
      "      watcher.close();",
      "      resolve();",
      "    });",
      "    if (existsSync(shutdownRelease!)) { watcher.close(); resolve(); }",
      "    await promise;",
      "  }",
      "  server.stop(true);",
      "  process.exit(0);",
      "});",
      "await Promise.withResolvers<void>().promise;",
    ].join("\n"));

    const stale = Bun.spawn([process.execPath, fixturePath, frogHome, shutdownReady, shutdownRelease], {
      stdout: "pipe",
      stderr: "ignore",
    });
    const env = {
      ...process.env,
      FROGPROGSY_HOME: frogHome,
      CLAUDE_HOME: claudeHome,
      CLAUDE_CONFIG_DIR: claudeHome,
      FROGPROGSY_NO_CLAUDE_WRITES: "1",
    };
    let concurrent: { pid: number; exited: Promise<number>; kill: () => void } | undefined;

    try {
      const staleOutput = stale.stdout.getReader();
      const announced = await staleOutput.read();
      staleOutput.releaseLock();
      const port = Number(new TextDecoder().decode(announced.value).trim());
      expect(announced.done).toBe(false);
      expect(Number.isInteger(port) && port > 0).toBe(true);
      writeFileSync(join(frogHome, "config.json"), JSON.stringify({
        port,
        hostname: "127.0.0.1",
        watchdog: { enabled: false },
        providers: {},
      }, null, 2) + "\n");
      writeFileSync(join(frogHome, "frogp.pid"), String(stale.pid));
      writeFileSync(join(frogHome, "frogp.port"), String(port));

      const refresh = Bun.spawn([process.execPath, cliPath, "refresh"], {
        cwd: join(import.meta.dir, ".."),
        env,
        stdout: "pipe",
        stderr: "pipe",
      });
      await waitForPath(shutdownReady);
      concurrent = Bun.spawn([process.execPath, cliPath, "start"], {
        cwd: join(import.meta.dir, ".."),
        env,
        stdout: "ignore",
        stderr: "ignore",
      });
      writeFileSync(shutdownRelease, "release");
      const [stdout, stderr, exitCode] = await Promise.all([
        new Response(refresh.stdout).text(),
        new Response(refresh.stderr).text(),
        refresh.exited,
      ]);

      expect(exitCode).toBe(0);
      expect(stderr).toBe("");
      expect(stdout).toContain(`Proxy running on port ${port}`);
      expect(await stale.exited).toBe(0);
      const replacementPid = Number(readFileSync(join(frogHome, "frogp.pid"), "utf8"));
      expect(replacementPid).not.toBe(stale.pid);
      if (replacementPid !== concurrent.pid) expect(await concurrent.exited).toBe(1);
      const health = await fetch(`http://127.0.0.1:${port}/healthz`).then(response => response.json()) as {
        serverBuildId?: string;
      };
      const version = JSON.parse(readFileSync(join(import.meta.dir, "..", "package.json"), "utf8")).version;
      expect(health.serverBuildId).toBe(`frogprogsy-server@${version}`);
    } finally {
      writeFileSync(shutdownRelease, "release");
      const stop = Bun.spawn([process.execPath, cliPath, "stop"], {
        cwd: join(import.meta.dir, ".."),
        env,
        stdout: "ignore",
        stderr: "ignore",
      });
      await stop.exited;
      stale.kill();
      await stale.exited;
      concurrent?.kill();
      if (concurrent) await concurrent.exited;
      rmSync(root, { recursive: true, force: true });
    }
  }, 20_000);

  test("refresh does not mark its background proxy as externally service-managed", () => {
    const source = cliSource();
    const refreshStart = source.indexOf("async function handleRefresh()");
    expect(refreshStart).toBeGreaterThanOrEqual(0);
    const refreshSource = source.slice(refreshStart, source.indexOf("function killProxy", refreshStart));

    expect(refreshSource).toContain('FROGP_DETACHED: "1"');
    expect(refreshSource).toContain("FROGP_EXTERNAL_SUPERVISOR: undefined");
    expect(refreshSource).not.toContain('FROGP_EXTERNAL_SUPERVISOR: "1"');
  });

  test("detached proxies keep Claude settings injected without suppressing watchdog", () => {
    const source = cliSource();

    expect(source).toContain("!parseEnvFlag(process.env.FROGP_EXTERNAL_SUPERVISOR) && !process.env.FROGP_DETACHED");
    expect(source).toContain("resolveWatchdogEnabled(_startConfig, process.env");
  });

  test("watchdog seeds last-known pid from the supervised parent", () => {
    const watchdogSource = readFileSync(join(import.meta.dir, "..", "src", "watchdog.ts"), "utf8");

    expect(watchdogSource).toContain("let lastKnownManagedPid: number | null = opts.parentPidHint ?? null");
  });
});

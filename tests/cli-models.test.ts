import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { catalogDataDigest } from "../src/model-catalog-generator";

const repoRoot = dirname(fileURLToPath(new URL("../package.json", import.meta.url)));
const cliPath = join(repoRoot, "src", "cli.ts");

const ANSI_PATTERN = /\x1b\[[0-9;]*m/;

const STUB_MODELS = [
  { id: "gpt-5.5", provider: "codex", namespaced: "codex/gpt-5.5", disabled: false, contextWindow: 400000, inputModalities: ["text", "image"], reasoningEfforts: ["low", "medium", "high"], supportStatus: "validated", catalogSource: "remote", catalogRevision: 42, catalogSourceCommit: "1234567890abcdef1234567890abcdef12345678", catalogRefreshedAt: "2026-08-12T10:30:00.000Z" },
  { id: "gpt-5.4-mini", provider: "codex", namespaced: "codex/gpt-5.4-mini", disabled: true, supportStatus: "discovered", catalogSource: "remote", catalogRevision: 42, catalogSourceCommit: "1234567890abcdef1234567890abcdef12345678", catalogRefreshedAt: "2026-08-12T10:30:00.000Z" },
  { id: "claude-sonnet-4-6", provider: "anthropic", namespaced: "anthropic/claude-sonnet-4-6", disabled: false, supportStatus: "unknown", catalogSource: "remote", catalogRevision: 42, catalogSourceCommit: "1234567890abcdef1234567890abcdef12345678", catalogRefreshedAt: "2026-08-12T10:30:00.000Z" },
];

function runCli(argv: string[], frogHome: string, extraEnv: Record<string, string> = {}) {
  const claudeHome = join(frogHome, "claude");
  mkdirSync(claudeHome, { recursive: true });
  return spawnSync(process.execPath, [cliPath, ...argv], {
    cwd: repoRoot,
    env: { ...process.env, FROGPROGSY_HOME: frogHome, CLAUDE_HOME: claudeHome, ...extraEnv },
    encoding: "utf8",
    timeout: 15_000,
  });
}

/** Async spawn so an in-process Bun.serve stub stays responsive while the CLI runs. */
async function runCliAsync(argv: string[], frogHome: string, extraEnv: Record<string, string> = {}) {
  const claudeHome = join(frogHome, "claude");
  mkdirSync(claudeHome, { recursive: true });
  const proc = Bun.spawn([process.execPath, cliPath, ...argv], {
    cwd: repoRoot,
    env: { ...process.env, FROGPROGSY_HOME: frogHome, CLAUDE_HOME: claudeHome, ...extraEnv },
    stdout: "pipe",
    stderr: "pipe",
  });
  const timer = setTimeout(() => proc.kill(), 15_000);
  const [stdout, stderr, status] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  clearTimeout(timer);
  return { stdout, stderr, status };
}

/** Simulate a running proxy: live PID (this test process) + active-port record. */
function writeRunningState(frogHome: string, port: number) {
  writeFileSync(join(frogHome, "frogp.pid"), String(process.pid), "utf8");
  writeFileSync(join(frogHome, "frogp.port"), String(port), "utf8");
}

function startStubProxy(options: { statusAvailable?: boolean } = {}) {
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch(req) {
      const url = new URL(req.url);
      if (url.pathname === "/healthz") return new Response("ok", { status: 200 });
      if (url.pathname === "/api/models") return Response.json(STUB_MODELS);
      if (url.pathname === "/api/model-catalog/status") {
        if (options.statusAvailable === false) return new Response("unavailable", { status: 503 });
        return Response.json({
          source: "remote",
          catalogRevision: 42,
          catalogDigest: "a".repeat(64),
          sourceCommit: "1234567890abcdef1234567890abcdef12345678",
          generatedAt: "2026-08-12T10:00:00.000Z",
          refreshedAt: "2026-08-12T10:30:00.000Z",
          skippedRecords: 0,
          warnings: { count: 0, causes: [] },
        });
      }
      return new Response("not found", { status: 404 });
    },
  });
  return { server, port: server.port };
}

describe("frogp models", () => {
  test("fails with frogp start guidance when no proxy is recorded", () => {
    const home = mkdtempSync(join(tmpdir(), "frogp-models-"));
    try {
      const result = runCli(["models"], home);
      expect(result.status).toBe(1);
      expect(result.stderr).toContain("Proxy not running. Start it with: frogp start");
      expect(result.stdout).toBe("");
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  test("fails with recovery guidance when the recorded proxy does not answer health checks", () => {
    const home = mkdtempSync(join(tmpdir(), "frogp-models-"));
    try {
      // Live PID but nothing listening on the recorded port → health check must fail.
      writeRunningState(home, 1); // port 1 is never listening for us
      const result = runCli(["models"], home);
      expect(result.status).toBe(1);
      expect(result.stderr).toContain("not answering on port 1");
      expect(result.stderr).toContain("frogp refresh");
      // Never synthesize an offline model list.
      expect(result.stdout).not.toContain("gpt-");
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  test("groups models by provider for human output", async () => {
    const home = mkdtempSync(join(tmpdir(), "frogp-models-"));
    const { server, port } = startStubProxy();
    try {
      writeRunningState(home, port);
      const result = await runCliAsync(["models"], home);
      expect(result.status).toBe(0);
      expect(result.stdout).toContain("codex (2)");
      expect(result.stdout).toContain("anthropic (1)");
      expect(result.stdout).toContain("gpt-5.5");
      expect(result.stdout).toContain("disabled");
      expect(result.stdout).toContain("claude-sonnet-4-6");
      expect(result.stdout).toContain("모델 자료: 원격");
      expect(result.stdout).toContain("revision 42");
      expect(result.stdout).toContain("12345678");
      expect(result.stdout).toContain("검증됨");
      expect(result.stdout).toContain("발견됨");
      expect(result.stdout).toContain("확인 필요");
    } finally {
      server.stop(true);
      rmSync(home, { recursive: true, force: true });
    }
  });

  test("models --json prints the /api/models array unchanged with no ANSI even under FORCE_COLOR", async () => {
    const home = mkdtempSync(join(tmpdir(), "frogp-models-"));
    const { server, port } = startStubProxy();
    try {
      writeRunningState(home, port);
      const result = await runCliAsync(["models", "--json"], home, { FORCE_COLOR: "1" });
      expect(result.status).toBe(0);
      expect(result.stderr).toBe("");
      expect(result.stdout).not.toMatch(ANSI_PATTERN);
      expect(JSON.parse(result.stdout)).toEqual(STUB_MODELS);
    } finally {
      server.stop(true);
      rmSync(home, { recursive: true, force: true });
    }
  });

  test("keeps the successful model list when the catalog status endpoint is temporarily unavailable", async () => {
    const home = mkdtempSync(join(tmpdir(), "frogp-models-"));
    const { server, port } = startStubProxy({ statusAvailable: false });
    try {
      writeRunningState(home, port);
      const result = await runCliAsync(["models"], home);
      expect(result.status).toBe(0);
      expect(result.stdout).toContain("gpt-5.5");
      expect(result.stdout).toContain("모델 자료 상태를 확인하지 못했습니다");
    } finally {
      server.stop(true);
      rmSync(home, { recursive: true, force: true });
    }
  });

  test("rejects unknown options with exit 1", () => {
    const home = mkdtempSync(join(tmpdir(), "frogp-models-"));
    try {
      const result = runCli(["models", "--all"], home);
      expect(result.status).toBe(1);
      expect(result.stderr).toContain("Unknown models option: --all");
      expect(result.stderr).toContain("Usage: frogp models [--json]");
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  test("refresh CLI seams keep selected-catalog retired live rows out of Claude publications", async () => {
    const home = mkdtempSync(join(tmpdir(), "frogp-cli-retired-"));
    const claudeHome = join(home, "claude");
    const provider = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch(req) {
        const path = new URL(req.url).pathname;
        if (path === "/healthz") return new Response("ok");
        if (path.endsWith("/models")) {
          return Response.json({ data: [{ id: "claude-old" }, { id: "claude-new" }] });
        }
        return new Response("not found", { status: 404 });
      },
    });
    try {
      mkdirSync(join(home, "cache"), { recursive: true });
      mkdirSync(claudeHome, { recursive: true });
      const providers = [{
        id: "anthropic",
        models: [{ id: "claude-new" }],
        retiredModels: ["claude-old"],
      }];
      writeFileSync(join(home, "cache", "model-catalog-v1.json"), JSON.stringify({
        schemaVersion: 1,
        catalogRevision: 999_999,
        catalogDigest: catalogDataDigest({ providers }),
        sourceCommit: "c".repeat(40),
        generatedAt: "2026-08-14T00:00:00.000Z",
        minFrogprogsyVersion: "0.0.0",
        providers,
      }));
      writeFileSync(join(home, "config.json"), JSON.stringify({
        port: provider.port,
        hostname: "127.0.0.1",
        modelCatalogConfigVersion: 1,
        defaultProvider: "work",
        providers: {
          work: {
            adapter: "openai-chat",
            baseUrl: `http://127.0.0.1:${provider.port}/v1`,
            apiKey: "test-key",
            catalogProviderId: "anthropic",
            liveModels: true,
          },
        },
        claudeProfiles: {
          schemaVersion: 1,
          defaultProfileId: "cp_default",
          profiles: [{
            id: "cp_default",
            name: "Default",
            claudeHome,
            authState: "not_seen",
          }],
        },
      }));
      writeFileSync(join(claudeHome, "frogprogsy-catalog.json"), JSON.stringify({
        models: [{
          slug: "gpt-5.5",
          display_name: "gpt-5.5",
          priority: 1,
          base_instructions: "Native model fixture",
        }],
      }));

      for (const argv of [
        ["refresh"],
        ["claude", "refresh", "cp_default"],
        ["claude", "reload-models", "cp_default"],
      ]) {
        const result = await runCliAsync(argv, home);
        expect(result.status).toBe(0);

        const catalog = JSON.parse(readFileSync(
          join(claudeHome, "frogprogsy-catalog.json"),
          "utf8",
        )) as { models: Array<{ slug: string }> };
        const gateway = JSON.parse(readFileSync(
          join(claudeHome, "cache", "gateway-models.json"),
          "utf8",
        )) as { models: Array<{ display_name: string }> };
        expect(catalog.models.map(model => model.slug)).toContain("work/claude-new");
        expect(catalog.models.map(model => model.slug)).not.toContain("work/claude-old");
        expect(gateway.models.map(model => model.display_name)).toContain("work/claude-new");
        expect(gateway.models.map(model => model.display_name)).not.toContain("work/claude-old");
      }
    } finally {
      provider.stop(true);
      rmSync(home, { recursive: true, force: true });
    }
  }, 30_000);

  test.each([
    ["claude refresh", ["claude", "refresh", "cp_default"]],
    ["claude reload-models", ["claude", "reload-models", "cp_default"]],
  ])("%s preserves migration and injected profile metadata together", async (_name, argv) => {
    const home = mkdtempSync(join(tmpdir(), "frogp-cli-migration-"));
    const claudeHome = join(home, "claude");
    try {
      mkdirSync(claudeHome, { recursive: true });
      writeFileSync(join(home, "config.json"), JSON.stringify({
        port: 9,
        defaultProvider: "ollama",
        providers: {
          ollama: {
            adapter: "openai-chat",
            baseUrl: "http://localhost:11434/v1/",
            models: ["local-user-model"],
          },
        },
        claudeProfiles: {
          schemaVersion: 1,
          defaultProfileId: "cp_default",
          profiles: [{
            id: "cp_default",
            name: "Default",
            claudeHome,
            authState: "not_seen",
          }],
        },
      }));
      writeFileSync(join(claudeHome, "frogprogsy-catalog.json"), JSON.stringify({
        models: [{
          slug: "gpt-5.5",
          display_name: "gpt-5.5",
          priority: 1,
          base_instructions: "Native model fixture",
        }],
      }));

      const result = await runCliAsync(argv, home);
      expect(result.status).toBe(0);
      const persisted = JSON.parse(readFileSync(join(home, "config.json"), "utf8")) as {
        modelCatalogConfigVersion?: number;
        providers: Record<string, {
          catalogProviderId?: string;
          models?: string[];
          userModels?: string[];
        }>;
        claudeProfiles: {
          profiles: Array<{ id: string; injected?: boolean; lastInjectedAt?: string }>;
        };
      };
      const profile = persisted.claudeProfiles.profiles.find(item => item.id === "cp_default");

      expect(persisted.modelCatalogConfigVersion).toBe(1);
      expect(persisted.providers.ollama).toMatchObject({
        catalogProviderId: "ollama",
        userModels: ["local-user-model"],
      });
      expect(persisted.providers.ollama.models).toBeUndefined();
      expect(profile).toMatchObject({ injected: true });
      expect(profile?.lastInjectedAt).toBeString();
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  }, 30_000);
});

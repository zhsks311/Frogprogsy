import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { materializeModelAliases } from "../src/model-aliases";
import type { SelectedModelCatalog } from "../src/model-catalog-runtime";
import { createRuntimeConfigState } from "../src/runtime-config-state";
import { startServer } from "../src/server";
import type { FrogConfig, ModelContinuityAutomatic } from "../src/types";

const repoRoot = dirname(fileURLToPath(new URL("../package.json", import.meta.url)));
const cliPath = join(repoRoot, "src", "cli.ts");
const originalHome = process.env.FROGPROGSY_HOME;
const originalClaudeHome = process.env.CLAUDE_HOME;
const tempDirs: string[] = [];
const activeServers = new Set<{ stop(closeActiveConnections?: boolean): void }>();

interface ContinuityReport {
  policies: Record<string, { fallbacks: string[]; automatic: ModelContinuityAutomatic }>;
  references: Array<{
    id: string;
    primary: string;
    status: "ready" | "retired" | "authentication_required" | "policy_invalid";
    supportStatus: "validated" | "discovered" | "unknown";
    policy: { fallbacks: string[]; automatic: ModelContinuityAutomatic };
  }>;
  circuits: Array<{ primary: string; reason: string; retryAt: number }>;
}
interface LiveProxy {
  url: URL;
  port: number;
}

function trackServer<T extends { stop(closeActiveConnections?: boolean): void }>(server: T): T {
  activeServers.add(server);
  return server;
}

function tempHome(): string {
  const home = mkdtempSync(join(tmpdir(), "frogprogsy-continuity-e2e-"));
  tempDirs.push(home);
  return home;
}

function catalog(): SelectedModelCatalog {
  return {
    document: {
      schemaVersion: 1,
      catalogRevision: 1,
      catalogDigest: "a".repeat(64),
      sourceCommit: "b".repeat(40),
      generatedAt: "2026-08-14T00:00:00.000Z",
      minFrogprogsyVersion: "0.0.1",
      providers: [
        {
          id: "primary-catalog",
          retiredModels: ["old"],
          models: [{ id: "current" }],
        },
        {
          id: "fallback-catalog",
          models: [{ id: "new" }],
        },
      ],
    },
    status: {
      source: "bundled",
      catalogRevision: 1,
      catalogDigest: "a".repeat(64),
      sourceCommit: "b".repeat(40),
      generatedAt: "2026-08-14T00:00:00.000Z",
      skippedRecords: 0,
      warnings: [],
    },
  };
}

function config(primaryUrl: string, fallbackUrl: string): FrogConfig {
  return {
    port: 0,
    hostname: "127.0.0.1",
    modelCatalogConfigVersion: 1,
    defaultProvider: "primary",
    providers: {
      primary: {
        adapter: "anthropic",
        baseUrl: primaryUrl,
        authMode: "key",
        apiKey: "continuity-e2e-primary-key",
        catalogProviderId: "primary-catalog",
        defaultModel: "old",
        models: ["old", "current"],
        liveModels: false,
      },
      fallback: {
        adapter: "anthropic",
        baseUrl: fallbackUrl,
        authMode: "key",
        apiKey: "continuity-e2e-fallback-key",
        catalogProviderId: "fallback-catalog",
        defaultModel: "new",
        models: ["new"],
        liveModels: false,
      },
    },
    longContext: { thresholdTokens: 100_000, provider: "primary", model: "old" },
    subagentModels: [],
  };
}

function anthropicMessage(model: string, text: string): Response {
  return Response.json({
    id: "msg_continuity_e2e",
    type: "message",
    role: "assistant",
    model,
    content: [{ type: "text", text }],
    usage: { input_tokens: 3, output_tokens: 2 },
  });
}

async function api<T>(
  proxy: LiveProxy,
  method: "GET" | "POST",
  body?: Record<string, unknown>,
): Promise<T> {
  const response = await fetch(new URL("/api/model-continuity", proxy.url), {
    method,
    headers: method === "POST"
      ? { Origin: new URL(proxy.url).origin, "content-type": "application/json" }
      : undefined,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  expect(response.status).toBe(200);
  return response.json() as Promise<T>;
}

async function messages(
  proxy: LiveProxy,
  model: string,
): Promise<{ status: number; body: Record<string, unknown> }> {
  const response = await fetch(new URL("/v1/messages", proxy.url), {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      model,
      max_tokens: 16,
      messages: [{ role: "user", content: "continuity e2e" }],
    }),
  });
  return { status: response.status, body: await response.json() as Record<string, unknown> };
}

async function runContinuityCli(home: string) {
  const proc = Bun.spawn([process.execPath, cliPath, "models", "continuity", "--json"], {
    cwd: repoRoot,
    env: {
      ...process.env,
      FROGPROGSY_HOME: home,
      CLAUDE_HOME: join(home, "claude"),
      NO_COLOR: "1",
    },
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr, status] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  return { stdout, stderr, status };
}

function persistedConfig(home: string): FrogConfig {
  return JSON.parse(readFileSync(join(home, "config.json"), "utf8")) as FrogConfig;
}

afterEach(() => {
  for (const server of activeServers) server.stop(true);
  activeServers.clear();
  if (originalHome === undefined) delete process.env.FROGPROGSY_HOME;
  else process.env.FROGPROGSY_HOME = originalHome;
  if (originalClaudeHome === undefined) delete process.env.CLAUDE_HOME;
  else process.env.CLAUDE_HOME = originalClaudeHome;
  for (const path of tempDirs.splice(0)) rmSync(path, { recursive: true, force: true });
});

describe("model continuity end to end", () => {
  test("retired and transient model continuity works through API, CLI, and data plane", async () => {
    const home = tempHome();
    process.env.FROGPROGSY_HOME = home;
    process.env.CLAUDE_HOME = join(home, "claude");
    mkdirSync(process.env.CLAUDE_HOME, { recursive: true });

    type PrimaryMode = "success" | "unavailable" | "unauthorized";
    let primaryMode: PrimaryMode = "success";
    const calls: Array<{ upstream: "primary" | "fallback"; model: unknown; apiKey: string | null }> = [];
    const primary = trackServer(Bun.serve({
      port: 0,
      hostname: "127.0.0.1",
      fetch: async request => {
        const body = await request.json() as Record<string, unknown>;
        calls.push({
          upstream: "primary",
          model: body.model,
          apiKey: request.headers.get("x-api-key"),
        });
        if (primaryMode === "unavailable") {
          return Response.json({ error: { type: "server_error", message: "temporarily unavailable" } }, { status: 503 });
        }
        if (primaryMode === "unauthorized") {
          return Response.json({ error: { type: "authentication_error", message: "invalid key" } }, { status: 401 });
        }
        return anthropicMessage(String(body.model), "primary ok");
      },
    }));
    const fallback = trackServer(Bun.serve({
      port: 0,
      hostname: "127.0.0.1",
      fetch: async request => {
        const body = await request.json() as Record<string, unknown>;
        calls.push({
          upstream: "fallback",
          model: body.model,
          apiKey: request.headers.get("x-api-key"),
        });
        return anthropicMessage(String(body.model), "fallback ok");
      },
    }));

    const initialConfig = config(primary.url.origin, fallback.url.origin);
    writeFileSync(join(home, "config.json"), `${JSON.stringify(initialConfig, null, 2)}\n`, { mode: 0o600 });
    const [oldAlias] = materializeModelAliases([
      { provider: "primary", model: "old" },
      { provider: "primary", model: "current" },
    ], { prune: true });
    if (!oldAlias) throw new Error("failed to create the retired gateway alias fixture");

    let now = 1_000;
    const proxy = trackServer(await startServer(0, {
      createRuntimeConfigState: () => createRuntimeConfigState({ refreshCatalog: async () => catalog() }),
      now: () => now,
    }));
    writeFileSync(join(home, "frogp.pid"), String(process.pid), "utf8");
    writeFileSync(join(home, "frogp.port"), String(proxy.port), "utf8");

    const initialBytes = readFileSync(join(home, "config.json"), "utf8");
    const inventory = await api<ContinuityReport>(proxy, "GET");
    expect(inventory.references).toContainEqual(expect.objectContaining({
      id: "provider-default:primary",
      primary: "primary/old",
      status: "retired",
    }));
    expect(readFileSync(join(home, "config.json"), "utf8")).toBe(initialBytes);

    await api<ContinuityReport>(proxy, "POST", {
      action: "set",
      primary: "primary/old",
      fallbacks: ["fallback/new"],
      automatic: "retired",
    });
    const afterRetiredSet = readFileSync(join(home, "config.json"), "utf8");
    expect(afterRetiredSet).not.toBe(initialBytes);
    expect(persistedConfig(home).modelContinuity?.["primary/old"]).toEqual({
      fallbacks: ["fallback/new"],
      automatic: "retired",
    });

    const retiredResponse = await messages(proxy, oldAlias.alias);
    expect(retiredResponse).toMatchObject({ status: 200, body: { model: oldAlias.alias } });
    expect(calls).toEqual([{
      upstream: "fallback",
      model: "new",
      apiKey: "continuity-e2e-fallback-key",
    }]);
    expect(readFileSync(join(home, "config.json"), "utf8")).toBe(afterRetiredSet);
    expect(persistedConfig(home).providers.primary?.defaultModel).toBe("old");

    await api<ContinuityReport>(proxy, "POST", {
      action: "set",
      primary: "primary/current",
      fallbacks: ["fallback/new"],
      automatic: "transient",
    });
    const afterTransientSet = readFileSync(join(home, "config.json"), "utf8");
    expect(afterTransientSet).not.toBe(afterRetiredSet);
    expect(persistedConfig(home).modelContinuity?.["primary/current"]).toEqual({
      fallbacks: ["fallback/new"],
      automatic: "transient",
    });

    primaryMode = "unavailable";
    now = 1_000;
    expect((await messages(proxy, "primary/current")).status).toBe(200);
    const openCircuitReport = await api<ContinuityReport>(proxy, "GET");
    expect(openCircuitReport.circuits).toEqual([
      { primary: "primary/current", reason: "http_5xx", retryAt: 31_000 },
    ]);
    now = 2_000;
    expect((await messages(proxy, "primary/current")).status).toBe(200);
    primaryMode = "success";
    now = 31_001;
    expect((await messages(proxy, "primary/current")).status).toBe(200);
    primaryMode = "unauthorized";
    now = 32_000;
    expect((await messages(proxy, "primary/current")).status).toBe(401);

    expect(calls).toEqual([
      { upstream: "fallback", model: "new", apiKey: "continuity-e2e-fallback-key" },
      { upstream: "primary", model: "current", apiKey: "continuity-e2e-primary-key" },
      { upstream: "fallback", model: "new", apiKey: "continuity-e2e-fallback-key" },
      { upstream: "fallback", model: "new", apiKey: "continuity-e2e-fallback-key" },
      { upstream: "primary", model: "current", apiKey: "continuity-e2e-primary-key" },
      { upstream: "primary", model: "current", apiKey: "continuity-e2e-primary-key" },
    ]);
    expect(readFileSync(join(home, "config.json"), "utf8")).toBe(afterTransientSet);
    expect(persistedConfig(home)).toMatchObject({
      providers: { primary: { defaultModel: "old" } },
      longContext: { provider: "primary", model: "old" },
    });

    const apiReport = await api<ContinuityReport>(proxy, "GET");
    const cli = await runContinuityCli(home);
    expect(cli).toMatchObject({ status: 0, stderr: "" });
    const cliReport = JSON.parse(cli.stdout) as ContinuityReport;
    expect(cliReport).toEqual(apiReport);
    for (const reference of apiReport.references) {
      expect(["ready", "retired", "authentication_required", "policy_invalid"]).toContain(reference.status);
      expect(["validated", "discovered", "unknown"]).toContain(reference.supportStatus);
      expect(["off", "retired", "transient", "all"]).toContain(reference.policy.automatic);
    }
    for (const policy of Object.values(apiReport.policies)) {
      expect(["off", "retired", "transient", "all"]).toContain(policy.automatic);
    }
    expect(readFileSync(join(home, "config.json"), "utf8")).toBe(afterTransientSet);

    await api<ContinuityReport>(proxy, "POST", {
      action: "replace",
      referenceId: "long-context",
      expectedPrimary: "primary/old",
      replacement: "fallback/new",
    });
    const afterReplace = readFileSync(join(home, "config.json"), "utf8");
    expect(afterReplace).not.toBe(afterTransientSet);
    expect(persistedConfig(home)).toMatchObject({
      providers: { primary: { defaultModel: "old" } },
      longContext: { provider: "fallback", model: "new" },
    });
  }, 30_000);
});

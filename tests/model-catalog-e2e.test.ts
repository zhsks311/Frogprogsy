import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { catalogDataDigest } from "../src/model-catalog-generator";
import { refreshModelCatalog } from "../src/model-catalog-runtime";
import {
  modelCatalogDocumentV1Schema,
  type ModelCatalogDocumentV1,
} from "../src/model-catalog-schema";
import { createRuntimeConfigState } from "../src/runtime-config-state";
import { startServer } from "../src/server";
import type { FrogConfig } from "../src/types";

const repoRoot = dirname(fileURLToPath(new URL("../package.json", import.meta.url)));
const cliPath = join(repoRoot, "src", "cli.ts");
const originalHome = process.env.FROGPROGSY_HOME;
const tempDirs: string[] = [];
const activeServers = new Set<{ stop(closeActiveConnections?: boolean): void }>();

function trackServer<T extends { stop(closeActiveConnections?: boolean): void }>(server: T): T {
  activeServers.add(server);
  return server;
}

function stopServer(server: { stop(closeActiveConnections?: boolean): void }): void {
  server.stop(true);
  activeServers.delete(server);
}

const bundled = modelCatalogDocumentV1Schema.parse(JSON.parse(readFileSync(
  new URL("../src/generated/model-catalog-v1.json", import.meta.url),
  "utf8",
)));
const bundledAnthropic = bundled.providers.find(provider => provider.id === "anthropic");
if (!bundledAnthropic?.models[0]) throw new Error("bundled anthropic catalog fixture is empty");
const bundledModelId = bundledAnthropic.models[0].id;

function tempHome(): string {
  const home = mkdtempSync(join(tmpdir(), "frogprogsy-catalog-e2e-"));
  tempDirs.push(home);
  return home;
}

function catalogWithModel(revision: number, modelId: string, generatedAt = new Date(Date.now() - 60_000).toISOString()): ModelCatalogDocumentV1 {
  const providers = structuredClone(bundled.providers);
  const anthropic = providers.find(provider => provider.id === "anthropic");
  if (!anthropic) throw new Error("bundled anthropic provider is missing");
  anthropic.models.push({ id: modelId, contextWindow: 123_456, inputModalities: ["text"] });
  return {
    schemaVersion: 1,
    catalogRevision: revision,
    catalogDigest: catalogDataDigest({ providers }),
    sourceCommit: revision.toString(16).padStart(40, "0"),
    generatedAt,
    minFrogprogsyVersion: bundled.minFrogprogsyVersion,
    providers,
  };
}

function configFor(upstreamBaseUrl: string): FrogConfig {
  return {
    port: 0,
    hostname: "127.0.0.1",
    modelCatalogConfigVersion: 1,
    defaultProvider: "anthropic",
    providers: {
      anthropic: {
        adapter: "anthropic",
        baseUrl: upstreamBaseUrl,
        authMode: "key",
        apiKey: "catalog-e2e-key",
        catalogProviderId: "anthropic",
        liveModels: true,
        defaultModel: bundledModelId,
        userModels: ["user-kept-model"],
      },
    },
    subagentModels: [],
  };
}

function writeConfig(home: string, config: FrogConfig): string {
  const bytes = `${JSON.stringify(config, null, 2)}\n`;
  writeFileSync(join(home, "config.json"), bytes, { mode: 0o600 });
  return bytes;
}

async function startProxy(home: string, catalogUrl: string) {
  process.env.FROGPROGSY_HOME = home;
  const server = await startServer(0, {
    createRuntimeConfigState: () => createRuntimeConfigState({
      refreshCatalog: () => refreshModelCatalog({ remoteUrl: catalogUrl }),
    }),
  });
  writeFileSync(join(home, "frogp.pid"), String(process.pid), "utf8");
  writeFileSync(join(home, "frogp.port"), String(server.port), "utf8");
  return trackServer(server);
}

async function apiJson<T>(server: Awaited<ReturnType<typeof startProxy>>, path: string): Promise<T> {
  const response = await fetch(new URL(path, server.url));
  expect(response.status).toBe(200);
  return response.json() as Promise<T>;
}

async function runModelsCli(home: string, json: boolean) {
  mkdirSync(join(home, "claude"), { recursive: true });
  const proc = Bun.spawn([process.execPath, cliPath, "models", ...(json ? ["--json"] : [])], {
    cwd: repoRoot,
    env: { ...process.env, FROGPROGSY_HOME: home, CLAUDE_HOME: join(home, "claude"), NO_COLOR: "1" },
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

function modelIds(rows: Array<{ id?: unknown }>): string[] {
  return rows.flatMap(row => typeof row.id === "string" ? [row.id] : []);
}

function claudeDisplayNames(payload: { data?: Array<{ display_name?: unknown }> }): string[] {
  return (payload.data ?? []).flatMap(row => typeof row.display_name === "string" ? [row.display_name] : []);
}

afterEach(() => {
  for (const server of activeServers) server.stop(true);
  activeServers.clear();
  if (originalHome === undefined) delete process.env.FROGPROGSY_HOME;
  else process.env.FROGPROGSY_HOME = originalHome;
  for (const path of tempDirs.splice(0)) rmSync(path, { recursive: true, force: true });
});

describe("remote model catalog end to end", () => {
  test("activates remote data only on restart, then uses cache and bundled fallback across public model surfaces", async () => {
    const remoteV1Id = "catalog-e2e-remote-v1";
    const remoteV2Id = "catalog-e2e-remote-v2";
    const remoteV1 = catalogWithModel(bundled.catalogRevision + 1, remoteV1Id);
    const remoteV2 = catalogWithModel(bundled.catalogRevision + 2, remoteV2Id);
    let catalogBody: unknown = remoteV1;
    let catalogRequests = 0;
    const catalogServer = trackServer(Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch(req) {
        const path = new URL(req.url).pathname;
        if (path === "/catalog.json") {
          catalogRequests += 1;
          return Response.json(catalogBody);
        }
        if (path === "/v1/models") return Response.json({ data: [], has_more: false });
        return new Response("not found", { status: 404 });
      },
    }));
    const home = tempHome();
    const configBytes = writeConfig(home, configFor(catalogServer.url.toString().replace(/\/$/, "")));
    const catalogUrl = new URL("/catalog.json", catalogServer.url).toString();

    let proxy = await startProxy(home, catalogUrl);
    try {
      const apiModels = await apiJson<Array<{ id: string; supportStatus: string; catalogSource: string }>>(proxy, "/api/models");
      const status = await apiJson<{ source: string; catalogRevision: number }>(proxy, "/api/model-catalog/status");
      const claudeModels = await apiJson<{ data: Array<{ display_name: string }> }>(proxy, "/v1/models");
      const cliJson = await runModelsCli(home, true);
      const cliHuman = await runModelsCli(home, false);

      expect(status).toMatchObject({ source: "remote", catalogRevision: remoteV1.catalogRevision });
      expect(apiModels).toContainEqual(expect.objectContaining({ id: remoteV1Id, supportStatus: "validated", catalogSource: "remote" }));
      expect(JSON.parse(cliJson.stdout)).toEqual(apiModels);
      expect(cliJson).toMatchObject({ status: 0, stderr: "" });
      expect(cliHuman.status).toBe(0);
      expect(cliHuman.stdout).toContain("모델 자료: 원격");
      expect(cliHuman.stdout).toContain("검증됨");
      expect(claudeDisplayNames(claudeModels)).toContain(`anthropic/${remoteV1Id}`);
      expect(readFileSync(join(home, "config.json"), "utf8")).toBe(configBytes);
      expect(catalogRequests).toBe(1);

      catalogBody = remoteV2;
      const whileRunning = await apiJson<Array<{ id: string }>>(proxy, "/api/models");
      expect(modelIds(whileRunning)).toContain(remoteV1Id);
      expect(modelIds(whileRunning)).not.toContain(remoteV2Id);
      expect(catalogRequests).toBe(1);
    } finally {
      stopServer(proxy);
    }

    proxy = await startProxy(home, catalogUrl);
    try {
      const restartedModels = await apiJson<Array<{ id: string }>>(proxy, "/api/models");
      const restartedStatus = await apiJson<{ source: string }>(proxy, "/api/model-catalog/status");
      expect(restartedStatus.source).toBe("remote");
      expect(modelIds(restartedModels)).toContain(remoteV2Id);
      expect(modelIds(restartedModels)).not.toContain(remoteV1Id);
      expect(readFileSync(join(home, "config.json"), "utf8")).toBe(configBytes);
      expect(catalogRequests).toBe(2);
    } finally {
      stopServer(proxy);
      stopServer(catalogServer);
    }

    proxy = await startProxy(home, catalogUrl);
    try {
      const cachedModels = await apiJson<Array<{ id: string; catalogSource: string }>>(proxy, "/api/models");
      const cachedStatus = await apiJson<{ source: string }>(proxy, "/api/model-catalog/status");
      expect(cachedStatus.source).toBe("cached");
      expect(cachedModels).toContainEqual(expect.objectContaining({ id: remoteV2Id, catalogSource: "cached" }));
      expect(readFileSync(join(home, "config.json"), "utf8")).toBe(configBytes);
    } finally {
      stopServer(proxy);
    }

    const freshHome = tempHome();
    const freshConfigBytes = writeConfig(freshHome, configFor(catalogServer.url.toString().replace(/\/$/, "")));
    proxy = await startProxy(freshHome, catalogUrl);
    try {
      const fallbackModels = await apiJson<Array<{ id: string; catalogSource: string }>>(proxy, "/api/models");
      const fallbackStatus = await apiJson<{ source: string }>(proxy, "/api/model-catalog/status");
      expect(fallbackStatus.source).toBe("bundled");
      expect(fallbackModels).toContainEqual(expect.objectContaining({ id: bundledModelId, catalogSource: "bundled" }));
      expect(modelIds(fallbackModels)).not.toContain(remoteV2Id);
      expect(readFileSync(join(freshHome, "config.json"), "utf8")).toBe(freshConfigBytes);
    } finally {
      stopServer(proxy);
    }
  }, 30_000);

  test("invalid, future-dated, and timed-out responses start with bundled data without changing config", async () => {
    const remoteId = "catalog-e2e-rejected";
    const valid = catalogWithModel(bundled.catalogRevision + 10, remoteId);
    let catalogBody: unknown = valid;
    let delayCatalog = false;
    const catalogServer = trackServer(Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      async fetch(req) {
        const path = new URL(req.url).pathname;
        if (path === "/catalog.json") {
          if (delayCatalog) await Bun.sleep(2_500);
          if (typeof catalogBody === "string") return new Response(catalogBody, { headers: { "content-type": "application/json" } });
          return Response.json(catalogBody);
        }
        if (path === "/v1/models") return Response.json({ data: [], has_more: false });
        return new Response("not found", { status: 404 });
      },
    }));
    const catalogUrl = new URL("/catalog.json", catalogServer.url).toString();
    const cases = [
      { name: "invalid JSON", body: "{not-json", delay: false },
      { name: "future generatedAt", body: catalogWithModel(bundled.catalogRevision + 11, remoteId, new Date(Date.now() + 60_000).toISOString()), delay: false },
      { name: "timeout", body: valid, delay: true },
    ];

    try {
      for (const scenario of cases) {
        const home = tempHome();
        const configBytes = writeConfig(home, configFor(catalogServer.url.toString().replace(/\/$/, "")));
        catalogBody = scenario.body;
        delayCatalog = scenario.delay;
        const proxy = await startProxy(home, catalogUrl);
        try {
          const status = await apiJson<{ source: string; warnings: { count: number } }>(proxy, "/api/model-catalog/status");
          const models = await apiJson<Array<{ id: string }>>(proxy, "/api/models");
          expect(status.source, scenario.name).toBe("bundled");
          expect(status.warnings.count, scenario.name).toBeGreaterThan(0);
          expect(modelIds(models), scenario.name).not.toContain(remoteId);
          expect(readFileSync(join(home, "config.json"), "utf8"), scenario.name).toBe(configBytes);
        } finally {
          stopServer(proxy);
        }
      }
    } finally {
      stopServer(catalogServer);
    }
  }, 15_000);
});

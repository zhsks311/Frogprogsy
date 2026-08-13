import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createRuntimeConfigState } from "../src/runtime-config-state";
import { refreshModelCatalog, type SelectedModelCatalog } from "../src/model-catalog-runtime";
import type { ModelCatalogDocumentV1 } from "../src/model-catalog-schema";
import { startServer } from "../src/server";
import type { FrogConfig } from "../src/types";

const HASH = "a".repeat(64);
const COMMIT = "b".repeat(40);

function catalog(models = ["catalog-model"]): ModelCatalogDocumentV1 {
  return {
    schemaVersion: 1,
    catalogRevision: 1,
    catalogDigest: HASH,
    sourceCommit: COMMIT,
    generatedAt: "2026-08-12T00:00:00Z",
    minFrogprogsyVersion: "0.0.0",
    providers: [{
      id: "managed",
      defaultModel: models[0],
      models: models.map(id => ({ id, contextWindow: 123_456 })),
    }],
  };
}

function selected(document = catalog(), source: SelectedModelCatalog["status"]["source"] = "bundled"): SelectedModelCatalog {
  return {
    document,
    status: {
      source,
      catalogRevision: document.catalogRevision,
      catalogDigest: document.catalogDigest,
      sourceCommit: document.sourceCommit,
      generatedAt: document.generatedAt,
      skippedRecords: 0,
      warnings: [],
    },
  };
}

function persistedConfig(): FrogConfig {
  return {
    port: 0,
    hostname: "127.0.0.1",
    modelCatalogConfigVersion: 1,
    defaultProvider: "gateway",
    providers: {
      gateway: {
        adapter: "openai-responses",
        baseUrl: "https://example.invalid/v1",
        catalogProviderId: "managed",
        liveModels: true,
      },
    },
    subagentModels: [],
  };
}

function fakeServe(onServe: () => void): typeof Bun.serve {
  return ((_: unknown) => {
    onServe();
    return {
      stop() {},
      url: new URL("http://127.0.0.1:3764"),
    };
  }) as unknown as typeof Bun.serve;
}

describe("server startup runtime config", () => {
  test("does not open the listener until the catalog selection resolves", async () => {
    const catalogGate = Promise.withResolvers<SelectedModelCatalog>();
    let serveCalls = 0;
    const start = startServer(0, {
      createRuntimeConfigState: () => createRuntimeConfigState({
        loadConfig: persistedConfig,
        configExists: () => false,
        refreshCatalog: () => catalogGate.promise,
      }),
      serve: fakeServe(() => { serveCalls += 1; }),
    });

    await Promise.resolve();
    expect(serveCalls).toBe(0);

    catalogGate.resolve(selected());
    await start;
    expect(serveCalls).toBe(1);
  });

  test("opens with the bundled catalog after the remote refresh timeout", async () => {
    const bundled = catalog(["bundled-model"]);
    const cachePath = join(tmpdir(), `frogprogsy-startup-${crypto.randomUUID()}.json`);
    let stateSource: SelectedModelCatalog["status"]["source"] | undefined;
    let serveCalls = 0;

    await startServer(0, {
      createRuntimeConfigState: async () => {
        const state = await createRuntimeConfigState({
          loadConfig: persistedConfig,
          configExists: () => false,
          refreshCatalog: () => refreshModelCatalog({
            bundled,
            cachePath,
            runtimeVersion: "1.0.0",
            fetch: (_input, init) => {
              const request = Promise.withResolvers<Response>();
              init?.signal?.addEventListener("abort", () => request.reject(init.signal?.reason), { once: true });
              return request.promise;
            },
          }),
        });
        stateSource = state.catalog.status.source;
        return state;
      },
      serve: fakeServe(() => { serveCalls += 1; }),
    });

    expect(stateSource).toBe("bundled");
    expect(serveCalls).toBe(1);
  }, 4_000);

  test("post-start sync에 selected catalog가 반영된 effective config를 전달한다", async () => {
    let handedOff: FrogConfig | undefined;

    await startServer(0, {
      createRuntimeConfigState: () => createRuntimeConfigState({
        loadConfig: persistedConfig,
        configExists: () => false,
        refreshCatalog: async () => selected(catalog(["remote-only-model"]), "remote"),
      }),
      serve: fakeServe(() => {}),
      onRuntimeConfigReady: config => { handedOff = config; },
    });

    expect(handedOff?.providers.gateway.models).toEqual(["remote-only-model"]);
    expect(handedOff?.providers.gateway.catalogProviderId).toBe("managed");
  });

  test("persist saves only persisted values and rebuilds effective from the startup catalog snapshot", async () => {
    const saved: FrogConfig[] = [];
    let refreshCalls = 0;
    const state = await createRuntimeConfigState({
      loadConfig: persistedConfig,
      configExists: () => false,
      saveConfig: value => { saved.push(structuredClone(value)); },
      refreshCatalog: async () => {
        refreshCalls += 1;
        return selected(catalog(["catalog-model"]));
      },
    });

    state.persisted.providers.gateway.userModels = ["private-model"];
    state.persist();

    expect(saved).toHaveLength(1);
    expect(saved[0].providers.gateway.models).toBeUndefined();
    expect(saved[0].providers.gateway.userModels).toEqual(["private-model"]);
    expect(state.effective.providers.gateway.models).toEqual(["catalog-model", "private-model"]);
    expect(refreshCalls).toBe(1);
  });
});

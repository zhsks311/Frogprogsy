import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { getModelCatalogCachePath } from "../src/config";
import { catalogDataDigest } from "../src/model-catalog-generator";
import {
  MODEL_CATALOG_REMOTE_URL,
  refreshModelCatalog,
  validateCatalogCandidate,
  type ModelCatalogFileHandle,
  type ModelCatalogRuntimeDeps,
} from "../src/model-catalog-runtime";
import {
  modelCatalogDocumentV1Schema,
  type ModelCatalogDocumentV1,
  type ModelCatalogProviderV1,
} from "../src/model-catalog-schema";

const NOW = new Date("2026-08-13T12:00:00.000Z");
const sourceCommit = "a".repeat(40);
const tempDirs: string[] = [];
const originalHome = process.env.FROGPROGSY_HOME;

const bundled = modelCatalogDocumentV1Schema.parse(JSON.parse(readFileSync(
  new URL("../src/generated/model-catalog-v1.json", import.meta.url),
  "utf8",
)));

function makeTempDir(): string {
  const path = mkdtempSync(join(tmpdir(), "frogprogsy-model-catalog-"));
  tempDirs.push(path);
  return path;
}

function makeDocument(input: {
  revision?: number;
  generatedAt?: string;
  minFrogprogsyVersion?: string;
  providers?: ModelCatalogProviderV1[];
  source?: string;
} = {}): ModelCatalogDocumentV1 {
  const providers = structuredClone(input.providers ?? bundled.providers);
  return {
    schemaVersion: 1,
    catalogRevision: input.revision ?? bundled.catalogRevision + 1,
    catalogDigest: catalogDataDigest({ providers }),
    sourceCommit: input.source ?? sourceCommit,
    generatedAt: input.generatedAt ?? "2026-08-13T11:00:00.000Z",
    minFrogprogsyVersion: input.minFrogprogsyVersion ?? "0.0.1",
    providers,
  };
}

function jsonResponse(value: unknown, init: ResponseInit = {}): Response {
  const headers = new Headers(init.headers);
  if (!headers.has("content-type")) headers.set("content-type", "application/json; charset=utf-8");
  return new Response(JSON.stringify(value), { ...init, headers });
}

function runtimeDeps(input: {
  cacheDocument?: ModelCatalogDocumentV1;
  fetchImpl?: ModelCatalogRuntimeDeps["fetch"];
  cachePath?: string;
  fileSystem?: ModelCatalogRuntimeDeps["fileSystem"];
  runtimeVersion?: string;
} = {}): ModelCatalogRuntimeDeps & { cachePath: string } {
  const cachePath = input.cachePath ?? join(makeTempDir(), "cache", "model-catalog-v1.json");
  if (input.cacheDocument) {
    mkdirSync(dirname(cachePath), { recursive: true });
    writeFileSync(cachePath, `${JSON.stringify(input.cacheDocument)}\n`, { mode: 0o600 });
  }
  return {
    bundled,
    cachePath,
    runtimeVersion: input.runtimeVersion ?? "1.0.0",
    now: () => new Date(NOW),
    fetch: input.fetchImpl ?? (async () => {
      throw new Error("network unavailable");
    }),
    fileSystem: input.fileSystem,
  };
}

afterEach(() => {
  if (originalHome === undefined) delete process.env.FROGPROGSY_HOME;
  else process.env.FROGPROGSY_HOME = originalHome;
  for (const path of tempDirs.splice(0)) rmSync(path, { recursive: true, force: true });
});

describe("model catalog candidate validation", () => {
  test("strict validation rejects an unknown compatible provider field and keeps the bundled provider", () => {
    const raw = makeDocument();
    const baselineProvider = raw.providers.find(provider => provider.models.length > 0)!;
    (baselineProvider as ModelCatalogProviderV1 & { baseUrl: string }).baseUrl = "https://forbidden.invalid";
    raw.catalogDigest = catalogDataDigest({ providers: raw.providers });

    const result = validateCatalogCandidate(raw, bundled, "1.0.0", NOW);

    expect(result.ok).toBeTrue();
    if (!result.ok) return;
    expect(result.document.providers.find(provider => provider.id === baselineProvider.id))
      .toEqual(bundled.providers.find(provider => provider.id === baselineProvider.id));
    expect(result.skippedRecords).toBe(1);
  });

  test("a too-new model keeps the matching bundled model", () => {
    const baselineProvider = bundled.providers.find(provider => provider.models.length > 0)!;
    const baselineModel = baselineProvider.models[0]!;
    const remoteProvider = structuredClone(baselineProvider);
    remoteProvider.models = remoteProvider.models.map(model => model.id === baselineModel.id
      ? { ...model, minFrogprogsyVersion: "2.0.0", contextWindow: 1, futureField: true } as typeof model
      : model);
    const raw = makeDocument({ providers: [remoteProvider] });

    const result = validateCatalogCandidate(raw, bundled, "1.0.0", NOW);

    expect(result.ok).toBeTrue();
    if (!result.ok) return;
    expect(result.document.providers.find(provider => provider.id === baselineProvider.id)!
      .models.find(model => model.id === baselineModel.id)).toEqual(baselineModel);
    expect(result.skippedRecords).toBe(1);
  });

  test("an unknown or too-new provider is skipped without installing transport data", () => {
    const rawProviders = [
      ...structuredClone(bundled.providers),
      {
        id: "future-provider",
        minFrogprogsyVersion: "2.0.0",
        baseUrl: "https://forbidden.invalid",
        models: [],
      },
    ];
    const raw = makeDocument({ providers: rawProviders as ModelCatalogProviderV1[] });

    const result = validateCatalogCandidate(raw, bundled, "1.0.0", NOW);

    expect(result.ok).toBeTrue();
    if (!result.ok) return;
    expect(result.document.providers.some(provider => provider.id === "future-provider")).toBeFalse();
    expect(result.skippedRecords).toBe(1);
  });

  test("a provider invalid after filtering keeps its bundled provider", () => {
    const baselineProvider = bundled.providers[0]!;
    const rawProvider = {
      ...structuredClone(baselineProvider),
      defaultModel: "future-only",
      models: [
        ...structuredClone(baselineProvider.models),
        { id: "future-only", minFrogprogsyVersion: "2.0.0", unknownFutureRule: true },
      ],
    } as ModelCatalogProviderV1;
    const raw = makeDocument({ providers: [rawProvider] });

    const result = validateCatalogCandidate(raw, bundled, "1.0.0", NOW);

    expect(result.ok).toBeTrue();
    if (!result.ok) return;
    expect(result.document.providers[0]).toEqual(baselineProvider);
    expect(result.skippedRecords).toBe(2);
  });

  test("only a compatible strict retired list removes a bundled model", () => {
    const baselineProvider = bundled.providers.find(provider => provider.models.length >= 2)!;
    const retiredId = baselineProvider.models[0]!.id;
    const remoteProvider: ModelCatalogProviderV1 = {
      ...structuredClone(baselineProvider),
      defaultModel: baselineProvider.models[1]!.id,
      retiredModels: [retiredId],
      models: structuredClone(baselineProvider.models.slice(1)),
    };
    const raw = makeDocument({ providers: [remoteProvider] });

    const result = validateCatalogCandidate(raw, bundled, "1.0.0", NOW);

    expect(result.ok).toBeTrue();
    if (!result.ok) return;
    const selectedProvider = result.document.providers.find(provider => provider.id === baselineProvider.id)!;
    expect(selectedProvider.models.some(model => model.id === retiredId)).toBeFalse();
    expect(selectedProvider.retiredModels).toContain(retiredId);
  });

  test("compatible unmanaged list removes bundled validation without retiring the model", () => {
    const baselineProvider = bundled.providers.find(provider => provider.models.length >= 2)!;
    const unmanagedId = baselineProvider.models[0]!.id;
    const remoteProvider: ModelCatalogProviderV1 = {
      ...structuredClone(baselineProvider),
      minFrogprogsyVersion: "0.0.5",
      defaultModel: baselineProvider.models[1]!.id,
      unmanagedModels: [unmanagedId],
      models: structuredClone(baselineProvider.models.slice(1)),
    };
    const raw = makeDocument({ providers: [remoteProvider] });

    const supported = validateCatalogCandidate(raw, bundled, "0.0.5", NOW);
    expect(supported.ok).toBeTrue();
    if (!supported.ok) return;
    const selectedProvider = supported.document.providers.find(provider => provider.id === baselineProvider.id)!;
    expect(selectedProvider.models.some(model => model.id === unmanagedId)).toBeFalse();
    expect(selectedProvider.unmanagedModels).toContain(unmanagedId);
    expect(selectedProvider.retiredModels ?? []).not.toContain(unmanagedId);

    const oldReader = validateCatalogCandidate(raw, bundled, "0.0.4", NOW);
    expect(oldReader.ok).toBeTrue();
    if (!oldReader.ok) return;
    expect(oldReader.document.providers.find(provider => provider.id === baselineProvider.id))
      .toEqual(baselineProvider);
  });

  test("rejects a digest mismatch, a too-new envelope, and a future generation time", () => {
    const digestMismatch = { ...makeDocument(), catalogDigest: "f".repeat(64) };
    const tooNew = makeDocument({ minFrogprogsyVersion: "2.0.0" });
    const future = makeDocument({ generatedAt: "2030-01-01T00:00:00.000Z" });

    expect(validateCatalogCandidate(digestMismatch, bundled, "1.0.0", NOW).ok).toBeFalse();
    expect(validateCatalogCandidate(tooNew, bundled, "1.0.0", NOW).ok).toBeFalse();
    expect(validateCatalogCandidate(future, bundled, "1.0.0", NOW).ok).toBeFalse();
  });
  test("a compatible model wins when a too-new model has the same ID", () => {
    const baselineProvider = bundled.providers.find(provider => provider.models.length > 0)!;
    const baselineModel = baselineProvider.models[0]!;
    const compatibleContextWindow = (baselineModel.contextWindow ?? 1) + 1;
    const rawProvider = structuredClone(baselineProvider);
    rawProvider.models = [
      {
        ...structuredClone(baselineModel),
        minFrogprogsyVersion: "2.0.0",
        futureField: true,
      } as typeof baselineModel,
      {
        ...structuredClone(baselineModel),
        contextWindow: compatibleContextWindow,
      },
      ...rawProvider.models.slice(1),
    ];
    const raw = makeDocument({ providers: [rawProvider] });

    const result = validateCatalogCandidate(raw, bundled, "1.0.0", NOW);

    expect(result.ok).toBeTrue();
    if (!result.ok) return;
    const selectedModel = result.document.providers
      .find(provider => provider.id === baselineProvider.id)!
      .models.find(model => model.id === baselineModel.id)!;
    expect(selectedModel.contextWindow).toBe(compatibleContextWindow);
    expect(result.skippedRecords).toBe(1);
  });

  test("a compatible provider wins when a too-new provider has the same ID", () => {
    const baselineProvider = bundled.providers.find(provider => provider.models.length > 0)!;
    const compatibleProvider = structuredClone(baselineProvider);
    compatibleProvider.escapeBuiltinToolNames = !baselineProvider.escapeBuiltinToolNames;
    const tooNewProvider = {
      ...structuredClone(baselineProvider),
      minFrogprogsyVersion: "2.0.0",
      futureField: true,
    } as ModelCatalogProviderV1;
    const raw = makeDocument({ providers: [tooNewProvider, compatibleProvider] });

    const result = validateCatalogCandidate(raw, bundled, "1.0.0", NOW);

    expect(result.ok).toBeTrue();
    if (!result.ok) return;
    expect(result.document.providers.find(provider => provider.id === baselineProvider.id)!
      .escapeBuiltinToolNames).toBe(compatibleProvider.escapeBuiltinToolNames);
    expect(result.skippedRecords).toBe(1);
  });

  test("duplicate unknown providers are filtered without invalidating compatible providers", () => {
    const baselineProvider = bundled.providers.find(provider => provider.models.length > 0)!;
    const compatibleProvider = structuredClone(baselineProvider);
    compatibleProvider.escapeBuiltinToolNames = !baselineProvider.escapeBuiltinToolNames;
    const unknownProvider = { id: "unknown-provider", models: [] };
    const raw = makeDocument({
      providers: [unknownProvider, structuredClone(unknownProvider), compatibleProvider],
    });

    const result = validateCatalogCandidate(raw, bundled, "1.0.0", NOW);

    expect(result.ok).toBeTrue();
    if (!result.ok) return;
    expect(result.document.providers.find(provider => provider.id === baselineProvider.id)!
      .escapeBuiltinToolNames).toBe(compatibleProvider.escapeBuiltinToolNames);
    expect(result.skippedRecords).toBe(2);
  });

  test("rejects a generation time one millisecond in the future", () => {
    const future = makeDocument({ generatedAt: new Date(NOW.getTime() + 1).toISOString() });

    expect(validateCatalogCandidate(future, bundled, "1.0.0", NOW).ok).toBeFalse();
  });
});

  test("rejects a parseable date that is not an ISO offset datetime", () => {
    const invalid = makeDocument({ generatedAt: "2026-08-13" });

    expect(validateCatalogCandidate(invalid, bundled, "1.0.0", NOW).ok).toBeFalse();
  });

  test("duplicate compatible model IDs invalidate that provider and keep its bundle", () => {
    const baselineProvider = bundled.providers.find(provider => provider.models.length > 0)!;
    const rawProvider = structuredClone(baselineProvider);
    rawProvider.models.push(structuredClone(rawProvider.models[0]!));
    const raw = makeDocument({ providers: [rawProvider] });

    const result = validateCatalogCandidate(raw, bundled, "1.0.0", NOW);

    expect(result.ok).toBeTrue();
    if (!result.ok) return;
    expect(result.document.providers.find(provider => provider.id === baselineProvider.id))
      .toEqual(baselineProvider);
    expect(result.skippedRecords).toBe(1);
  });

describe("model catalog runtime version detection", () => {
  test("rejects an unknown runtime version before reading cache or fetching remote", async () => {
    let cacheReads = 0;
    let fetchCalls = 0;
    const deps = runtimeDeps({
      runtimeVersion: "?",
      fileSystem: {
        readFile: async () => {
          cacheReads++;
          return JSON.stringify(makeDocument());
        },
      },
      fetchImpl: async () => {
        fetchCalls++;
        return jsonResponse(makeDocument());
      },
    });

    await expect(refreshModelCatalog(deps)).rejects.toThrow(
      'Frogprogsy runtime version detection failed: expected valid SemVer, received "?".',
    );
    expect(cacheReads).toBe(0);
    expect(fetchCalls).toBe(0);
  });
});

describe("model catalog refresh fallback", () => {
  const failures = [
    ["timeout", async (_input: string | URL | Request, init?: RequestInit) => {
      expect(init?.signal).toBeInstanceOf(AbortSignal);
      throw new DOMException("timed out", "TimeoutError");
    }],
    ["network", async () => { throw new Error("network"); }],
    ["http", async () => new Response("down", { status: 503 })],
    ["content-type", async () => new Response("{}", { headers: { "content-type": "text/plain" } })],
    ["oversize", async () => new Response("{}", { headers: {
      "content-type": "application/json",
      "content-length": String(2 * 1024 * 1024 + 1),
    } })],
    ["malformed", async () => new Response("{", { headers: { "content-type": "application/json" } })],
    ["schema", async () => jsonResponse({ schemaVersion: 2 })],
    ["future-time", async () => jsonResponse(makeDocument({ generatedAt: "2030-01-01T00:00:00.000Z" }))],
  ] as const;

  for (const [failure, fetchImpl] of failures) {
    test(`${failure} keeps valid cache`, async () => {
      const cached = makeDocument({ revision: bundled.catalogRevision + 1, source: "b".repeat(40) });
      const result = await refreshModelCatalog(runtimeDeps({ cacheDocument: cached, fetchImpl }));

      expect(result.status.source).toBe("cached");
      expect(result.status.catalogRevision).toBe(cached.catalogRevision);
      expect(result.status.refreshedAt).toBeUndefined();
      expect(result.status.warnings).not.toBeEmpty();
    });
  }

  test("a response stream read failure keeps the valid cache", async () => {
    const cached = makeDocument({ revision: bundled.catalogRevision + 1 });
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.error(new Error("stream read failed"));
      },
    });

    const result = await refreshModelCatalog(runtimeDeps({
      cacheDocument: cached,
      fetchImpl: async () => new Response(body, { headers: { "content-type": "application/json" } }),
    }));

    expect(result.status.source).toBe("cached");
    expect(result.status.warnings).not.toBeEmpty();
  });

  test("a response stream cancel failure keeps the valid cache", async () => {
    const cached = makeDocument({ revision: bundled.catalogRevision + 1 });
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        controller.enqueue(new Uint8Array(2 * 1024 * 1024 + 1));
      },
      cancel() {
        throw new Error("stream cancel failed");
      },
    });

    const result = await refreshModelCatalog(runtimeDeps({
      cacheDocument: cached,
      fetchImpl: async () => new Response(body, { headers: { "content-type": "application/json" } }),
    }));

    expect(result.status.source).toBe("cached");
    expect(result.status.warnings).not.toBeEmpty();
  });

  test("a decoded body over 2 MiB keeps the valid cache", async () => {
    const cached = makeDocument({ revision: bundled.catalogRevision + 1 });
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new Uint8Array(1024 * 1024));
        controller.enqueue(new Uint8Array(1024 * 1024 + 1));
        controller.close();
      },
    });
    const result = await refreshModelCatalog(runtimeDeps({
      cacheDocument: cached,
      fetchImpl: async () => new Response(body, { headers: { "content-type": "application/json" } }),
    }));

    expect(result.status.source).toBe("cached");
    expect(result.status.warnings).not.toBeEmpty();
  });

  test("provider and model count limits keep the valid cache", async () => {
    const cached = makeDocument({ revision: bundled.catalogRevision + 1 });
    const tooManyProviders = makeDocument({ providers: Array.from({ length: 257 }, (_, index) => ({
      id: `provider-${index}`,
      models: [],
    })) });
    const first = await refreshModelCatalog(runtimeDeps({
      cacheDocument: cached,
      fetchImpl: async () => jsonResponse(tooManyProviders),
    }));

    const tooManyModels = makeDocument({ providers: [{
      id: bundled.providers[0]!.id,
      models: Array.from({ length: 20_001 }, (_, index) => ({ id: `model-${index}` })),
    }] });
    const second = await refreshModelCatalog(runtimeDeps({
      cacheDocument: cached,
      fetchImpl: async () => jsonResponse(tooManyModels),
    }));

    expect(first.status.source).toBe("cached");
    expect(second.status.source).toBe("cached");
  });

  test("without a valid cache a remote failure selects bundled", async () => {
    const result = await refreshModelCatalog(runtimeDeps());

    expect(result.status.source).toBe("bundled");
    expect(result.document).toEqual(bundled);
  });

  test("warnings do not expose the absolute cache path", async () => {
    const cachePath = join(makeTempDir(), "private-secret", "model-catalog-v1.json");
    const result = await refreshModelCatalog(runtimeDeps({ cachePath }));

    expect(result.status.warnings.join(" ")).not.toContain(dirname(cachePath));
  });
});

describe("model catalog revision and cache trust", () => {
  test("a higher remote revision becomes active and atomically replaces cache", async () => {
    const cached = makeDocument({ revision: bundled.catalogRevision + 1, source: "b".repeat(40) });
    const remote = makeDocument({ revision: cached.catalogRevision + 1, source: "c".repeat(40) });
    let requestedUrl = "";
    const deps = runtimeDeps({
      cacheDocument: cached,
      fetchImpl: async input => {
        requestedUrl = String(input);
        return jsonResponse(remote);
      },
    });

    const result = await refreshModelCatalog(deps);

    expect(requestedUrl).toBe(MODEL_CATALOG_REMOTE_URL);
    expect(result.status.source).toBe("remote");
    expect(result.status.catalogRevision).toBe(remote.catalogRevision);
    expect(result.status.refreshedAt).toBe(NOW.toISOString());
    expect(JSON.parse(readFileSync(deps.cachePath, "utf8"))).toEqual(remote);
    if (process.platform !== "win32") expect(statSync(deps.cachePath).mode & 0o777).toBe(0o600);
  });

  test("a lower remote revision keeps the higher cached candidate and bytes", async () => {
    const cached = makeDocument({ revision: bundled.catalogRevision + 2, source: "b".repeat(40) });
    const remote = makeDocument({ revision: cached.catalogRevision - 1, source: "c".repeat(40) });
    const deps = runtimeDeps({ cacheDocument: cached, fetchImpl: async () => jsonResponse(remote) });
    const before = readFileSync(deps.cachePath, "utf8");

    const result = await refreshModelCatalog(deps);

    expect(result.status.source).toBe("cached");
    expect(readFileSync(deps.cachePath, "utf8")).toBe(before);
    expect(result.status.refreshedAt).toBeUndefined();
  });

  test("equal revision with a different digest rejects the fetched candidate", async () => {
    const cached = makeDocument({ revision: bundled.catalogRevision + 1, source: "b".repeat(40) });
    const changedProviders = structuredClone(cached.providers);
    changedProviders.find(provider => provider.models.length > 0)!.models[0]!.contextWindow = 7;
    const remote = makeDocument({
      revision: cached.catalogRevision,
      providers: changedProviders,
      source: "c".repeat(40),
    });
    const deps = runtimeDeps({ cacheDocument: cached, fetchImpl: async () => jsonResponse(remote) });
    const before = readFileSync(deps.cachePath, "utf8");

    const result = await refreshModelCatalog(deps);

    expect(result.status.source).toBe("cached");
    expect(result.status.catalogDigest).toBe(cached.catalogDigest);
    expect(readFileSync(deps.cachePath, "utf8")).toBe(before);
  });

  test("equal revision and digest may refresh cache metadata without replacing active selection", async () => {
    const cached = makeDocument({ revision: bundled.catalogRevision + 1, source: "b".repeat(40) });
    const remote = { ...cached, sourceCommit: "c".repeat(40), generatedAt: "2026-08-13T11:30:00.000Z" };
    const deps = runtimeDeps({ cacheDocument: cached, fetchImpl: async () => jsonResponse(remote) });

    const result = await refreshModelCatalog(deps);

    expect(result.status.source).toBe("cached");
    expect(result.status.sourceCommit).toBe(cached.sourceCommit);
    expect(result.status.refreshedAt).toBe(NOW.toISOString());
    expect(JSON.parse(readFileSync(deps.cachePath, "utf8"))).toEqual(remote);
  });

  test("the bundled candidate wins an equal-revision digest conflict with cache", async () => {
    const changedProviders = structuredClone(bundled.providers);
    changedProviders.find(provider => provider.models.length > 0)!.models[0]!.contextWindow = 9;
    const conflictingCache = makeDocument({ revision: bundled.catalogRevision, providers: changedProviders });

    const result = await refreshModelCatalog(runtimeDeps({ cacheDocument: conflictingCache }));

    expect(result.status.source).toBe("bundled");
    expect(result.status.catalogDigest).toBe(bundled.catalogDigest);
  });

  test("flushes a mode-0600 temp file and parent directory around rename", async () => {
    const remote = makeDocument();
    const events: string[] = [];
    const handle: ModelCatalogFileHandle = {
      writeFile: async () => { events.push("write"); },
      sync: async () => { events.push("sync"); },
      close: async () => { events.push("close"); },
    };
    const deps = runtimeDeps({
      fetchImpl: async () => jsonResponse(remote),
      fileSystem: {
        mkdir: async () => { events.push("mkdir"); },
        open: async (_path, flags, mode) => {
          events.push(`open:${flags}:${mode?.toString(8)}`);
          return handle;
        },
        rename: async () => { events.push("rename"); },
        unlink: async () => { events.push("unlink"); },
      },
    });

    const result = await refreshModelCatalog(deps);

    expect(result.status.source).toBe("remote");
    expect(events).toEqual([
      "mkdir", "open:wx:600", "write", "sync", "close", "rename", "open:r:undefined", "sync", "close",
    ]);
  });

  test("an interrupted rename leaves the existing cache intact", async () => {
    const cached = makeDocument({ revision: bundled.catalogRevision + 1, source: "b".repeat(40) });
    const remote = makeDocument({ revision: cached.catalogRevision + 1, source: "c".repeat(40) });
    const deps = runtimeDeps({
      cacheDocument: cached,
      fetchImpl: async () => jsonResponse(remote),
      fileSystem: { rename: async () => { throw new Error("interrupted rename"); } },
    });
    const before = readFileSync(deps.cachePath, "utf8");

    const result = await refreshModelCatalog(deps);

    expect(result.status.source).toBe("cached");
    expect(readFileSync(deps.cachePath, "utf8")).toBe(before);
    expect(result.status.warnings).not.toBeEmpty();
  });
});

describe("catalog cache location", () => {
  test("stores cache below the config directory without touching config.json", async () => {
    const home = makeTempDir();
    process.env.FROGPROGSY_HOME = home;
    const configPath = join(home, "config.json");
    const configBytes = "{\"userChoice\":true}\n";
    writeFileSync(configPath, configBytes, { mode: 0o600 });
    const remote = makeDocument();

    expect(getModelCatalogCachePath()).toBe(join(home, "cache", "model-catalog-v1.json"));
    await refreshModelCatalog({
      bundled,
      runtimeVersion: "1.0.0",
      now: () => new Date(NOW),
      fetch: async () => jsonResponse(remote),
    });

    expect(readFileSync(configPath, "utf8")).toBe(configBytes);
    expect(JSON.parse(readFileSync(getModelCatalogCachePath(), "utf8"))).toEqual(remote);
  });
});

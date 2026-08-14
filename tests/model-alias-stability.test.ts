import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "bun:test";
import { computeModelAliases, deterministicModelAlias, materializeModelAliases, reconcileRetiredModelAliases, resolveConfiguredModelAlias, resolvePersistedModelAlias, GATEWAY_MODEL_ALIAS_PREFIX, type ModelAliasEntry } from "../src/model-aliases";
import { nativeOpenAiSlugs, syncCatalogModels, type CatalogModel } from "../src/claude-catalog";
import { syncClaudeCodeGatewayModelsCache } from "../src/claude-refresh";
import { routeModel } from "../src/router";
import type { FrogConfig } from "../src/types";
import { AUTO_MODE_CLASSIFIER_ALIAS } from "../src/classifier-settings";

const config: FrogConfig = {
  port: 10100,
  defaultProvider: "provider-a",
  providers: {
    "provider-a": {
      adapter: "openai-chat",
      baseUrl: "https://provider-a.example/v1",
      models: ["Model X/Preview"],
      apiKey: "literal-key",
    },
    "provider-b": {
      adapter: "anthropic",
      baseUrl: "https://provider-b.example",
      defaultModel: "claude-compatible",
    },
  },
};

// --- Behavioral temp-home fixtures for the canonical/subset alias-writer contract ------------------

function makeHomes() {
  const claudeHome = mkdtempSync(join(tmpdir(), "frogp-alias-claude-"));
  const frogHome = mkdtempSync(join(tmpdir(), "frogp-alias-home-"));
  const previousFrogHome = process.env.FROGPROGSY_HOME;
  process.env.FROGPROGSY_HOME = frogHome;
  return {
    claudeHome,
    aliasesPath: join(frogHome, "model-aliases.json"),
    cleanup() {
      if (previousFrogHome === undefined) delete process.env.FROGPROGSY_HOME;
      else process.env.FROGPROGSY_HOME = previousFrogHome;
      rmSync(claudeHome, { recursive: true, force: true });
      rmSync(frogHome, { recursive: true, force: true });
    },
  };
}

function persistedAliases(aliasesPath: string): Record<string, ModelAliasEntry> {
  return (JSON.parse(readFileSync(aliasesPath, "utf8")) as { aliases: Record<string, ModelAliasEntry> }).aliases;
}

function aliasForRouteKey(aliasesPath: string, routeKey: string): string | undefined {
  return Object.values(persistedAliases(aliasesPath)).find(entry => entry.routeKey === routeKey)?.alias;
}

// A native OpenAI slug from the shared always-latest source. No config below lists it in any `models[]`,
// so it only reaches the alias registry via the canonical native-slug write in syncCatalogModels.
const nativeSlug = nativeOpenAiSlugs()[0]!;

// Native-provider + routed-provider config. `openai` is the native OpenAI provider and contributes no
// routed model of its own (models: []); every routed model comes from `kimi`. Native slugs are therefore
// absent from every provider's `models[]`.
const tokenFreeConfig: FrogConfig = {
  port: 10100,
  defaultProvider: "openai",
  providers: {
    openai: {
      adapter: "openai-responses",
      authMode: "key",
      baseUrl: "https://chatgpt.com/backend-api/codex",
      apiKey: "test-key",
      liveModels: false,
      models: [],
    },
    kimi: {
      adapter: "openai-chat",
      authMode: "key",
      baseUrl: "https://api.moonshot.ai/v1",
      apiKey: "test-key",
      liveModels: false,
      models: ["frog-kimi-only"],
    },
  },
};

// Canonical-writer-only config: a native `openai` provider with no routed models at all.
const nativeOnlyConfig: FrogConfig = {
  port: 10100,
  defaultProvider: "openai",
  providers: {
    openai: {
      adapter: "openai-responses",
      authMode: "key",
      baseUrl: "https://chatgpt.com/backend-api/codex",
      apiKey: "test-key",
      liveModels: false,
      models: [],
    },
  },
};

describe("Claude-visible model aliases", () => {
  test("deterministic aliases are hashless, start with claude, and are stable", () => {
    const alias = deterministicModelAlias("provider-a", "Model X/Preview");
    expect(alias).toBe("claude-frogp-provider-a-model-x-preview");

    const reordered = deterministicModelAlias("provider-a", "Model X/Preview");
    expect(reordered).toBe(alias);
  });

  test("the reserved auto-mode classifier alias is never published for a provider model", () => {
    expect(deterministicModelAlias("auto", "classifier")).toBe(AUTO_MODE_CLASSIFIER_ALIAS);
    const aliases = computeModelAliases([{ provider: "auto", model: "classifier" }]);
    expect(aliases.get("auto/classifier")).toMatch(
      /^claude-frogp-auto-classifier-[a-f0-9]{6}$/,
    );
  });

  test("subset materialization migrates a stale persisted reserved alias", () => {
    const homes = makeHomes();
    try {
      writeFileSync(homes.aliasesPath, JSON.stringify({
        schemaVersion: 1,
        aliases: {
          [AUTO_MODE_CLASSIFIER_ALIAS]: {
            alias: AUTO_MODE_CLASSIFIER_ALIAS,
            provider: "auto",
            model: "classifier",
            routeKey: "auto/classifier",
            displayName: "auto/classifier",
            createdAt: new Date(0).toISOString(),
          },
        },
      }));
      const [entry] = materializeModelAliases([{ provider: "auto", model: "classifier" }]);
      expect(entry?.alias).toMatch(/^claude-frogp-auto-classifier-[a-f0-9]{6}$/);
      expect(persistedAliases(homes.aliasesPath)).not.toHaveProperty(AUTO_MODE_CLASSIFIER_ALIAS);
    } finally {
      homes.cleanup();
    }
  });

  test("collision suffix appears only when distinct route keys share a slug base", () => {
    // Both sanitize to the same base: "." and "-" fold to the same slug.
    const colliding = computeModelAliases([
      { provider: "p", model: "gpt-5.5" },
      { provider: "p", model: "gpt-5-5" },
      { provider: "p", model: "unrelated" },
    ]);
    const a = colliding.get("p/gpt-5.5")!;
    const b = colliding.get("p/gpt-5-5")!;
    expect(a).toMatch(/^claude-frogp-p-gpt-5-5-[a-f0-9]{6}$/);
    expect(b).toMatch(/^claude-frogp-p-gpt-5-5-[a-f0-9]{6}$/);
    expect(a).not.toBe(b);
    expect(colliding.get("p/unrelated")).toBe("claude-frogp-p-unrelated");

    // Colliding statically configured models still reverse-map to their exact route keys.
    const collidingConfig: FrogConfig = {
      port: 10100,
      defaultProvider: "p",
      providers: {
        p: { adapter: "openai-chat", baseUrl: "https://p.example/v1", models: ["gpt-5.5", "gpt-5-5"] },
      },
    };
    expect(resolveConfiguredModelAlias(collidingConfig, a)).toMatchObject({ provider: "p", model: "gpt-5.5" });
    expect(resolveConfiguredModelAlias(collidingConfig, b)).toMatchObject({ provider: "p", model: "gpt-5-5" });
  });


  test("configured aliases reverse-map to exact provider/model without persisted state", () => {
    const alias = deterministicModelAlias("provider-a", "Model X/Preview");
    const entry = resolveConfiguredModelAlias(config, alias);

    expect(entry).toMatchObject({
      alias,
      provider: "provider-a",
      model: "Model X/Preview",
      routeKey: "provider-a/Model X/Preview",
      displayName: "provider-a/Model X/Preview",
    });
  });

  test("router accepts Claude-visible aliases and routes to the original provider model", () => {
    const alias = deterministicModelAlias("provider-a", "Model X/Preview");
    const route = routeModel(config, alias);

    expect(route.providerName).toBe("provider-a");
    expect(route.modelId).toBe("Model X/Preview");
    expect(route.provider.apiKey).toBe("literal-key");
  });

  test("retired alias-shaped Claude ids do not fall through to client-default routing", () => {
    const retired = `claude-${"frogprogsy"}-provider-a-model-x-preview`;

    expect(resolveConfiguredModelAlias(config, retired)).toBeUndefined();
    expect(() => routeModel(config, retired)).toThrow(/Removed routed model alias/);
  });

  test("unknown current-prefix gateway alias fails closed instead of falling through to default", () => {
    // Carries the live gateway alias prefix but names a provider/model that resolves to nothing.
    const unknown = `${GATEWAY_MODEL_ALIAS_PREFIX}provider-a-does-not-exist`;

    expect(unknown.startsWith(GATEWAY_MODEL_ALIAS_PREFIX)).toBe(true); // premise
    expect(resolveConfiguredModelAlias(config, unknown)).toBeUndefined();
    // Must NOT drift to provider-a (the default) — throws so the request surface maps it to a 404.
    expect(() => routeModel(config, unknown)).toThrow(/Unknown gateway model alias/);
  });

  test("native Claude fallback model routes through non-Anthropic default provider", () => {
    const routed: FrogConfig = {
      port: 10100,
      defaultProvider: "codex",
      providers: {
        anthropic: {
          adapter: "anthropic",
          baseUrl: "https://api.anthropic.com",
          defaultModel: "claude-sonnet-4-6",
          models: ["claude-haiku-4-5-20251001"],
        },
        codex: {
          adapter: "openai-responses",
          baseUrl: "https://chatgpt.com/backend-api/codex",
          defaultModel: "gpt-5.5",
          models: ["gpt-5.5"],
        },
      },
    };

    const route = routeModel(routed, "claude-haiku-4-5-20251001");

    expect(route.providerName).toBe("codex");
    expect(route.modelId).toBe("gpt-5.5");
  });

  test("explicit Anthropic namespace still routes to Anthropic", () => {
    const routed: FrogConfig = {
      port: 10100,
      defaultProvider: "codex",
      providers: {
        anthropic: {
          adapter: "anthropic",
          baseUrl: "https://api.anthropic.com",
          defaultModel: "claude-sonnet-4-6",
          models: ["claude-haiku-4-5-20251001"],
        },
        codex: {
          adapter: "openai-responses",
          baseUrl: "https://chatgpt.com/backend-api/codex",
          defaultModel: "gpt-5.5",
          models: ["gpt-5.5"],
        },
      },
    };

    const route = routeModel(routed, "anthropic/claude-haiku-4-5-20251001");

    expect(route.providerName).toBe("anthropic");
    expect(route.modelId).toBe("claude-haiku-4-5-20251001");
  });

  test("canonical registry persists native aliases with no catalog file and no routed export", async () => {
    const { claudeHome, aliasesPath, cleanup } = makeHomes();
    try {
      // No catalog file (empty claudeHome) and no routed models: syncCatalogModels contributes nothing
      // to any catalog, but must still write the canonical alias registry BEFORE its early return.
      const result = await syncCatalogModels(nativeOnlyConfig, { claudeHome });
      expect(result.added).toBe(0);

      const nativeAlias = aliasForRouteKey(aliasesPath, `openai/${nativeSlug}`);
      expect(nativeAlias).toBeDefined();
      expect(resolvePersistedModelAlias(nativeAlias!)).toMatchObject({
        provider: "openai",
        model: nativeSlug,
        routeKey: `openai/${nativeSlug}`,
      });

      const route = routeModel(nativeOnlyConfig, nativeAlias!);
      expect(route.providerName).toBe("openai");
      expect(route.modelId).toBe(nativeSlug);
    } finally {
      cleanup();
    }
  });

  test("subset gateway-cache materialization does not prune canonical native aliases", async () => {
    const { claudeHome, aliasesPath, cleanup } = makeHomes();
    try {
      // Canonical full-registry write: native OpenAI slugs + the routed kimi model.
      await syncCatalogModels(tokenFreeConfig, { claudeHome });
      const nativeAlias = aliasForRouteKey(aliasesPath, `openai/${nativeSlug}`);
      const routedAlias = aliasForRouteKey(aliasesPath, "kimi/frog-kimi-only");
      expect(nativeAlias).toBeDefined();
      expect(routedAlias).toBeDefined();

      // A subset publisher (gateway cache) that only sees the kimi routed model must NOT delete the
      // native OpenAI aliases (nor the untouched routed alias) owned by the canonical writer.
      const result = await syncClaudeCodeGatewayModelsCache(tokenFreeConfig, { claudeHome }, {
        gatherRoutedModels: async () => [{ provider: "kimi", id: "frog-kimi-only", authReady: true }] as CatalogModel[],
      });
      expect(result.status).toBe("written");

      // Identity preserved exactly: the same alias strings still map to the same routeKeys.
      expect(aliasForRouteKey(aliasesPath, `openai/${nativeSlug}`)).toBe(nativeAlias);
      expect(aliasForRouteKey(aliasesPath, "kimi/frog-kimi-only")).toBe(routedAlias);
    } finally {
      cleanup();
    }
  });

  test("aliases advertised before a subset refresh still routeModel-resolve after it", async () => {
    const { claudeHome, aliasesPath, cleanup } = makeHomes();
    try {
      await syncCatalogModels(tokenFreeConfig, { claudeHome });
      const nativeAlias = aliasForRouteKey(aliasesPath, `openai/${nativeSlug}`)!;
      const routedAlias = aliasForRouteKey(aliasesPath, "kimi/frog-kimi-only")!;
      expect(nativeAlias).toBeDefined();
      expect(routedAlias).toBeDefined();

      // Premise: the native slug is genuinely absent from every configured models[].
      for (const prov of Object.values(tokenFreeConfig.providers)) {
        expect(prov.models ?? []).not.toContain(nativeSlug);
      }

      // Both advertised aliases resolve before the refresh.
      expect(routeModel(tokenFreeConfig, nativeAlias)).toMatchObject({ providerName: "openai", modelId: nativeSlug });
      expect(routeModel(tokenFreeConfig, routedAlias)).toMatchObject({ providerName: "kimi", modelId: "frog-kimi-only" });

      // Refresh via the subset gateway-cache writer (only the kimi routed model is visible).
      await syncClaudeCodeGatewayModelsCache(tokenFreeConfig, { claudeHome }, {
        gatherRoutedModels: async () => [{ provider: "kimi", id: "frog-kimi-only", authReady: true }] as CatalogModel[],
      });

      // Both advertised aliases STILL resolve to the exact same route after the refresh — including the
      // native OpenAI slug that never appeared in config.models.
      expect(routeModel(tokenFreeConfig, nativeAlias)).toMatchObject({ providerName: "openai", modelId: nativeSlug });
      expect(routeModel(tokenFreeConfig, routedAlias)).toMatchObject({ providerName: "kimi", modelId: "frog-kimi-only" });
    } finally {
      cleanup();
    }
  });

  test("schema-version-1 entries without status remain active", () => {
    const homes = makeHomes();
    try {
      const alias = deterministicModelAlias("provider-a", "Model X/Preview");
      writeFileSync(homes.aliasesPath, JSON.stringify({
        schemaVersion: 1,
        aliases: {
          [alias]: {
            alias,
            provider: "provider-a",
            model: "Model X/Preview",
            routeKey: "provider-a/Model X/Preview",
            displayName: "provider-a/Model X/Preview",
            createdAt: new Date(0).toISOString(),
          },
        },
      }));

      expect(routeModel(config, alias)).toMatchObject({
        providerName: "provider-a",
        modelId: "Model X/Preview",
      });
      expect(routeModel(config, alias).retired).toBeUndefined();
    } finally {
      homes.cleanup();
    }
  });

  test("canonical pruning preserves only currently catalog-confirmed retired aliases", () => {
    const homes = makeHomes();
    try {
      const [old] = materializeModelAliases([{ provider: "provider-a", model: "old" }], { prune: true });
      reconcileRetiredModelAliases(new Set(["provider-a/old"]));
      materializeModelAliases([{ provider: "provider-a", model: "new" }], { prune: true });

      expect(resolvePersistedModelAlias(old!.alias)).toMatchObject({
        routeKey: "provider-a/old",
        status: "retired",
      });

      reconcileRetiredModelAliases(new Set());
      materializeModelAliases([{ provider: "provider-a", model: "new" }], { prune: true });
      expect(resolvePersistedModelAlias(old!.alias)).toBeUndefined();
    } finally {
      homes.cleanup();
    }
  });

  test.each([false, true])("canonical=%s writer reserves aliases owned by a different tombstone", prune => {
    const homes = makeHomes();
    try {
      const [old] = materializeModelAliases([{ provider: "a", model: "b-c" }], { prune: true });
      reconcileRetiredModelAliases(new Set(["a/b-c"]));
      const [current] = materializeModelAliases([{ provider: "a-b", model: "c" }], { prune });

      expect(current!.alias).not.toBe(old!.alias);
      expect(resolvePersistedModelAlias(old!.alias)).toMatchObject({
        routeKey: "a/b-c",
        status: "retired",
      });
      expect(resolvePersistedModelAlias(current!.alias)).toMatchObject({
        routeKey: "a-b/c",
        status: "active",
      });
    } finally {
      homes.cleanup();
    }
  });

  test.each([false, true])("canonical=%s writer hides a tombstone until reconciliation makes its route active", prune => {
    const homes = makeHomes();
    try {
      const [old] = materializeModelAliases([{ provider: "a", model: "b-c" }], { prune: true });
      reconcileRetiredModelAliases(new Set(["a/b-c"]));
      const whileRetired = materializeModelAliases([{ provider: "a", model: "b-c" }], { prune });

      expect(whileRetired).toEqual([]);
      expect(resolvePersistedModelAlias(old!.alias)).toMatchObject({
        routeKey: "a/b-c",
        status: "retired",
      });

      reconcileRetiredModelAliases(new Set());
      const [activeAgain] = materializeModelAliases([{ provider: "a", model: "b-c" }], { prune });
      expect(activeAgain).toMatchObject({
        alias: old!.alias,
        routeKey: "a/b-c",
        status: "active",
      });
      expect(resolvePersistedModelAlias(old!.alias)).toMatchObject({
        routeKey: "a/b-c",
        status: "active",
      });
    } finally {
      homes.cleanup();
    }
  });


  test("canonical unretire preserves the old alias while suffixing only a newly colliding route", () => {
    const homes = makeHomes();
    try {
      const [old] = materializeModelAliases([{ provider: "a", model: "b-c" }], { prune: true });
      reconcileRetiredModelAliases(new Set(["a/b-c"]));
      const [collision] = materializeModelAliases([{ provider: "a-b", model: "c" }], { prune: true });
      reconcileRetiredModelAliases(new Set());

      const active = materializeModelAliases([
        { provider: "a", model: "b-c" },
        { provider: "a-b", model: "c" },
      ], { prune: true });

      expect(active).toContainEqual(expect.objectContaining({
        alias: old!.alias,
        routeKey: "a/b-c",
        status: "active",
      }));
      expect(active).toContainEqual(expect.objectContaining({
        alias: collision!.alias,
        routeKey: "a-b/c",
        status: "active",
      }));
      expect(collision!.alias).toMatch(new RegExp(`^${old!.alias}-[a-f0-9]{6}$`));
      expect(resolvePersistedModelAlias(old!.alias)?.routeKey).toBe("a/b-c");
      expect(resolvePersistedModelAlias(collision!.alias)?.routeKey).toBe("a-b/c");
    } finally {
      homes.cleanup();
    }
  });
  test("live discovery cannot republish a retired model through canonical catalog sync", async () => {
    const homes = makeHomes();
    const originalFetch = globalThis.fetch;
    try {
      const retiredTargets = new Set(["work-fix-round/old"]);
      const [retired] = materializeModelAliases(
        [{ provider: "work-fix-round", model: "old" }],
        { prune: true },
      );
      reconcileRetiredModelAliases(retiredTargets);
      writeFileSync(join(homes.claudeHome, "frogprogsy-catalog.json"), JSON.stringify({
        models: [{
          slug: "gpt-5.5",
          display_name: "gpt-5.5",
          priority: 1,
          base_instructions: "Native model fixture",
        }],
      }));
      globalThis.fetch = (async () => new Response(JSON.stringify({
        data: [{ id: "old" }, { id: "new" }],
      }), {
        status: 200,
        headers: { "content-type": "application/json" },
      })) as typeof fetch;
      const liveConfig: FrogConfig = {
        port: 10100,
        defaultProvider: "work-fix-round",
        providers: {
          "work-fix-round": {
            adapter: "openai-chat",
            baseUrl: "https://work-fix-round.invalid/v1",
            apiKey: "test-key",
            liveModels: true,
          },
        },
      };

      const result = await syncCatalogModels(liveConfig, {
        claudeHome: homes.claudeHome,
        retiredTargets,
      });
      const catalog = JSON.parse(readFileSync(result.path, "utf8")) as {
        models: Array<{ slug: string }>;
      };
      expect(catalog.models.map(model => model.slug)).toContain("work-fix-round/new");
      expect(catalog.models.map(model => model.slug)).not.toContain("work-fix-round/old");
      expect(resolvePersistedModelAlias(retired!.alias)).toMatchObject({
        routeKey: "work-fix-round/old",
        status: "retired",
      });
    } finally {
      globalThis.fetch = originalFetch;
      homes.cleanup();
    }
  });
});

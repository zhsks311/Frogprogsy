import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "bun:test";
import {
  buildRetiredTargetIndex,
  collectModelContinuityReferences,
  normalizeContinuityPolicy,
  qualifiedModelTarget,
  replaceModelContinuityReference,
  validateContinuityPolicy,
  type ModelContinuityValidationInput,
} from "../src/model-continuity";
import { listPersistedModelAliases, materializeModelAliases, reconcileRetiredModelAliases, resolvePersistedModelAlias, type ModelAliasEntry } from "../src/model-aliases";
import { createRuntimeConfigState } from "../src/runtime-config-state";
import { __requestLogTest } from "../src/server";
import type { SelectedModelCatalog } from "../src/model-catalog-runtime";
import type { FrogConfig, ModelContinuityAutomatic } from "../src/types";

function configWithRenamedManagedProvider(): FrogConfig {
  return {
    port: 3764,
    defaultProvider: "work",
    disabledModels: ["work/config-hidden"],
    providers: {
      work: {
        adapter: "anthropic",
        baseUrl: "https://managed.invalid",
        catalogProviderId: "anthropic",
      },
      codex: {
        adapter: "openai-responses",
        baseUrl: "https://codex.invalid",
        catalogProviderId: "openai",
      },
      custom: {
        adapter: "anthropic",
        baseUrl: "https://anthropic.invalid",
        models: ["claude-old"],
      },
      anthropic: {
        adapter: "anthropic",
        baseUrl: "https://same-name.invalid",
        models: ["claude-old"],
      },
      offlineManaged: {
        adapter: "anthropic",
        baseUrl: "https://offline.invalid",
        catalogProviderId: "anthropic",
        liveModels: false,
      },
    },
  };
}

function selectedCatalog(): SelectedModelCatalog {
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
          id: "anthropic",
          retiredModels: ["claude-old", "claude-retired"],
          models: [{ id: "claude-new" }],
        },
        {
          id: "openai",
          models: [{ id: "gpt-x" }],
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

const models: ModelContinuityValidationInput["models"] = [
  { namespaced: "work/claude-new", disabled: false, authReady: true, supportStatus: "validated" },
  { namespaced: "codex/gpt-x", disabled: false, authReady: true, supportStatus: "validated" },
  { namespaced: "work/claude-retired", disabled: false, authReady: true, supportStatus: "validated" },
  { namespaced: "work/claude-hidden", disabled: true, authReady: true, supportStatus: "validated" },
  { namespaced: "work/config-hidden", disabled: false, authReady: true, supportStatus: "validated" },
  { namespaced: "work/claude-discovered", disabled: false, authReady: true, supportStatus: "discovered" },
  { namespaced: "work/claude-login", disabled: false, authReady: false, supportStatus: "validated" },
];

function policyInput(
  overrides: Partial<Pick<ModelContinuityValidationInput, "automatic" | "fallbacks">> = {},
): ModelContinuityValidationInput {
  const config = configWithRenamedManagedProvider();
  return {
    primaryTarget: "work/claude-old",
    config,
    retiredTargets: buildRetiredTargetIndex(config, selectedCatalog()),
    models,
    automatic: "all",
    fallbacks: ["work/claude-new"],
    ...overrides,
  };
}

function validPolicyInput(fallbacks: string[]): ModelContinuityValidationInput {
  return policyInput({ fallbacks });
}

describe("model continuity target parsing", () => {
  test("requires a non-empty provider and model", () => {
    expect(qualifiedModelTarget("work/claude-new")).toEqual({ provider: "work", model: "claude-new" });
    expect(qualifiedModelTarget("work/model/variant")).toEqual({ provider: "work", model: "model/variant" });
    expect(qualifiedModelTarget("work")).toBeNull();
    expect(qualifiedModelTarget("/claude-new")).toBeNull();
    expect(qualifiedModelTarget("work/")).toBeNull();
  });
});

describe("model retirement identity", () => {
  test("uses catalogProviderId and never provider-name inference", () => {
    const retired = buildRetiredTargetIndex(configWithRenamedManagedProvider(), selectedCatalog());

    expect(retired.has("work/claude-old")).toBeTrue();
    expect(retired.has("offlineManaged/claude-old")).toBeTrue();
    expect(retired.has("custom/claude-old")).toBeFalse();
    expect(retired.has("anthropic/claude-old")).toBeFalse();
  });

  test.each(["retired model removed", "configured provider removed"])(
    "runtime rebuild drops tombstone authority when the %s",
    async scenario => {
      const frogHome = mkdtempSync(join(tmpdir(), "frogp-retired-state-"));
      const previousFrogHome = process.env.FROGPROGSY_HOME;
      process.env.FROGPROGSY_HOME = frogHome;
      try {
        const [old] = materializeModelAliases([{ provider: "work", model: "claude-old" }], { prune: true });
        const config = configWithRenamedManagedProvider();
        const catalog = selectedCatalog();
        const state = await createRuntimeConfigState({
          loadConfig: () => config,
          saveConfig: () => {},
          refreshCatalog: async () => catalog,
          getConfigPath: () => join(frogHome, "config.json"),
          configExists: () => false,
        });

        expect(state.retiredTargets.has("work/claude-old")).toBeTrue();
        expect(resolvePersistedModelAlias(old!.alias)).toMatchObject({ status: "retired" });

        if (scenario === "retired model removed") {
          catalog.document.providers[0]!.retiredModels = ["claude-retired"];
        } else {
          delete state.persisted.providers.work;
        }
        state.rebuild();

        expect(state.retiredTargets.has("work/claude-old")).toBeFalse();
        expect(resolvePersistedModelAlias(old!.alias)).toMatchObject({ status: "active" });
        materializeModelAliases([], { prune: true });
        expect(resolvePersistedModelAlias(old!.alias)).toBeUndefined();
      } finally {
        if (previousFrogHome === undefined) delete process.env.FROGPROGSY_HOME;
        else process.env.FROGPROGSY_HOME = previousFrogHome;
        rmSync(frogHome, { recursive: true, force: true });
      }
    },
  );
});

describe("retired request continuity preflight", () => {
  test.each([
    ["off", "work/claude-old"],
    ["off", "alias"],
    ["transient", "work/claude-old"],
    ["transient", "alias"],
  ] as const)("automatic=%s returns typed 410 for retired %s", async (automatic, requestedTarget) => {
    const frogHome = mkdtempSync(join(tmpdir(), "frogp-retired-request-"));
    const previousFrogHome = process.env.FROGPROGSY_HOME;
    process.env.FROGPROGSY_HOME = frogHome;
    try {
      const [old] = materializeModelAliases([{ provider: "work", model: "claude-old" }], { prune: true });
      reconcileRetiredModelAliases(new Set(["work/claude-old"]));
      const config: FrogConfig = {
        port: 3764,
        defaultProvider: "work",
        fallbackProviders: ["generic-fallback"],
        providers: {
          work: {
            adapter: "anthropic",
            baseUrl: "https://work.invalid",
            apiKey: "test-key",
            models: ["claude-old", "claude-new"],
          },
          "generic-fallback": {
            adapter: "anthropic",
            baseUrl: "https://fallback.invalid",
            apiKey: "test-key",
            defaultModel: "fallback",
          },
        },
        modelContinuity: {
          "work/claude-old": {
            automatic,
            fallbacks: ["work/claude-new"],
          },
        },
      };
      const logCtx = __requestLogTest.createRequestLog("/v1/messages", "POST", new Headers());
      const response = await __requestLogTest.handleMessages(
        new Request("http://127.0.0.1/v1/messages", {
          method: "POST",
          body: JSON.stringify({
            model: requestedTarget === "alias" ? old!.alias : requestedTarget,
            max_tokens: 16,
            messages: [{ role: "user", content: "hello" }],
          }),
        }),
        config,
        logCtx,
        { retiredTargets: new Set(["work/claude-old"]) },
      );

      expect(response.status).toBe(410);
      expect(await response.json()).toMatchObject({
        type: "error",
        error: {
          type: "invalid_request_error",
          message: `Model "${requestedTarget === "alias" ? old!.alias : requestedTarget}" was retired. Run: frogp models continuity`,
        },
      });
    } finally {
      if (previousFrogHome === undefined) delete process.env.FROGPROGSY_HOME;
      else process.env.FROGPROGSY_HOME = previousFrogHome;
      rmSync(frogHome, { recursive: true, force: true });
      __requestLogTest.clear();
    }
  });

  test("fabricated gateway alias remains a typed 404", async () => {
    const config: FrogConfig = {
      port: 3764,
      defaultProvider: "work",
      providers: {
        work: {
          adapter: "anthropic",
          baseUrl: "https://work.invalid",
          apiKey: "test-key",
          models: ["claude-old"],
        },
      },
    };
    const logCtx = __requestLogTest.createRequestLog("/v1/messages", "POST", new Headers());
    const response = await __requestLogTest.handleMessages(
      new Request("http://127.0.0.1/v1/messages", {
        method: "POST",
        body: JSON.stringify({
          model: "claude-frogp-fabricated",
          max_tokens: 16,
          messages: [{ role: "user", content: "hello" }],
        }),
      }),
      config,
      logCtx,
      { retiredTargets: new Set(["work/claude-old"]) },
    );

    expect(response.status).toBe(404);
  });
});


describe("model continuity policy", () => {
  test("defaults off and preserves exact order", () => {
    expect(normalizeContinuityPolicy(undefined)).toEqual({ fallbacks: [], automatic: "off" });
    expect(validateContinuityPolicy(validPolicyInput([
      "work/claude-new",
      "codex/gpt-x",
    ]))).toEqual({
      ok: true,
      policy: { fallbacks: ["work/claude-new", "codex/gpt-x"], automatic: "all" },
      warnings: [],
    });
  });

  test.each([
    ["self", ["work/claude-old"]],
    ["duplicate", ["work/claude-new", "work/claude-new"]],
    ["too many", ["work/a", "work/b", "work/c", "work/d"]],
    ["retired", ["work/claude-retired"]],
    ["hidden row", ["work/claude-hidden"]],
    ["hidden config", ["work/config-hidden"]],
    ["unknown provider", ["missing/model"]],
    ["unknown model", ["work/missing"]],
    ["unqualified", ["claude-new"]],
  ])("rejects %s fallback candidates", (_name, fallbacks) => {
    expect(validateContinuityPolicy(policyInput({ fallbacks })).ok).toBeFalse();
  });

  test("allows discovered and auth-not-ready candidates with warnings", () => {
    const result = validateContinuityPolicy(policyInput({
      fallbacks: ["work/claude-discovered", "work/claude-login"],
    }));

    expect(result.ok).toBeTrue();
    if (!result.ok) return;
    expect(result.policy.fallbacks).toEqual(["work/claude-discovered", "work/claude-login"]);
    expect(result.warnings).toHaveLength(2);
    expect(result.warnings.join(" ")).toContain("discovered");
    expect(result.warnings.join(" ")).toContain("authReady:false");
  });

  test("rejects automatic continuity for the pinned auto-mode classifier target", () => {
    const input = policyInput();
    input.config.autoModeClassifier = { provider: "work", model: "claude-old" };

    expect(validateContinuityPolicy(input).ok).toBeFalse();
  });

  test("rejects an unsupported automatic mode at the runtime boundary", () => {
    expect(validateContinuityPolicy(policyInput({
      automatic: "later" as ModelContinuityAutomatic,
    })).ok).toBeFalse();
  });
});

const inventoryModels: ModelContinuityValidationInput["models"] = [
  { namespaced: "work/default", authReady: true, supportStatus: "validated" },
  { namespaced: "work/long", authReady: true, supportStatus: "validated" },
  { namespaced: "work/subagent", authReady: true, supportStatus: "discovered" },
  { namespaced: "work/classifier", authReady: true, supportStatus: "validated" },
  { namespaced: "work/coordinator", authReady: true, supportStatus: "validated" },
  { namespaced: "work/agent", authReady: false, supportStatus: "validated" },
  { namespaced: "work/pipeline", authReady: true, supportStatus: "validated" },
  { namespaced: "work/panel", authReady: true, supportStatus: "validated" },
  { namespaced: "work/judge", authReady: true, supportStatus: "validated" },
  { namespaced: "work/synthesizer", authReady: true, supportStatus: "validated" },
  { namespaced: "work/rule", authReady: true, supportStatus: "validated" },
  { namespaced: "work/search", authReady: true, supportStatus: "validated" },
  { namespaced: "work/image", authReady: true, supportStatus: "validated" },
  { namespaced: "work/alias-active", authReady: true, supportStatus: "validated" },
];

function aliasEntry(
  alias: string,
  provider: string,
  model: string,
): ModelAliasEntry {
  const routeKey = `${provider}/${model}`;
  return {
    alias,
    provider,
    model,
    routeKey,
    displayName: routeKey,
    createdAt: new Date(0).toISOString(),
  };
}

function inventoryInput() {
  const config: FrogConfig = {
    port: 3764,
    defaultProvider: "work",
    providers: {
      work: {
        adapter: "anthropic",
        baseUrl: "https://work.invalid",
        defaultModel: "default",
      },
    },
    longContext: { thresholdTokens: 100_000, provider: "work", model: "long" },
    subagentModels: ["work/subagent"],
    autoModeClassifier: { provider: "work", model: "classifier" },
    modelMixing: {
      enabled: true,
      coordinator: { provider: "work", model: "coordinator" },
      agents: [{ provider: "work", model: "agent" }],
      pipeline: [{ role: "worker", provider: "work", model: "pipeline" }],
      fusion: {
        panel: [{ provider: "work", model: "panel" }],
        judge: { provider: "work", model: "judge" },
        synthesizer: { provider: "work", model: "synthesizer" },
      },
      rules: [{ provider: "work", model: "rule" }],
    },
    webSearchFallback: {
      enabled: true,
      provider: "work",
      model: "search",
      searchProviders: {
        dormant: { enabled: true, provider: "work", model: "search-api" },
      },
    },
    imageFallback: { enabled: true, provider: "work", model: "image" },
    shadowCompare: {
      enabled: true,
      secondary: { provider: "work", model: "shadow" },
    },
  };
  return {
    config,
    models: inventoryModels,
    retiredTargets: new Set<string>(),
    aliases: [aliasEntry("claude-frogp-active", "work", "alias-active")],
  };
}

function repeatedTargetInput() {
  const config: FrogConfig = {
    port: 3764,
    defaultProvider: "codex",
    providers: {
      codex: {
        adapter: "openai-responses",
        baseUrl: "https://codex.invalid",
        defaultModel: "gpt-x",
      },
    },
    autoModeClassifier: { provider: "codex", model: "gpt-x" },
    modelMixing: {
      enabled: true,
      agents: [{ provider: "codex", model: "gpt-x" }],
    },
  };
  return {
    config,
    models: [{ namespaced: "codex/gpt-x", authReady: true, supportStatus: "validated" }] as const,
    retiredTargets: new Set<string>(),
    aliases: [],
  };
}

describe("model continuity reference inventory", () => {
  test("enumerates active owners and excludes dormant typed fields", () => {
    const rows = collectModelContinuityReferences(inventoryInput());

    expect(rows.map(row => row.kind)).toEqual([
      "provider-default",
      "long-context",
      "subagent",
      "classifier",
      "mix-coordinator",
      "mix-agent",
      "mix-pipeline",
      "mix-panel",
      "mix-judge",
      "mix-synthesizer",
      "mix-rule",
      "web-search-helper",
      "image-helper",
      "gateway-alias",
    ]);
    expect(rows.some(row => row.id.includes("shadowCompare"))).toBeFalse();
    expect(rows.some(row => row.id.includes("searchProviders"))).toBeFalse();
    expect(rows.find(row => row.id === "mix-agent:0")).toMatchObject({
      primary: "work/agent",
      status: "authentication_required",
      automaticEligible: false,
      supportStatus: "validated",
      policy: { fallbacks: [], automatic: "off" },
    });
    expect(rows.find(row => row.id === "subagent:0")?.supportStatus).toBe("discovered");
  });

  test("gateway aliases include only current or retired routes from configured providers", () => {
    const input = inventoryInput();
    input.retiredTargets.add("work/alias-retired");
    input.aliases = [
      aliasEntry("claude-frogp-active", "work", "alias-active"),
      aliasEntry("claude-frogp-retired", "work", "alias-retired"),
      aliasEntry("claude-frogp-stale", "work", "stale"),
      aliasEntry("claude-frogp-removed", "removed", "old"),
    ];

    const aliases = collectModelContinuityReferences(input)
      .filter(row => row.kind === "gateway-alias");
    expect(aliases.map(row => row.id)).toEqual([
      "gateway-alias:claude-frogp-active",
      "gateway-alias:claude-frogp-retired",
    ]);
    expect(aliases[1]?.status).toBe("retired");
  });

  test("same target keeps separate permanent-replacement owners", () => {
    const rows = collectModelContinuityReferences(repeatedTargetInput());
    const repeated = rows.filter(row => row.primary === "codex/gpt-x");

    expect(repeated.map(row => row.id)).toEqual([
      "provider-default:codex",
      "classifier",
      "mix-agent:0",
    ]);
  });

  test("subagent owners resolve native ids and preserve unresolvable indexes", () => {
    const config: FrogConfig = {
      port: 3764,
      defaultProvider: "missing",
      providers: {
        work: {
          adapter: "anthropic",
          baseUrl: "https://work.invalid",
          models: ["native", "qualified", "new"],
        },
      },
      subagentModels: ["native", "work/qualified", "unresolvable"],
    };
    const input = {
      config,
      models: [
        { namespaced: "work/native" },
        { namespaced: "work/qualified" },
        { namespaced: "work/new" },
      ],
      retiredTargets: new Set<string>(),
      aliases: [],
    };

    expect(collectModelContinuityReferences(input)
      .filter(row => row.kind === "subagent")
      .map(row => ({ id: row.id, primary: row.primary, status: row.status }))).toEqual([
      { id: "subagent:0", primary: "work/native", status: "ready" },
      { id: "subagent:1", primary: "work/qualified", status: "ready" },
      { id: "subagent:2", primary: "unresolvable", status: "policy_invalid" },
    ]);
    expect(replaceModelContinuityReference({
      config,
      referenceId: "subagent:2",
      expectedPrimary: "unresolvable",
      replacement: "work/new",
      models: input.models,
      validateTarget: validateReplacementTarget,
    })).toEqual({ ok: true });
    expect(config.subagentModels).toEqual(["native", "work/qualified", "work/new"]);
  });
});

function replacementConfig(): FrogConfig {
  return {
    port: 3764,
    defaultProvider: "work",
    providers: {
      work: {
        adapter: "anthropic",
        baseUrl: "https://work.invalid",
        defaultModel: "old",
        models: ["old", "new"],
      },
      codex: {
        adapter: "openai-responses",
        baseUrl: "https://codex.invalid",
        models: ["old", "new"],
      },
    },
    longContext: { thresholdTokens: 100_000, provider: "work", model: "old" },
    subagentModels: ["work/old", "codex/old"],
    autoModeClassifier: { provider: "work", model: "old" },
    modelMixing: {
      enabled: true,
      coordinator: { provider: "work", model: "old" },
      agents: [
        { provider: "work", model: "old" },
        { provider: "codex", model: "old" },
      ],
      pipeline: [{ role: "worker", provider: "work", model: "old" }],
      fusion: {
        panel: [{ provider: "work", model: "old" }],
        judge: { provider: "work", model: "old" },
        synthesizer: { provider: "work", model: "old" },
      },
      rules: [{ provider: "work", model: "old" }],
    },
    webSearchFallback: { enabled: true, provider: "work", model: "old" },
    imageFallback: { enabled: true, provider: "work", model: "old" },
  };
}

const REPLACEMENT_MODELS: ModelContinuityValidationInput["models"] = [
  { namespaced: "work/old" },
  { namespaced: "work/new" },
  { namespaced: "codex/old" },
  { namespaced: "codex/new" },
  { namespaced: "codex/live" },
];

function replacementOwnerSnapshot(config: FrogConfig): Record<string, string> {
  return Object.fromEntries(collectModelContinuityReferences({
    config,
    models: REPLACEMENT_MODELS,
    retiredTargets: new Set(),
    aliases: [],
  }).filter(row => row.kind !== "gateway-alias").map(row => [row.id, row.primary]));
}

const VALID_REPLACEMENT_TARGETS: Record<string, true> = {
  "work/new": true,
  "codex/new": true,
  "codex/live": true,
};
const validateReplacementTarget = (target: string): string | null =>
  VALID_REPLACEMENT_TARGETS[target] ? null : `unknown model target: ${target}`;

function replace(
  config: FrogConfig,
  referenceId: string,
  expectedPrimary: string,
  replacement: string,
  models: ModelContinuityValidationInput["models"] = REPLACEMENT_MODELS,
) {
  return replaceModelContinuityReference({
    config,
    referenceId,
    expectedPrimary,
    replacement,
    models,
    validateTarget: validateReplacementTarget,
  });
}

describe("model continuity permanent replacement", () => {
  test("rejects a stale expected target before validation or mutation", () => {
    const config = replacementConfig();
    let validationCalls = 0;

    const result = replaceModelContinuityReference({
      config,
      referenceId: "mix-agent:0",
      expectedPrimary: "codex/old",
      replacement: "codex/new",
      validateTarget: target => {
        validationCalls += 1;
        return validateReplacementTarget(target);
      },
    });

    expect(result).toEqual({
      ok: false,
      status: 409,
      error: "model reference changed; reload and retry",
    });
    expect(validationCalls).toBe(0);
    expect(config.modelMixing?.agents?.[0]).toEqual({ provider: "work", model: "old" });
  });

  test("returns stale conflict when a previously listed owner was removed", () => {
    const deletedIndexConfig = replacementConfig();
    deletedIndexConfig.modelMixing!.agents!.splice(1, 1);
    expect(replace(
      deletedIndexConfig,
      "mix-agent:1",
      "codex/old",
      "work/new",
    )).toEqual({
      ok: false,
      status: 409,
      error: "model reference changed; reload and retry",
    });

    const removedSingletonConfig = replacementConfig();
    delete removedSingletonConfig.autoModeClassifier;
    expect(replace(
      removedSingletonConfig,
      "classifier",
      "work/old",
      "work/new",
    )).toEqual({
      ok: false,
      status: 409,
      error: "model reference changed; reload and retry",
    });
  });

  test("provider default replacement stays inside its configured provider", () => {
    const config = replacementConfig();
    const before = replacementOwnerSnapshot(config);

    expect(replace(config, "provider-default:work", "work/old", "codex/new").ok).toBeFalse();
    expect(replacementOwnerSnapshot(config)).toEqual(before);
    expect(replace(config, "provider-default:work", "work/old", "work/new").ok).toBeTrue();
    expect(replacementOwnerSnapshot(config)).toEqual({
      ...before,
      "provider-default:work": "work/new",
    });
  });

  test("classifier replacement reuses strict classifier validation", () => {
    const config = replacementConfig();
    config.providers.codex.models = ["old"];
    const before = replacementOwnerSnapshot(config);

    expect(replace(
      config,
      "classifier",
      "work/old",
      "codex/new",
      [{ namespaced: "codex/old" }],
    )).toMatchObject({
      ok: false,
      status: 400,
    });
    expect(replacementOwnerSnapshot(config)).toEqual(before);
    config.providers.codex.models.push("new");
    expect(replace(
      config,
      "classifier",
      "work/old",
      "codex/new",
      [{ namespaced: "codex/old" }],
    ).ok).toBeTrue();
    expect(replacementOwnerSnapshot(config)).toEqual({
      ...before,
      classifier: "codex/new",
    });
  });

  test("classifier replacement rejects disabled targets and accepts effective live-only models", () => {
    const disabledConfig = replacementConfig();
    disabledConfig.disabledModels = ["codex/new"];
    expect(replace(
      disabledConfig,
      "classifier",
      "work/old",
      "codex/new",
    )).toMatchObject({ ok: false, status: 400 });
    expect(disabledConfig.autoModeClassifier).toEqual({ provider: "work", model: "old" });

    const liveConfig = replacementConfig();
    liveConfig.providers.codex.models = ["old"];
    liveConfig.providers.codex.liveModels = true;
    expect(replace(
      liveConfig,
      "classifier",
      "work/old",
      "codex/live",
      [{ namespaced: "codex/live" }],
    )).toEqual({ ok: true });
    expect(liveConfig.autoModeClassifier).toEqual({ provider: "codex", model: "live" });
  });

  test.each([
    ["long-context", "work/old", "codex/new"],
    ["subagent:1", "codex/old", "work/new"],
    ["mix-coordinator", "work/old", "codex/new"],
    ["mix-agent:1", "codex/old", "work/new"],
    ["mix-pipeline:0", "work/old", "codex/new"],
    ["mix-panel:0", "work/old", "codex/new"],
    ["mix-judge", "work/old", "codex/new"],
    ["mix-synthesizer", "work/old", "codex/new"],
    ["mix-rule:0", "work/old", "codex/new"],
    ["web-search-helper", "work/old", "codex/new"],
    ["image-helper", "work/old", "codex/new"],
  ])("replaces only the exact %s owner", (referenceId, expectedPrimary, replacement) => {
    const config = replacementConfig();
    const before = replacementOwnerSnapshot(config);

    expect(replace(config, referenceId, expectedPrimary, replacement)).toEqual({ ok: true });
    expect(replacementOwnerSnapshot(config)).toEqual({
      ...before,
      [referenceId]: replacement,
    });
  });

  test("gateway aliases direct permanent changes to route policy", () => {
    const config = replacementConfig();

    expect(replace(
      config,
      "gateway-alias:claude-frogp-work-old",
      "work/old",
      "work/new",
    )).toEqual({
      ok: false,
      status: 400,
      error: "gateway aliases are past-session identifiers; configure a route policy instead",
    });
  });
});

describe("persisted model alias listing", () => {
  test("returns detached entries without exposing registry paths", () => {
    const home = mkdtempSync(join(tmpdir(), "frogp-continuity-aliases-"));
    const previousHome = process.env.FROGPROGSY_HOME;
    process.env.FROGPROGSY_HOME = home;
    try {
      const entry = aliasEntry("claude-frogp-work-old", "work", "old");
      writeFileSync(join(home, "model-aliases.json"), JSON.stringify({
        schemaVersion: 1,
        aliases: { [entry.alias]: entry },
      }));

      const listed = listPersistedModelAliases();
      expect(listed).toEqual([entry]);
      listed[0]!.model = "changed";
      expect(listPersistedModelAliases()).toEqual([entry]);
      expect(listed[0]).not.toHaveProperty("path");
    } finally {
      if (previousHome === undefined) delete process.env.FROGPROGSY_HOME;
      else process.env.FROGPROGSY_HOME = previousHome;
      rmSync(home, { recursive: true, force: true });
    }
  });
});

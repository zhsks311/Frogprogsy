/**
 * Adversarial / contract regression suite for the reserved auto-mode classifier alias.
 *
 * New contract (Claude Code 2.1.220): the auto-mode side-classifier is identified ONLY by the exact
 * reserved gateway alias `claude-frogp-auto-classifier` (AUTO_MODE_CLASSIFIER_ALIAS) and routes to the
 * single explicit `config.autoModeClassifier` target. There is NO model-name-shape (Haiku) guessing,
 * NO per-provider `classifierModel`, NO cross-provider `classifierFallback`, and NO generic
 * `fallbackProviders` leakage. These tests are intentionally hostile — they try to make an arbitrary
 * model become the auto-mode safety judge, and assert that it cannot.
 */
import { describe, expect, test } from "bun:test";
import { routeModel } from "../src/router";
import { buildAttemptContexts, resolvePrimaryRoute } from "../src/provider-fallback";
import { isModelMixingRequest } from "../src/model-mixing";
import { applyModelMixingPatch } from "../src/model-mixing/settings";
import {
  AUTO_MODE_CLASSIFIER_ALIAS,
  resolveAutoModeClassifierTarget,
  classifierSettingsSnapshot,
  validateClassifierModel,
} from "../src/classifier-settings";
import type { FrogConfig, FrogParsedRequest } from "../src/types";

/** codex default (non-Anthropic) + an explicit classifier target pinned to codex/gpt-5.4-mini. */
function coreConfig(): FrogConfig {
  return {
    port: 10100,
    defaultProvider: "codex",
    providers: {
      codex: {
        adapter: "openai-responses",
        baseUrl: "https://chatgpt.com/backend-api/codex",
        authMode: "oauth",
        defaultModel: "gpt-5.5",
        models: ["gpt-5.5", "gpt-5.4-mini"],
      },
      anthropic: {
        adapter: "anthropic",
        baseUrl: "https://api.anthropic.com",
        authMode: "oauth",
        defaultModel: "claude-sonnet-4-6",
        models: [
          "claude-haiku-4-5",
          "claude-haiku-4-5-20251001",
          "claude-3-5-haiku-20241022",
          "claude-sonnet-4-6",
        ],
      },
    },
    autoModeClassifier: { provider: "codex", model: "gpt-5.4-mini" },
  };
}

function parsed(modelId: string, promptChars = 0): FrogParsedRequest {
  return {
    modelId,
    context: {
      messages: promptChars > 0 ? [{ role: "user", content: "x".repeat(promptChars), timestamp: 0 }] : [],
    },
    stream: false,
    options: {},
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Group 1 — Reserved alias → explicit target (routeKind:"classifier", classifierRoute:true)
// ─────────────────────────────────────────────────────────────────────────────
describe("reserved alias → explicit autoModeClassifier target", () => {
  test("exact reserved alias routes to the configured target", () => {
    const r = routeModel(coreConfig(), AUTO_MODE_CLASSIFIER_ALIAS);
    expect(r.providerName).toBe("codex");
    expect(r.modelId).toBe("gpt-5.4-mini");
    expect(r.routeKind).toBe("classifier");
    expect(r.classifierRoute).toBe(true);
  });

  test("the alias literal is exactly claude-frogp-auto-classifier", () => {
    expect(AUTO_MODE_CLASSIFIER_ALIAS).toBe("claude-frogp-auto-classifier");
  });

  test("target may point at a DIFFERENT provider than defaultProvider (explicit, not generic fallback)", () => {
    const cfg = coreConfig();
    cfg.autoModeClassifier = { provider: "anthropic", model: "claude-haiku-4-5" };
    const r = routeModel(cfg, AUTO_MODE_CLASSIFIER_ALIAS);
    expect(r.providerName).toBe("anthropic");
    expect(r.modelId).toBe("claude-haiku-4-5");
    expect(r.routeKind).toBe("classifier");
    expect(r.classifierRoute).toBe(true);
  });

  test("apiKey on the target provider is env-resolved on the route", () => {
    const cfg = coreConfig();
    cfg.providers.codex = {
      adapter: "openai-chat",
      baseUrl: "https://example.com",
      authMode: "key",
      apiKey: "sk-live-123",
      defaultModel: "gpt-5.5",
      models: ["gpt-5.5", "gpt-5.4-mini"],
    };
    const r = routeModel(cfg, AUTO_MODE_CLASSIFIER_ALIAS);
    expect(r.provider.apiKey).toBe("sk-live-123");
  });

  test("an unknown-but-not-disabled target model still routes (warn-only), does not throw", () => {
    const cfg = coreConfig();
    cfg.autoModeClassifier = { provider: "codex", model: "gpt-5.9-mini-unknown" };
    const r = routeModel(cfg, AUTO_MODE_CLASSIFIER_ALIAS);
    expect(r.providerName).toBe("codex");
    expect(r.modelId).toBe("gpt-5.9-mini-unknown");
    expect(r.classifierRoute).toBe(true);
    // The unknown model is a warn-only diagnostic for API workers, never a hard route error.
    expect(validateClassifierModel(cfg, "codex", "gpt-5.9-mini-unknown")).toBeTypeOf("string");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Group 2 — Missing / incomplete / unknown-provider / disabled target fails CLOSED
// ─────────────────────────────────────────────────────────────────────────────
describe("unusable target fails closed (throws, never drifts to a heavy model)", () => {
  test("unset autoModeClassifier → throws", () => {
    const cfg = coreConfig();
    delete cfg.autoModeClassifier;
    expect(() => routeModel(cfg, AUTO_MODE_CLASSIFIER_ALIAS)).toThrow();
    const res = resolveAutoModeClassifierTarget(cfg);
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.reason).toBe("unset");
  });

  test("incomplete target (missing model) → throws / incomplete", () => {
    const cfg = coreConfig();
    cfg.autoModeClassifier = { provider: "codex", model: "" };
    expect(() => routeModel(cfg, AUTO_MODE_CLASSIFIER_ALIAS)).toThrow();
    const res = resolveAutoModeClassifierTarget(cfg);
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.reason).toBe("incomplete");
  });

  test("incomplete target (missing provider) → throws / incomplete", () => {
    const cfg = coreConfig();
    cfg.autoModeClassifier = { provider: "   ", model: "gpt-5.4-mini" };
    expect(() => routeModel(cfg, AUTO_MODE_CLASSIFIER_ALIAS)).toThrow();
    const res = resolveAutoModeClassifierTarget(cfg);
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.reason).toBe("incomplete");
  });

  test("provider not in config → throws / provider_missing", () => {
    const cfg = coreConfig();
    cfg.autoModeClassifier = { provider: "ghost", model: "gpt-5.4-mini" };
    expect(() => routeModel(cfg, AUTO_MODE_CLASSIFIER_ALIAS)).toThrow();
    const res = resolveAutoModeClassifierTarget(cfg);
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.reason).toBe("provider_missing");
  });

  test("disabled via <provider>/<model> form → throws / disabled", () => {
    const cfg = coreConfig();
    cfg.disabledModels = ["codex/gpt-5.4-mini"];
    expect(() => routeModel(cfg, AUTO_MODE_CLASSIFIER_ALIAS)).toThrow();
    const res = resolveAutoModeClassifierTarget(cfg);
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.reason).toBe("disabled");
  });

  test("disabled via raw model id form → throws / disabled", () => {
    const cfg = coreConfig();
    cfg.disabledModels = ["gpt-5.4-mini"];
    const res = resolveAutoModeClassifierTarget(cfg);
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.reason).toBe("disabled");
    expect(() => routeModel(cfg, AUTO_MODE_CLASSIFIER_ALIAS)).toThrow();
  });

  test("disabled via reserved alias form → throws / disabled", () => {
    const cfg = coreConfig();
    cfg.disabledModels = [AUTO_MODE_CLASSIFIER_ALIAS];
    const res = resolveAutoModeClassifierTarget(cfg);
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.reason).toBe("disabled");
    expect(() => routeModel(cfg, AUTO_MODE_CLASSIFIER_ALIAS)).toThrow();
  });

  test("resolve is deterministic — same config yields the same reason/message twice", () => {
    const cfg = coreConfig();
    delete cfg.autoModeClassifier;
    expect(resolveAutoModeClassifierTarget(cfg)).toEqual(resolveAutoModeClassifierTarget(cfg));
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Group 3 — No model-name-shape guessing: Haiku / Sonnet / Opus ids are NEVER the classifier
// ─────────────────────────────────────────────────────────────────────────────
describe("no name-shape guessing — arbitrary claude ids are not the classifier", () => {
  const nonClassifierIds = [
    "claude-haiku-4-5",
    "claude-haiku-4-5-20251001",
    "claude-3-5-haiku-20241022",
    "claude-3-5-haiku",
    "claude-haiku-",
    "claude-sonnet-4-6",
    "claude-opus-4-8",
    "claude-",
    "default",
  ];

  for (const id of nonClassifierIds) {
    test(`"${id}" does NOT become a classifier route`, () => {
      const r = routeModel(coreConfig(), id);
      expect(r.classifierRoute).toBeFalsy();
      expect(r.routeKind).not.toBe("classifier");
    });
  }

  test("Haiku ids redirect to the default provider's defaultModel (plain client-default), not the target", () => {
    for (const id of ["claude-haiku-4-5", "claude-3-5-haiku-20241022"]) {
      const r = routeModel(coreConfig(), id);
      expect(r.providerName).toBe("codex");
      expect(r.modelId).toBe("gpt-5.5"); // heavyweight defaultModel, NOT gpt-5.4-mini target
      expect(r.routeKind).toBe("client-default");
      expect(r.classifierRoute).toBeFalsy();
    }
  });

  test("case-sensitive: uppercase reserved alias does NOT match", () => {
    const r = routeModel(coreConfig(), AUTO_MODE_CLASSIFIER_ALIAS.toUpperCase());
    expect(r.classifierRoute).toBeFalsy();
    expect(r.routeKind).not.toBe("classifier");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Group 4 — Legacy fields have ZERO runtime effect
// ─────────────────────────────────────────────────────────────────────────────
describe("legacy classifierFallback / classifierModel are inert", () => {
  test("legacy fields present but no autoModeClassifier → reserved alias still fails closed", () => {
    const cfg = coreConfig() as FrogConfig & Record<string, unknown>;
    delete cfg.autoModeClassifier;
    // Inject removed legacy shapes via casts to prove they are ignored at runtime.
    (cfg as Record<string, unknown>).classifierFallback = { provider: "anthropic", model: "claude-haiku-4-5" };
    (cfg.providers.codex as Record<string, unknown>).classifierModel = "gpt-5.4-mini";
    expect(() => routeModel(cfg as FrogConfig, AUTO_MODE_CLASSIFIER_ALIAS)).toThrow();
  });

  test("legacy fields do not make Haiku ids classifier routes", () => {
    const cfg = coreConfig() as FrogConfig;
    (cfg as Record<string, unknown>).classifierFallback = { provider: "anthropic", model: "claude-haiku-4-5" };
    (cfg.providers.codex as Record<string, unknown>).classifierModel = "gpt-5.4-mini";
    const r = routeModel(cfg, "claude-haiku-4-5");
    expect(r.classifierRoute).toBeFalsy();
    expect(r.modelId).toBe("gpt-5.5");
  });

  test("reserved alias resolves ONLY from autoModeClassifier, ignoring legacy fields", () => {
    const cfg = coreConfig();
    // Legacy would have pointed at anthropic; the real target is codex/gpt-5.4-mini.
    (cfg as Record<string, unknown>).classifierFallback = { provider: "anthropic", model: "claude-haiku-4-5" };
    const r = routeModel(cfg, AUTO_MODE_CLASSIFIER_ALIAS);
    expect(r.providerName).toBe("codex");
    expect(r.modelId).toBe("gpt-5.4-mini");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Group 5 — No generic provider fallback on a classifier route (same-provider keys only)
// ─────────────────────────────────────────────────────────────────────────────
describe("classifier route: same-provider key retries only, no fallbackProviders", () => {
  test("fallbackProviders is NOT appended for a classifier route", () => {
    const cfg = coreConfig();
    cfg.fallbackProviders = ["anthropic"];
    const built = buildAttemptContexts(cfg, parsed(AUTO_MODE_CLASSIFIER_ALIAS));
    expect(built.primaryRoute.routeKind).toBe("classifier");
    expect(built.attempts.every(a => a.providerName === "codex")).toBe(true);
    expect(built.attempts.some(a => a.source === "fallback")).toBe(false);
  });

  test("multiple keys on the same target provider DO produce multiple same-provider attempts", () => {
    const cfg = coreConfig();
    cfg.fallbackProviders = ["anthropic"];
    cfg.providers.gw = {
      adapter: "openai-chat",
      baseUrl: "https://gw.example.com",
      authMode: "key",
      apiKey: "k0",
      apiKeys: ["k1"],
      defaultModel: "m-default",
      models: ["m-classifier"],
    };
    cfg.autoModeClassifier = { provider: "gw", model: "m-classifier" };
    const built = buildAttemptContexts(cfg, parsed(AUTO_MODE_CLASSIFIER_ALIAS));
    expect(built.primaryRoute.routeKind).toBe("classifier");
    expect(built.attempts.length).toBe(2);
    expect(built.attempts.every(a => a.providerName === "gw")).toBe(true);
    expect(built.attempts.every(a => a.source === "primary")).toBe(true);
    expect(built.attempts.map(a => a.modelId)).toEqual(["m-classifier", "m-classifier"]);
  });

  test("a NON-classifier route still appends fallbackProviders (control)", () => {
    const cfg = coreConfig();
    cfg.fallbackProviders = ["anthropic"];
    const built = buildAttemptContexts(cfg, parsed("claude-sonnet-4-6"));
    expect(built.primaryRoute.routeKind).not.toBe("classifier");
    expect(built.attempts.some(a => a.source === "fallback" && a.providerName === "anthropic")).toBe(true);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Group 6 — Long-context must NOT override a classifier route
// ─────────────────────────────────────────────────────────────────────────────
describe("long-context protection", () => {
  test("reserved alias with a huge prompt stays a classifier route", () => {
    const cfg = coreConfig();
    cfg.longContext = { thresholdTokens: 10, provider: "anthropic", model: "claude-sonnet-4-6" };
    const route = resolvePrimaryRoute(cfg, parsed(AUTO_MODE_CLASSIFIER_ALIAS, 4000));
    expect(route.routeKind).toBe("classifier");
    expect(route.providerName).toBe("codex");
    expect(route.modelId).toBe("gpt-5.4-mini");
    expect(route.classifierRoute).toBe(true);
  });

  test("control: a plain client-default id with a huge prompt DOES get long-context override", () => {
    const cfg = coreConfig();
    cfg.longContext = { thresholdTokens: 10, provider: "anthropic", model: "claude-sonnet-4-6" };
    const route = resolvePrimaryRoute(cfg, parsed("claude-sonnet-4-6", 4000));
    expect(route.routeKind).toBe("long-context");
  });
});

describe("model-mixing alias collision protection", () => {
  test("reserved classifier alias cannot be claimed by model mixing", () => {
    const cfg = coreConfig();
    cfg.modelMixing = {
      enabled: true,
      aliasId: AUTO_MODE_CLASSIFIER_ALIAS,
      agents: [{ provider: "anthropic", model: "claude-sonnet-4-6" }],
    };
    expect(isModelMixingRequest(cfg, AUTO_MODE_CLASSIFIER_ALIAS)).toBe(false);
    expect(resolvePrimaryRoute(cfg, parsed(AUTO_MODE_CLASSIFIER_ALIAS)).routeKind).toBe("classifier");
    const patchCfg = coreConfig();
    patchCfg.modelMixing = {
      enabled: true,
      aliasId: "frogp/mix",
      agents: [{ provider: "anthropic", model: "claude-sonnet-4-6" }],
    };
    const warnings = applyModelMixingPatch(patchCfg, { aliasId: AUTO_MODE_CLASSIFIER_ALIAS });
    expect(warnings).toEqual([expect.stringContaining("is reserved")]);
    expect(patchCfg.modelMixing?.aliasId).toBe("frogp/mix");
    const paddedWarnings = applyModelMixingPatch(patchCfg, { aliasId: ` ${AUTO_MODE_CLASSIFIER_ALIAS} ` });
    expect(paddedWarnings).toEqual([expect.stringContaining("is reserved")]);
    expect(patchCfg.modelMixing?.aliasId).toBe("frogp/mix");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Group 7 — Other claude-frogp-* ids still fail closed (unchanged)
// ─────────────────────────────────────────────────────────────────────────────
describe("gateway alias namespace still fails closed", () => {
  test("unknown claude-frogp-* id throws (not the reserved alias)", () => {
    expect(() => routeModel(coreConfig(), "claude-frogp-bogus-model")).toThrow();
  });

  test("removed routed model alias still throws", () => {
    expect(() => routeModel(coreConfig(), "claude-frogprogsy-codex-gpt-5-5")).toThrow();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Group 8 — Snapshot reflects the single target + effective (disabled-filtered) models
// ─────────────────────────────────────────────────────────────────────────────
describe("classifierSettingsSnapshot", () => {
  test("returns {providers:[{name,models}], autoModeClassifier:{provider,model}}", () => {
    const snap = classifierSettingsSnapshot(coreConfig());
    expect(snap.autoModeClassifier).toEqual({ provider: "codex", model: "gpt-5.4-mini" });
    const codex = snap.providers.find(p => p.name === "codex")!;
    expect(codex.models).toContain("gpt-5.4-mini");
    expect(codex.models).toContain("gpt-5.5");
    // provider entries carry only name + models (no per-provider classifierModel anymore)
    expect(Object.keys(codex).sort()).toEqual(["models", "name"]);
  });

  test("autoModeClassifier defaults to empty strings when unset", () => {
    const cfg = coreConfig();
    delete cfg.autoModeClassifier;
    const snap = classifierSettingsSnapshot(cfg);
    expect(snap.autoModeClassifier).toEqual({ provider: "", model: "" });
  });

  test("disabled models are filtered out of the effective per-provider list", () => {
    const cfg = coreConfig();
    cfg.disabledModels = ["codex/gpt-5.4-mini"];
    const snap = classifierSettingsSnapshot(cfg);
    const codex = snap.providers.find(p => p.name === "codex")!;
    expect(codex.models).not.toContain("gpt-5.4-mini");
    expect(codex.models).toContain("gpt-5.5");
  });

  test("includes live/effective catalog models and validates against the same view", () => {
    const cfg = coreConfig();
    const effective = [{ provider: "codex", id: "gpt-live-only" }];
    const snap = classifierSettingsSnapshot(cfg, effective);
    expect(snap.providers.find(provider => provider.name === "codex")?.models).toContain("gpt-live-only");
    expect(validateClassifierModel(cfg, "codex", "gpt-live-only", effective)).toBeNull();
  });
});

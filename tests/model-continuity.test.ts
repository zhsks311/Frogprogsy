import { describe, expect, test } from "bun:test";
import {
  buildRetiredTargetIndex,
  normalizeContinuityPolicy,
  qualifiedModelTarget,
  validateContinuityPolicy,
  type ModelContinuityValidationInput,
} from "../src/model-continuity";
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

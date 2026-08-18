import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { materializeModelAliases } from "../src/model-aliases";
import { ContinuityCircuit, type ContinuityReason, type ModelContinuityReference } from "../src/model-continuity";
import type { SelectedModelCatalog } from "../src/model-catalog-runtime";
import type { RuntimeConfigState } from "../src/runtime-config-state";
import { __requestLogTest } from "../src/server";
import type { FrogConfig, ModelContinuityPolicy } from "../src/types";

interface ContinuityReport {
  policies: Record<string, ModelContinuityPolicy>;
  references: ModelContinuityReference[];
  circuits: Array<{ primary: string; reason: ContinuityReason; retryAt: number }>;
}

const originalHome = process.env.FROGPROGSY_HOME;
let home: string;

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "frogp-continuity-api-"));
  process.env.FROGPROGSY_HOME = home;
});

afterEach(() => {
  if (originalHome === undefined) delete process.env.FROGPROGSY_HOME;
  else process.env.FROGPROGSY_HOME = originalHome;
  rmSync(home, { recursive: true, force: true });
});

function config(): FrogConfig {
  return {
    port: 3764,
    defaultProvider: "work",
    disabledModels: ["work/disabled"],
    providers: {
      work: {
        adapter: "anthropic",
        baseUrl: "https://private-upstream.invalid",
        catalogProviderId: "anthropic",
        apiKey: "continuity-api-secret",
        defaultModel: "old",
        models: ["old", "new", "disabled"],
        liveModels: false,
      },
      noauth: {
        adapter: "anthropic",
        baseUrl: "https://noauth.invalid",
        defaultModel: "login",
        models: ["login"],
        liveModels: false,
      },
    },
    longContext: { thresholdTokens: 100_000, provider: "work", model: "disabled" },
    subagentModels: ["work/new"],
    modelContinuity: {
      "work/old": { fallbacks: ["work/new"], automatic: "retired" },
      "work/new": { fallbacks: [], automatic: "off" },
    },
  };
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
      providers: [{
        id: "anthropic",
        retiredModels: ["old"],
        models: [{ id: "new" }, { id: "disabled" }],
      }],
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

function request(
  method: "GET" | "POST",
  body: unknown,
  configValue: FrogConfig,
  deps: Parameters<typeof __requestLogTest.handleManagementAPI>[3] = {},
  origin = "http://localhost:3764",
): Promise<Response | null> {
  const url = new URL("http://localhost:3764/api/model-continuity");
  return __requestLogTest.handleManagementAPI(
    new Request(url, {
      method,
      headers: method === "POST"
        ? { Origin: origin, "content-type": "application/json" }
        : undefined,
      body: method === "POST" ? JSON.stringify(body) : undefined,
    }),
    url,
    configValue,
    { catalog: catalog(), ...deps },
  );
}

function rawPost(
  body: string,
  configValue: FrogConfig,
  deps: Parameters<typeof __requestLogTest.handleManagementAPI>[3] = {},
): Promise<Response | null> {
  const url = new URL("http://localhost:3764/api/model-continuity");
  return __requestLogTest.handleManagementAPI(
    new Request(url, {
      method: "POST",
      headers: { Origin: "http://localhost:3764", "content-type": "application/json" },
      body,
    }),
    url,
    configValue,
    { catalog: catalog(), ...deps },
  );
}

function severity(status: ModelContinuityReference["status"]): number {
  if (status === "retired") return 0;
  if (status === "policy_invalid" || status === "authentication_required") return 1;
  return 2;
}

describe("model continuity management report", () => {
  test("returns sorted public references, policies, and unexpired circuit state only", async () => {
    const circuit = new ContinuityCircuit();
    circuit.open("work/z", "http_5xx", 1_000);
    circuit.open("work/a", "http_429", 2_000);
    circuit.open("work/expired", "http_404", -30_000);

    const response = await request("GET", undefined, config(), {
      continuityCircuit: circuit,
      now: () => 10_000,
    });

    expect(response?.status).toBe(200);
    const report = await response!.json() as ContinuityReport;
    expect(Object.keys(report).sort()).toEqual(["circuits", "policies", "references"]);
    expect(report.policies).toEqual({
      "work/new": { fallbacks: [], automatic: "off" },
      "work/old": { fallbacks: ["work/new"], automatic: "retired" },
    });
    expect(report.circuits).toEqual([
      { primary: "work/a", reason: "http_429", retryAt: 32_000 },
      { primary: "work/z", reason: "http_5xx", retryAt: 31_000 },
    ]);

    expect(report.references[0]).toMatchObject({
      kind: "provider-default",
      status: "retired",
      primary: "work/old",
      automaticEligible: true,
    });
    const expectedReferenceFields = [
      "automaticEligible",
      "id",
      "kind",
      "label",
      "policy",
      "primary",
      "status",
      "supportStatus",
    ];
    const referenceKinds = [
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
    ];
    for (const reference of report.references) {
      expect(Object.keys(reference).sort()).toEqual(expectedReferenceFields);
      expect(referenceKinds).toContain(reference.kind);
      expect(["ready", "retired", "authentication_required", "policy_invalid"]).toContain(reference.status);
      expect(["validated", "discovered", "unknown"]).toContain(reference.supportStatus);
      expect(["off", "retired", "transient", "all"]).toContain(reference.policy.automatic);
    }
    for (let index = 1; index < report.references.length; index += 1) {
      const previous = report.references[index - 1]!;
      const current = report.references[index]!;
      const previousKey = [severity(previous.status), previous.label, previous.id];
      const currentKey = [severity(current.status), current.label, current.id];
      expect(previousKey.join("\u0000") <= currentKey.join("\u0000")).toBeTrue();
    }

    const serialized = JSON.stringify(report);
    expect(serialized).not.toContain("continuity-api-secret");
    expect(serialized).not.toContain("private-upstream.invalid");
    expect(serialized).not.toContain(home);
    expect(serialized).not.toContain("target");
    expect(serialized).not.toContain("until");
  });
});

describe("model continuity management actions", () => {
  test("set validates an exact policy and persists exactly once without refreshing", async () => {
    const configValue = config();
    const saved: FrogConfig[] = [];
    let refreshes = 0;

    const response = await request("POST", {
      action: "set",
      primary: "work/new",
      fallbacks: ["noauth/login"],
      automatic: "transient",
    }, configValue, {
      saveConfig: value => { saved.push(structuredClone(value)); },
      refreshClaudeCodeCatalog: async () => { refreshes += 1; },
    });

    expect(response?.status).toBe(200);
    expect(saved).toHaveLength(1);
    expect(saved[0]!.modelContinuity?.["work/new"]).toEqual({
      fallbacks: ["noauth/login"],
      automatic: "transient",
    });
    expect(refreshes).toBe(0);
  });

  test("set deletes the off-and-empty entry and persists exactly once", async () => {
    const configValue = config();
    let saves = 0;

    const response = await request("POST", {
      action: "set",
      primary: "work/new",
      fallbacks: [],
      automatic: "off",
    }, configValue, {
      saveConfig: () => { saves += 1; },
      refreshClaudeCodeCatalog: async () => { throw new Error("set must not refresh"); },
    });

    expect(response?.status).toBe(200);
    expect(configValue.modelContinuity?.["work/new"]).toBeUndefined();
    expect(saves).toBe(1);
  });

  test("classifier reference rejects automatic policy while the same ordinary route remains eligible", async () => {
    const classifierConfig = config();
    classifierConfig.providers.work!.defaultModel = "new";
    classifierConfig.autoModeClassifier = { provider: "work", model: "new" };
    let saves = 0;
    const deps = { saveConfig: () => { saves += 1; } };

    const rejected = await request("POST", {
      action: "set",
      referenceId: "classifier",
      primary: "work/new",
      fallbacks: ["noauth/login"],
      automatic: "all",
    }, classifierConfig, deps);
    expect(rejected?.status).toBe(400);
    expect(await rejected!.json()).toMatchObject({ code: "automatic_ineligible" });
    expect(saves).toBe(0);

    const accepted = await request("POST", {
      action: "set",
      primary: "work/new",
      fallbacks: ["noauth/login"],
      automatic: "all",
    }, classifierConfig, deps);
    expect(accepted?.status).toBe(200);
    expect(classifierConfig.modelContinuity?.["work/new"]?.automatic).toBe("all");
    expect(saves).toBe(1);

    const reportResponse = await request("GET", undefined, classifierConfig);
    expect(reportResponse?.status).toBe(200);
    const report = await reportResponse!.json() as ContinuityReport;
    expect(report.references.find(reference => reference.id === "provider-default:work")?.status).toBe("ready");
    expect(report.references.find(reference => reference.id === "classifier")?.status).toBe("ready");
  });

  test("set rejects disabled and retired fallback targets without persisting", async () => {
    const configValue = config();
    let saves = 0;
    for (const fallback of ["work/disabled", "work/old"]) {
      const response = await request("POST", {
        action: "set",
        primary: "work/new",
        fallbacks: [fallback],
        automatic: "off",
      }, configValue, { saveConfig: () => { saves += 1; } });
      expect(response?.status).toBe(400);
      expect(await response!.json()).toMatchObject({ code: "invalid_policy" });
    }
    expect(saves).toBe(0);
  });

  test("replace returns 409 for a stale owner and persists then refreshes once after success", async () => {
    const configValue = config();
    let saves = 0;
    let refreshes = 0;
    const deps = {
      saveConfig: () => { saves += 1; },
      refreshClaudeCodeCatalog: async () => { refreshes += 1; },
    };

    const stale = await request("POST", {
      action: "replace",
      referenceId: "long-context",
      expectedPrimary: "work/old",
      replacement: "work/new",
    }, configValue, deps);
    expect(stale?.status).toBe(409);
    expect(await stale!.json()).toMatchObject({ code: "stale_reference" });
    expect(saves).toBe(0);
    expect(refreshes).toBe(0);

    const replaced = await request("POST", {
      action: "replace",
      referenceId: "long-context",
      expectedPrimary: "work/disabled",
      replacement: "work/new",
    }, configValue, deps);
    expect(replaced?.status).toBe(200);
    expect(configValue.longContext).toEqual({ thresholdTokens: 100_000, provider: "work", model: "new" });
    expect(saves).toBe(1);
    expect(refreshes).toBe(1);
  });

  test("replace repairs an active reference after its provider was removed", async () => {
    const configValue = config();
    configValue.longContext = {
      thresholdTokens: 100_000,
      provider: "removed",
      model: "old",
    };
    let saves = 0;
    let refreshes = 0;

    const response = await request("POST", {
      action: "replace",
      referenceId: "long-context",
      expectedPrimary: "removed/old",
      replacement: "work/new",
    }, configValue, {
      saveConfig: () => { saves += 1; },
      refreshClaudeCodeCatalog: async () => { refreshes += 1; },
    });

    expect(response?.status).toBe(200);
    expect(configValue.longContext).toEqual({
      thresholdTokens: 100_000,
      provider: "work",
      model: "new",
    });
    expect(saves).toBe(1);
    expect(refreshes).toBe(1);
  });

  test("replace rejects dormant owners that are absent from the current reference inventory", async () => {
    const cases: Array<{ referenceId: string; configure(configValue: FrogConfig): void }> = [
      {
        referenceId: "long-context",
        configure(configValue) {
          configValue.longContext = { provider: "work", model: "disabled" };
        },
      },
      {
        referenceId: "mix-coordinator",
        configure(configValue) {
          configValue.modelMixing = {
            enabled: false,
            coordinator: { provider: "work", model: "disabled" },
          };
        },
      },
      {
        referenceId: "web-search-helper",
        configure(configValue) {
          configValue.webSearchFallback = {
            enabled: false,
            provider: "work",
            model: "disabled",
          };
        },
      },
      {
        referenceId: "image-helper",
        configure(configValue) {
          configValue.imageFallback = {
            enabled: false,
            provider: "work",
            model: "disabled",
          };
        },
      },
    ];

    for (const item of cases) {
      const configValue = config();
      item.configure(configValue);
      const before = structuredClone(configValue);
      let saves = 0;
      let refreshes = 0;
      const response = await request("POST", {
        action: "replace",
        referenceId: item.referenceId,
        expectedPrimary: "work/disabled",
        replacement: "work/new",
      }, configValue, {
        saveConfig: () => { saves += 1; },
        refreshClaudeCodeCatalog: async () => { refreshes += 1; },
      });

      expect(response?.status).toBe(400);
      expect(await response!.json()).toMatchObject({ code: "invalid_reference" });
      expect(configValue).toEqual(before);
      expect(saves).toBe(0);
      expect(refreshes).toBe(0);
    }
  });

  test("replace keeps the active gateway-alias rejection owned by the replacement helper", async () => {
    const configValue = config();
    const alias = materializeModelAliases([{ provider: "work", model: "new" }])[0]!;
    let saves = 0;
    let refreshes = 0;
    const response = await request("POST", {
      action: "replace",
      referenceId: `gateway-alias:${alias.alias}`,
      expectedPrimary: "stale/value",
      replacement: "work/disabled",
    }, configValue, {
      saveConfig: () => { saves += 1; },
      refreshClaudeCodeCatalog: async () => { refreshes += 1; },
    });

    expect(response?.status).toBe(400);
    expect(await response!.json()).toMatchObject({ code: "invalid_replacement" });
    expect(saves).toBe(0);
    expect(refreshes).toBe(0);
  });

  test("strict action parsing rejects malformed or unknown fields without side effects", async () => {
    const configValue = config();
    let saves = 0;
    let refreshes = 0;
    const deps = {
      saveConfig: () => { saves += 1; },
      refreshClaudeCodeCatalog: async () => { refreshes += 1; },
    };
    const cases: Array<{ body: unknown; code: string }> = [
      { body: null, code: "invalid_request" },
      { body: { action: "remove" }, code: "invalid_action" },
      { body: { action: "set", primary: "work/new", fallbacks: [], automatic: "off", extra: true }, code: "invalid_request" },
      { body: { action: "set", primary: "work/new", fallbacks: [7], automatic: "off" }, code: "invalid_request" },
      { body: { action: "set", primary: "work/new", fallbacks: [], automatic: "sometimes" }, code: "invalid_request" },
      { body: { action: "replace", referenceId: "long-context", expectedPrimary: "work/disabled", replacement: "work/new", path: home }, code: "invalid_request" },
      { body: { action: "replace", referenceId: "long-context", expectedPrimary: "work/disabled" }, code: "invalid_request" },
    ];

    for (const item of cases) {
      const response = await request("POST", item.body, configValue, deps);
      expect(response?.status).toBe(400);
      expect(await response!.json()).toMatchObject({ code: item.code });
    }
    const malformed = await rawPost("{", configValue, deps);
    expect(malformed?.status).toBe(400);
    expect(await malformed!.json()).toMatchObject({ code: "invalid_json" });
    expect(saves).toBe(0);
    expect(refreshes).toBe(0);
  });

  test("continuity actions skip common OAuth recovery before parsing and persist only the valid action", async () => {
    const configValue = config();
    let restores = 0;
    let saves = 0;
    let refreshes = 0;
    const deps = {
      restoreOAuthProviderConfigs(value: FrogConfig) {
        restores += 1;
        value.providers.recovered = {
          adapter: "openai-chat",
          baseUrl: "https://recovered.invalid",
          authMode: "oauth",
        };
        return true;
      },
      saveConfig: () => { saves += 1; },
      refreshClaudeCodeCatalog: async () => { refreshes += 1; },
    };

    const malformed = await rawPost("{", configValue, deps);
    expect(malformed?.status).toBe(400);
    const unknown = await request("POST", { action: "unknown" }, configValue, deps);
    expect(unknown?.status).toBe(400);
    expect(restores).toBe(0);
    expect(saves).toBe(0);
    expect(refreshes).toBe(0);
    expect(configValue.providers.recovered).toBeUndefined();

    const valid = await request("POST", {
      action: "set",
      primary: "work/new",
      fallbacks: ["noauth/login"],
      automatic: "transient",
    }, configValue, deps);
    expect(valid?.status).toBe(200);
    expect(restores).toBe(0);
    expect(saves).toBe(1);
    expect(refreshes).toBe(0);
    expect(configValue.providers.recovered).toBeUndefined();
  });

  test("set restores persisted and effective state when saving throws", async () => {
    const configValue = config();
    const before = structuredClone(configValue);
    let saves = 0;
    let refreshes = 0;
    let runtimeState: RuntimeConfigState | undefined;
    const response = await request("POST", {
      action: "set",
      primary: "work/new",
      fallbacks: ["noauth/login"],
      automatic: "transient",
    }, configValue, {
      saveConfig: () => {
        saves += 1;
        throw new Error(`cannot save ${home}/config.json`);
      },
      refreshClaudeCodeCatalog: async () => { refreshes += 1; },
      captureState: state => { runtimeState = state; },
    });

    expect(response?.status).toBe(500);
    const error = await response!.json();
    expect(error).toEqual({
      error: "model continuity settings could not be saved",
      code: "persist_failed",
    });
    expect(JSON.stringify(error)).not.toContain(home);
    expect(configValue).toEqual(before);
    expect(runtimeState?.persisted).toBe(configValue);
    expect(runtimeState?.persisted).toEqual(before);
    expect(runtimeState?.effective).toEqual(before);
    expect(saves).toBe(1);
    expect(refreshes).toBe(0);
  });

  test("replace restores the owner and does not refresh when saving throws", async () => {
    const configValue = config();
    const before = structuredClone(configValue);
    let saves = 0;
    let refreshes = 0;
    let runtimeState: RuntimeConfigState | undefined;
    const response = await request("POST", {
      action: "replace",
      referenceId: "long-context",
      expectedPrimary: "work/disabled",
      replacement: "work/new",
    }, configValue, {
      saveConfig: () => {
        saves += 1;
        throw new Error(`cannot save ${home}/config.json`);
      },
      refreshClaudeCodeCatalog: async () => { refreshes += 1; },
      captureState: state => { runtimeState = state; },
    });

    expect(response?.status).toBe(500);
    const error = await response!.json();
    expect(error).toEqual({
      error: "model continuity settings could not be saved",
      code: "persist_failed",
    });
    expect(JSON.stringify(error)).not.toContain(home);
    expect(configValue).toEqual(before);
    expect(runtimeState?.persisted).toBe(configValue);
    expect(runtimeState?.persisted).toEqual(before);
    expect(runtimeState?.effective).toEqual(before);
    expect(saves).toBe(1);
    expect(refreshes).toBe(0);
  });

  test("non-local mutation is rejected by the existing origin guard", async () => {
    const configValue = config();
    let saves = 0;
    let refreshes = 0;
    const response = await request("POST", {
      action: "set",
      primary: "work/new",
      fallbacks: [],
      automatic: "off",
    }, configValue, {
      saveConfig: () => { saves += 1; },
      refreshClaudeCodeCatalog: async () => { refreshes += 1; },
    }, "https://evil.example");

    expect(response?.status).toBe(403);
    expect(saves).toBe(0);
    expect(refreshes).toBe(0);
  });
});

import { describe, expect, test } from "bun:test";
import { __requestLogTest } from "../src/server";
import type { FrogConfig, FrogProviderConfig } from "../src/types";

function baseConfig(): FrogConfig {
  return {
    port: 3764,
    defaultProvider: "custom",
    modelCatalogConfigVersion: 1,
    providers: {
      custom: { adapter: "openai-chat", baseUrl: "https://custom.invalid", models: ["mine"] },
    },
  };
}

async function addProvider(
  config: FrogConfig,
  body: { name: string; catalogId?: string; provider: FrogProviderConfig },
): Promise<{ response: Response; saved: FrogConfig[] }> {
  const saved: FrogConfig[] = [];
  const response = await __requestLogTest.handleManagementAPI(
    new Request("http://localhost/api/providers", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    }),
    new URL("http://localhost/api/providers"),
    config,
    {
      saveConfig: value => { saved.push(structuredClone(value)); },
      refreshClaudeCodeCatalog: async () => {},
    },
  );
  if (!response) throw new Error("provider management route was not handled");
  return { response, saved };
}

describe("provider REST persistence boundary", () => {
  test("a renamed catalog preset stores the original catalog id and only user-owned fields", async () => {
    const config = baseConfig();
    const credentials = {
      apiKey: "primary-secret",
      apiKeys: ["secondary-secret"],
      headers: { "x-user-auth": "credential-value" },
    };

    const { response, saved } = await addProvider(config, {
      name: "work-openai",
      catalogId: "openai-apikey",
      provider: {
        adapter: "openai-responses",
        baseUrl: "https://api.openai.com/v1",
        authMode: "key",
        defaultModel: "user-selected",
        userModels: ["private-preview"],
        liveModels: true,
        models: ["gpt-5.5", "private-preview"],
        contextWindow: 999_999,
        modelCapabilities: { "gpt-5.5": { input: ["text"] } },
        noTemperatureModels: ["gpt-5.5"],
        ...credentials,
      },
    });

    expect(response.status).toBe(200);
    expect(saved).toHaveLength(1);
    expect(saved[0].providers["work-openai"]).toEqual({
      adapter: "openai-responses",
      baseUrl: "https://api.openai.com/v1",
      authMode: "key",
      catalogProviderId: "openai-apikey",
      defaultModel: "user-selected",
      userModels: ["private-preview"],
      liveModels: true,
      contextWindow: 999_999,
      modelCapabilities: { "gpt-5.5": { input: ["text"] } },
      noTemperatureModels: ["gpt-5.5"],
      ...credentials,
    });
  });

  test("a fixed allowlist remains byte-equal when saved from a catalog preset", async () => {
    const config = baseConfig();
    const provider: FrogProviderConfig = {
      adapter: "anthropic",
      baseUrl: "https://api.code.umans.ai",
      authMode: "key",
      apiKey: "secret",
      liveModels: false,
      defaultModel: "umans-glm-5.1",
      models: ["umans-glm-5.1", "private-fixed"],
      modelContextWindows: { "private-fixed": 123_456 },
    };
    const beforeBytes = JSON.stringify(provider);

    const { response, saved } = await addProvider(config, {
      name: "fixed-umans",
      catalogId: "umans",
      provider,
    });

    expect(response.status).toBe(200);
    const { catalogProviderId, ...stored } = saved[0].providers["fixed-umans"];
    expect(catalogProviderId).toBe("umans");
    expect(JSON.stringify(stored)).toBe(beforeBytes);
  });

  test("catalog provider round-trip preserves omitted user settings and credentials", async () => {
    const config = baseConfig();
    config.disabledModels = ["work-openai/user-disabled"];
    config.providers["work-openai"] = {
      adapter: "openai-responses",
      baseUrl: "https://api.openai.com/v1",
      authMode: "key",
      catalogProviderId: "openai-apikey",
      apiKey: "primary-secret",
      apiKeys: ["secondary-secret"],
      headers: { "x-user-auth": "credential-value" },
      defaultModel: "private-default",
      userModels: ["private-default"],
      liveModels: true,
      contextWindow: 777_777,
      modelContextWindows: { "private-default": 555_555 },
      modelCapabilities: { "private-default": { input: ["text", "image"] } },
      reasoningEfforts: ["high"],
      modelReasoningEfforts: { "private-default": ["xhigh"] },
      reasoningEffortMap: { xhigh: "max" },
      modelReasoningEffortMap: { "private-default": { xhigh: "max" } },
      noReasoningModels: ["no-reasoning"],
      noTemperatureModels: ["no-temperature"],
      noTopPModels: ["no-top-p"],
      noPenaltyModels: ["no-penalty"],
      autoToolChoiceOnlyModels: ["auto-only"],
      preserveReasoningContentModels: ["private-default"],
      escapeBuiltinToolNames: true,
    };
    const before = structuredClone(config.providers["work-openai"]);

    const { response, saved } = await addProvider(config, {
      name: "work-openai",
      catalogId: "openai-apikey",
      provider: {
        adapter: "openai-responses",
        baseUrl: "https://api.openai.com/v1",
        modelCapabilities: { "private-default": { input: ["text"] } },
        noTemperatureModels: [],
      },
    });

    expect(response.status).toBe(200);
    expect(saved[0].disabledModels).toEqual(["work-openai/user-disabled"]);
    expect(saved[0].providers["work-openai"]).toEqual({
      ...before,
      modelCapabilities: { "private-default": { input: ["text"] } },
      noTemperatureModels: [],
    });
  });

  test("switching catalog identity does not inherit credentials or overrides from the previous provider", async () => {
    const config = baseConfig();
    config.providers.gateway = {
      adapter: "anthropic",
      baseUrl: "https://api.code.umans.ai",
      authMode: "key",
      catalogProviderId: "umans",
      apiKey: "umans-secret",
      apiKeys: ["umans-secondary"],
      headers: { "x-umans-auth": "keep-only-for-umans" },
      defaultModel: "umans-private",
      userModels: ["umans-private"],
      liveModels: true,
      contextWindow: 777_777,
      noTemperatureModels: ["umans-private"],
    };

    const { response, saved } = await addProvider(config, {
      name: "gateway",
      catalogId: "openai-apikey",
      provider: {
        adapter: "openai-responses",
        baseUrl: "https://api.openai.com/v1",
      },
    });

    expect(response.status).toBe(200);
    expect(saved[0].providers.gateway).toEqual({
      adapter: "openai-responses",
      baseUrl: "https://api.openai.com/v1",
      authMode: "key",
      catalogProviderId: "openai-apikey",
      defaultModel: "gpt-5.5",
    });
  });

  test("a renamed provider without catalogId remains custom", async () => {
    const config = baseConfig();
    const provider: FrogProviderConfig = {
      adapter: "anthropic",
      baseUrl: "https://api.code.umans.ai",
      apiKey: "custom-secret",
      models: ["custom-model"],
    };

    const { response, saved } = await addProvider(config, { name: "renamed-umans", provider });

    expect(response.status).toBe(200);
    expect(saved[0].providers["renamed-umans"]).toEqual(provider);
    expect(saved[0].providers["renamed-umans"].catalogProviderId).toBeUndefined();
  });
});

describe("model catalog management API", () => {
  const selectedCatalog = {
    document: {
      schemaVersion: 1 as const,
      catalogRevision: 42,
      catalogDigest: "a".repeat(64),
      sourceCommit: "1234567890abcdef1234567890abcdef12345678",
      generatedAt: "2026-08-12T10:00:00.000Z",
      minFrogprogsyVersion: "0.0.0",
      providers: [],
    },
    status: {
      source: "remote" as const,
      catalogRevision: 42,
      catalogDigest: "a".repeat(64),
      sourceCommit: "1234567890abcdef1234567890abcdef12345678",
      generatedAt: "2026-08-12T10:00:00.000Z",
      refreshedAt: "2026-08-12T10:30:00.000Z",
      skippedRecords: 2,
      warnings: [
        "Remote model catalog refresh failed; https://private.invalid/catalog?token=secret remains active.",
        "Catalog digest validation failed. Authorization: Bearer secret",
        "Provider future requires a newer Frogprogsy version at /Users/private/cache.json.",
      ],
    },
  };

  test("adds support and catalog provenance to every model row without changing the array shape", async () => {
    const config: FrogConfig = {
      ...baseConfig(),
      providers: {
        managed: {
          adapter: "openai-chat",
          baseUrl: "https://models.invalid/v1",
          catalogProviderId: "managed",
          models: ["validated-model", "discovered-model"],
          userModels: ["discovered-model"],
        },
        fixed: {
          adapter: "openai-chat",
          baseUrl: "https://fixed.invalid/v1",
          models: ["legacy-fixed"],
          liveModels: false,
        },
      },
    };
    const response = await __requestLogTest.handleManagementAPI(
      new Request("http://localhost/api/models"),
      new URL("http://localhost/api/models"),
      config,
      { effectiveConfig: config, catalog: selectedCatalog },
    );

    expect(response?.status).toBe(200);
    const rows = await response!.json() as Array<Record<string, unknown>>;
    expect(Array.isArray(rows)).toBe(true);
    expect(rows.find(row => row.id === "validated-model")).toMatchObject({
      supportStatus: "validated",
      catalogSource: "remote",
      catalogRevision: 42,
      catalogSourceCommit: "1234567890abcdef1234567890abcdef12345678",
      catalogRefreshedAt: "2026-08-12T10:30:00.000Z",
    });
    expect(rows.find(row => row.id === "discovered-model")?.supportStatus).toBe("discovered");
    expect(rows.find(row => row.id === "legacy-fixed")?.supportStatus).toBe("unknown");
    expect(rows.every(row => ["remote", "cached", "bundled"].includes(String(row.catalogSource)))).toBe(true);
  });

  test("returns privacy-safe runtime status with generalized warning causes", async () => {
    const response = await __requestLogTest.handleManagementAPI(
      new Request("http://localhost/api/model-catalog/status"),
      new URL("http://localhost/api/model-catalog/status"),
      baseConfig(),
      { catalog: selectedCatalog },
    );

    expect(response?.status).toBe(200);
    const status = await response!.json() as Record<string, unknown>;
    expect(status).toMatchObject({
      source: "remote",
      catalogRevision: 42,
      sourceCommit: "1234567890abcdef1234567890abcdef12345678",
      refreshedAt: "2026-08-12T10:30:00.000Z",
      skippedRecords: 2,
      warnings: {
        count: 3,
        causes: ["refresh_failed", "validation_failed", "incompatible_records"],
      },
    });
    const serialized = JSON.stringify(status);
    expect(serialized).not.toContain("private.invalid");
    expect(serialized).not.toContain("token=secret");
    expect(serialized).not.toContain("Authorization");
    expect(serialized).not.toContain("/Users/private");
  });
});

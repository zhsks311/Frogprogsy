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

import { describe, expect, test } from "bun:test";
import { providerConfigFromKeyLoginProvider, resolveKeyLoginRequest } from "../src/oauth/login-cli";

describe("OpenAI login alias", () => {
  test("frogp login openai resolves to the API-key OpenAI provider and saves as openai", () => {
    const request = resolveKeyLoginRequest("openai");

    expect(request).toEqual({ lookupName: "openai-apikey", saveName: "openai", alias: true });

    const provider = providerConfigFromKeyLoginProvider(request!.lookupName, "sk-test");
    expect(provider).toMatchObject({
      adapter: "openai-responses",
      baseUrl: "https://api.openai.com/v1",
      apiKey: "sk-test",
      authMode: "key",
      catalogProviderId: "openai-apikey",
      defaultModel: "gpt-5.5",
    });
  });

  test("explicit openai-apikey login remains available", () => {
    expect(resolveKeyLoginRequest("openai-apikey")).toEqual({
      lookupName: "openai-apikey",
      saveName: "openai-apikey",
      alias: false,
    });
  });
});

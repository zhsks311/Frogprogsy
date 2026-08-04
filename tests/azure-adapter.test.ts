import { describe, expect, test } from "bun:test";
import { createAzureAdapter } from "../src/adapters/azure";
import { parseRequest } from "../src/responses/parser";
import type { FrogProviderConfig } from "../src/types";

/**
 * The Azure adapter wraps the OpenAI Responses adapter and only rewrites the wire envelope:
 * Azure authenticates with an `api-key` header instead of a Bearer token, and an endpoint the inner
 * adapter did not resolve to a `/v1/` path (Azure's deployment-style URL) needs an explicit
 * `api-version` query parameter.
 */

const BASE_URL = "https://example.openai.azure.com/openai/deployments/gpt-5";

const keyProvider: FrogProviderConfig = { adapter: "azure", baseUrl: BASE_URL, apiKey: "azure-key" };
const deploymentProvider: FrogProviderConfig = { ...keyProvider, authMode: "forward" };

function build(provider: FrogProviderConfig) {
  const parsed = parseRequest({ model: "gpt-5", input: "hi", stream: false });
  return createAzureAdapter(provider).buildRequest(parsed);
}

describe("Azure OpenAI adapter", () => {
  test("is a native relay named azure-openai", () => {
    const adapter = createAzureAdapter(keyProvider);
    expect(adapter.name).toBe("azure-openai");
    expect(adapter.nativeRelay).toBe(true);
  });

  test("authenticates with the api-key header instead of Authorization", () => {
    const request = build(keyProvider);
    expect(request.headers["api-key"]).toBe("azure-key");
    expect(request.headers.Authorization).toBeUndefined();
    expect(request.method).toBe("POST");
    expect(JSON.parse(request.body as string)).toMatchObject({ model: "gpt-5" });
  });

  test("keyless providers keep whatever the inner Responses adapter produced", () => {
    const request = build({ ...keyProvider, apiKey: undefined });
    expect(request.headers["api-key"]).toBeUndefined();
  });

  test("a /v1/ endpoint resolved by the inner adapter is left alone", () => {
    expect(build(keyProvider).url).toBe(`${BASE_URL}/v1/responses`);
  });

  test("appends the default api-version to a deployment endpoint", () => {
    expect(build(deploymentProvider).url).toBe(`${BASE_URL}/responses?api-version=2025-04-01-preview`);
  });

  test("a configured api-version header wins over the default", () => {
    const request = build({ ...deploymentProvider, headers: { "api-version": "2024-10-21" } });
    expect(request.url).toBe(`${BASE_URL}/responses?api-version=2024-10-21`);
    expect(request.headers["api-version"]).toBe("2024-10-21");
  });

  test("a trailing slash on the base URL does not duplicate the path separator", () => {
    expect(build({ ...deploymentProvider, baseUrl: `${BASE_URL}/` }).url)
      .toBe(`${BASE_URL}/responses?api-version=2025-04-01-preview`);
  });
});

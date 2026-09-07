import { describe, expect, test } from "bun:test";
import { createAnthropicAdapter } from "../src/adapters/anthropic";
import { parseMessagesRequest } from "../src/messages/parser";
import type { FrogProviderConfig } from "../src/types";

const provider = { adapter: "anthropic", baseUrl: "https://example.test", apiKey: "key" };

/** Build a parsed /v1/messages request the way the data plane does. */
function parsedRequest(body: Record<string, unknown>) {
  return parseMessagesRequest({
    model: "claude-opus-4-8",
    messages: [{ role: "user", content: "Explain quicksort in detail." }],
    stream: false,
    ...body,
  });
}

function buildBody(body: Record<string, unknown>, config: FrogProviderConfig = provider): Record<string, unknown> {
  const adapter = createAnthropicAdapter(config);
  const request = adapter.buildRequest(parsedRequest(body)) as { body: string };
  return JSON.parse(request.body) as Record<string, unknown>;
}

describe("Anthropic max_tokens caller-cap preservation (Bug A)", () => {
  test("max_tokens 20 with thinking enabled keeps cap 20 and omits thinking", () => {
    const body = buildBody({ max_tokens: 20, thinking: { type: "enabled", budget_tokens: 4096 }, temperature: 0.5 });
    expect(body.max_tokens).toBe(20);
    expect(body.thinking).toBeUndefined();
    // Without thinking the request stays a normal capped call: sampling params survive.
    expect(body.temperature).toBe(0.5);
  });

  test("max_tokens 1024 with thinking enabled keeps cap and omits thinking", () => {
    const body = buildBody({ max_tokens: 1024, thinking: { type: "enabled", budget_tokens: 8192 } });
    expect(body.max_tokens).toBe(1024);
    expect(body.thinking).toBeUndefined();
  });

  test("max_tokens 1025 omits thinking instead of starving visible output", () => {
    const body = buildBody({ max_tokens: 1025, thinking: { type: "enabled", budget_tokens: 8192 } });
    expect(body.max_tokens).toBe(1025);
    expect(body.thinking).toBeUndefined();
  });

  test("omitted max_tokens with medium reasoning uses default 8192 and budget 4096", () => {
    const body = buildBody({ thinking: { type: "enabled", budget_tokens: 8192 }, temperature: 0.7, top_p: 0.9 });
    expect(body.max_tokens).toBe(8192);
    expect(body.thinking).toEqual({ type: "enabled", budget_tokens: 4096 });
    // Extended thinking disallows sampling params.
    expect(body.temperature).toBeUndefined();
    expect(body.top_p).toBeUndefined();
  });

  test("max_tokens 32000 with high reasoning keeps cap and budget 16384", () => {
    const body = buildBody({ max_tokens: 32_000, thinking: { type: "enabled", budget_tokens: 16_384 } });
    expect(body.max_tokens).toBe(32_000);
    expect(body.thinking).toEqual({ type: "enabled", budget_tokens: 16_384 });
  });

  test("threshold cap 5120 sends thinking with the minimum viable budget", () => {
    const body = buildBody({ max_tokens: 5120, thinking: { type: "enabled", budget_tokens: 1024 } });
    expect(body.max_tokens).toBe(5120);
    expect(body.thinking).toEqual({ type: "enabled", budget_tokens: 1024 });
  });

  test("thinking budget always satisfies max_tokens > budget >= 1024 with a 4096 visible floor", () => {
    for (const cap of [5120, 8192, 12_000, 32_000, 64_000]) {
      const body = buildBody({ max_tokens: cap, thinking: { type: "enabled", budget_tokens: 32_000 } });
      const thinking = body.thinking as { budget_tokens: number };
      expect(body.max_tokens).toBe(cap);
      expect(thinking.budget_tokens).toBeGreaterThanOrEqual(1024);
      expect((body.max_tokens as number) - thinking.budget_tokens).toBeGreaterThanOrEqual(4096);
    }
  });
});

describe("Anthropic explicit model effort and request restrictions", () => {
  const model = "claude-fable-5-1";
  const adaptiveProvider: FrogProviderConfig = {
    ...provider,
    catalogProviderId: "anthropic",
    modelReasoningEfforts: { [model]: ["low", "medium", "high", "xhigh"] },
    noTemperatureModels: [model],
    noTopPModels: [model],
    autoToolChoiceOnlyModels: [model],
  };
  const tools = [{ name: "get_weather", input_schema: { type: "object" } }];

  test("sends xhigh effort without manual thinking, sampling, or forced tool choice", () => {
    const signedThinking = { type: "thinking", thinking: "Prior reasoning.", signature: "signed-history" };
    const body = buildBody({
      model,
      max_tokens: 32_000,
      thinking: { type: "enabled", budget_tokens: 24_576 },
      temperature: 0.5,
      top_p: 0.9,
      tools,
      tool_choice: { type: "tool", name: "get_weather" },
      messages: [
        { role: "user", content: "What is the weather?" },
        { role: "assistant", content: [signedThinking, { type: "text", text: "Which city?" }] },
        { role: "user", content: "Paris." },
      ],
    }, adaptiveProvider);

    expect(body.output_config).toEqual({ effort: "xhigh" });
    expect(body.max_tokens).toBe(32_000);
    expect(body).not.toHaveProperty("thinking");
    expect(body).not.toHaveProperty("temperature");
    expect(body).not.toHaveProperty("top_p");
    expect(body.tool_choice).toEqual({ type: "auto" });
    expect(body.messages).toEqual([
      { role: "user", content: "What is the weather?" },
      { role: "assistant", content: [signedThinking, { type: "text", text: "Which city?" }] },
      { role: "user", content: "Paris." },
    ]);
  });

  test("normalizes any tool choice but preserves explicit none", () => {
    const required = buildBody({ model, tools, tool_choice: { type: "any" } }, adaptiveProvider);
    const none = buildBody({ model, tools, tool_choice: { type: "none" } }, adaptiveProvider);
    expect(required.tool_choice).toEqual({ type: "auto" });
    expect(none.tool_choice).toEqual({ type: "none" });
  });

  test("leaves default adaptive thinking intact when the caller disables thinking", () => {
    const body = buildBody({
      model,
      thinking: { type: "disabled" },
      temperature: 0.5,
      top_p: 0.9,
    }, adaptiveProvider);
    expect(body).not.toHaveProperty("thinking");
    expect(body).not.toHaveProperty("output_config");
    expect(body).not.toHaveProperty("temperature");
    expect(body).not.toHaveProperty("top_p");
  });

  test("uses configured effort mappings without the legacy minimum token threshold", () => {
    const body = buildBody({
      model,
      max_tokens: 20,
      thinking: { type: "enabled", budget_tokens: 24_576 },
    }, {
      ...adaptiveProvider,
      modelReasoningEfforts: { [model]: ["high", "xhigh"] },
      modelReasoningEffortMap: { [model]: { xhigh: "max" } },
    });
    expect(body.output_config).toEqual({ effort: "max" });
    expect(body.max_tokens).toBe(20);
    expect(body).not.toHaveProperty("thinking");
  });

  test("an explicit empty effort list does not fall back to manual thinking", () => {
    const body = buildBody({
      model,
      max_tokens: 32_000,
      thinking: { type: "enabled", budget_tokens: 24_576 },
    }, { ...adaptiveProvider, modelReasoningEfforts: { [model]: [] } });
    expect(body).not.toHaveProperty("output_config");
    expect(body).not.toHaveProperty("thinking");
  });

  test("does not infer the adaptive protocol for a custom provider or suffix model", () => {
    const request = { max_tokens: 8192, thinking: { type: "enabled", budget_tokens: 4096 } };
    const custom = buildBody({ ...request, model }, { ...adaptiveProvider, catalogProviderId: undefined });
    const suffix = buildBody({ ...request, model: `${model}:custom` }, adaptiveProvider);
    for (const body of [custom, suffix]) {
      expect(body.thinking).toEqual({ type: "enabled", budget_tokens: 4096 });
      expect(body).not.toHaveProperty("output_config");
    }
  });

  test("uses adaptive thinking for managed Fable 5 without borrowing Fable 5.1 restrictions", () => {
    const fableProvider = { ...adaptiveProvider, reasoningEfforts: ["low"] };
    const body = buildBody({
      model: "claude-fable-5",
      max_tokens: 32_000,
      thinking: { type: "enabled", budget_tokens: 16_384 },
    }, fableProvider);
    expect(body).not.toHaveProperty("thinking");
    expect(body.max_tokens).toBe(32_000);
    expect(body.output_config).toEqual({ effort: "low" });

    const nonThinkingBody = buildBody({
      model: "claude-fable-5",
      temperature: 0.5,
      top_p: 0.9,
      tools,
      tool_choice: { type: "tool", name: "get_weather" },
    }, fableProvider);
    expect(nonThinkingBody.temperature).toBe(0.5);
    expect(nonThinkingBody.top_p).toBe(0.9);
    expect(nonThinkingBody.tool_choice).toEqual({ type: "tool", name: "get_weather" });
  });
});

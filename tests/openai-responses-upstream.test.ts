import { describe, expect, test } from "bun:test";
import { createResponsesAdapter } from "../src/adapters/openai-responses";
import { __resetLocalAccessRegistry, setRuntimeAccessToken } from "../src/local-access";
import { parseMessagesRequest } from "../src/messages/parser";

const provider = {
  adapter: "openai-responses",
  baseUrl: "https://chatgpt.example/backend-api/codex",
  authMode: "forward" as const,
};

test("does not forward a relay-local Authorization credential to OpenAI Responses", () => {
  const localKey = "frogp_openai-forward-local-key";
  setRuntimeAccessToken(localKey);
  try {
    const request = createResponsesAdapter(provider).buildRequest({
      modelId: "gpt-5.5",
      context: { messages: [] },
      stream: false,
      options: {},
      _rawBody: { model: "gpt-5.5", input: [] },
    }, { headers: new Headers({ authorization: `Bearer ${localKey}` }) });

    expect(request.headers.authorization).toBeUndefined();
    expect(Object.values(request.headers)).not.toContain(`Bearer ${localKey}`);
  } finally {
    __resetLocalAccessRegistry();
  }
});

describe("OpenAI Responses upstream body sanitization", () => {
  test("maps Messages effort through the selected model before sending Responses", () => {
    const config = {
      adapter: "openai-responses",
      baseUrl: "https://api.openai.com",
      modelReasoningEfforts: { "gpt-test": ["low", "medium", "high"] },
    };
    const parsed = parseMessagesRequest({
      model: "gpt-test",
      messages: [{ role: "user", content: "Explain quicksort." }],
      output_config: { effort: "max" },
    });
    const original = structuredClone(parsed);
    const request = createResponsesAdapter(config).buildRequest(parsed);
    expect(JSON.parse(request.body).reasoning).toEqual({ effort: "high", summary: "auto" });
    expect(parsed).toEqual(original);

    const unsupported = createResponsesAdapter({ ...config, noReasoningModels: ["gpt-test"] }).buildRequest(parsed);
    expect(JSON.parse(unsupported.body)).not.toHaveProperty("reasoning");

    const invalid = parseMessagesRequest({
      model: "gpt-test",
      messages: [{ role: "user", content: "Explain quicksort." }],
      output_config: { effort: "invalid-effort" },
    });
    expect(JSON.parse(createResponsesAdapter(config).buildRequest(invalid).body)).not.toHaveProperty("reasoning");
  });

  test("omits configured sampling parameters from API-key raw bodies without mutating the parsed request", () => {
    const adapter = createResponsesAdapter({
      adapter: "openai-responses",
      baseUrl: "https://api.openai.com",
      authMode: "key",
      apiKey: "token",
      noTemperatureModels: ["gpt-6-astra"],
      noTopPModels: ["gpt-6-astra"],
    });
    const parsed = {
      modelId: "gpt-6-astra",
      context: { messages: [] },
      stream: false,
      options: { temperature: 0.7, topP: 0.9 },
      _rawBody: {
        model: "gpt-6-astra",
        input: [{ role: "user", content: "hello" }],
        temperature: 0.7,
        top_p: 0.9,
        reasoning: { effort: "none" },
      },
    };
    const original = structuredClone(parsed);
    const request = adapter.buildRequest(parsed);
    const { temperature, top_p, ...expectedBody } = original._rawBody;

    expect(request.url).toBe("https://api.openai.com/v1/responses");
    expect(JSON.parse(request.body)).toEqual(expectedBody);
    expect(parsed).toEqual(original);

    const unrelated = adapter.buildRequest({
      ...parsed,
      modelId: "gpt-5.5",
      _rawBody: { ...parsed._rawBody, model: "gpt-5.5" },
    });
    expect(JSON.parse(unrelated.body)).toEqual({
      ...original._rawBody,
      model: "gpt-5.5",
    });
  });

  test("drops raw reasoning input content before native GPT Responses upstream call", () => {
    const adapter = createResponsesAdapter(provider);
    const request = adapter.buildRequest({
      modelId: "gpt-5.5",
      context: { messages: [] },
      stream: true,
      options: {},
      _rawBody: {
        model: "gpt-5.5",
        input: [
          {
            type: "reasoning",
            id: "rs_1",
            summary: [],
            content: [{ type: "reasoning_text", text: "raw routed reasoning" }],
          },
          {
            type: "message",
            role: "user",
            content: [{ type: "input_text", text: "hi" }],
          },
        ],
      },
    }, { headers: new Headers({ authorization: "Bearer token" }) });
    const body = JSON.parse(request.body) as { input: Record<string, unknown>[] };

    expect(body.input[0]).toMatchObject({
      type: "reasoning",
      id: "rs_1",
      summary: [],
      content: [],
    });
    expect(body.input[1]).toMatchObject({
      type: "message",
      role: "user",
      content: [{ type: "input_text", text: "hi" }],
    });
  });

  test("forces ChatGPT Codex backend requests to stream upstream", () => {
    const adapter = createResponsesAdapter({
      adapter: "openai-responses",
      baseUrl: "https://chatgpt.com/backend-api/codex",
      authMode: "oauth",
      apiKey: "token",
    });
    const request = adapter.buildRequest({
      modelId: "gpt-5.5",
      context: { messages: [] },
      stream: false,
      options: {},
      _rawBody: { model: "gpt-5.5", input: [], stream: false },
    });
    const body = JSON.parse(request.body) as { stream?: boolean; store?: boolean };

    expect(body.stream).toBe(true);
    expect(body.store).toBe(false);
  });

  test("collects streaming Responses frames for non-stream callers", async () => {
    const adapter = createResponsesAdapter({
      adapter: "openai-responses",
      baseUrl: "https://chatgpt.com/backend-api/codex",
      authMode: "oauth",
      apiKey: "token",
    });
    const response = new Response([
      "event: response.output_text.delta",
      "data: {\"type\":\"response.output_text.delta\",\"delta\":\"OK\"}",
      "",
      "event: response.completed",
      "data: {\"type\":\"response.completed\",\"response\":{\"usage\":{\"input_tokens\":2,\"output_tokens\":1}}}",
      "",
    ].join("\n"));

    await expect(adapter.parseResponse!(response)).resolves.toEqual([
      { type: "text_delta", text: "OK" },
      { type: "done", usage: { inputTokens: 2, outputTokens: 1 } },
    ]);
  });
  test("surfaces Responses lifecycle and comment keepalives as activity", async () => {
    const adapter = createResponsesAdapter({
      adapter: "openai-responses",
      baseUrl: "https://chatgpt.com/backend-api/codex",
      authMode: "oauth",
      apiKey: "token",
    });
    const response = new Response([
      "event: response.created",
      "data: {\"type\":\"response.created\",\"response\":{\"status\":\"in_progress\"}}",
      "",
      ": upstream keepalive",
      "",
      "event: response.in_progress",
      "data: {\"type\":\"response.in_progress\",\"response\":{\"status\":\"in_progress\"}}",
      "",
      "event: response.output_text.delta",
      "data: {\"type\":\"response.output_text.delta\",\"delta\":\"OK\"}",
      "",
      "event: response.completed",
      "data: {\"type\":\"response.completed\",\"response\":{\"usage\":{\"input_tokens\":2,\"output_tokens\":1}}}",
      "",
    ].join("\n"));
    const events = [];
    for await (const event of adapter.parseStream(response)) events.push(event);

    expect(events).toEqual([
      { type: "activity" },
      { type: "activity" },
      { type: "activity" },
      { type: "text_delta", text: "OK" },
      { type: "done", usage: { inputTokens: 2, outputTokens: 1 } },
    ]);
  });

  test("flushes a final-only completed frame without a trailing newline", async () => {
    const adapter = createResponsesAdapter({
      adapter: "openai-responses",
      baseUrl: "https://chatgpt.com/backend-api/codex",
      authMode: "oauth",
      apiKey: "token",
    });
    const response = new Response([
      "event: response.in_progress",
      "data: {\"type\":\"response.in_progress\",\"response\":{\"status\":\"in_progress\"}}",
      "",
      "event: response.completed",
      "data: {\"type\":\"response.completed\",\"response\":{\"status\":\"completed\",\"output\":[{\"type\":\"message\",\"content\":[{\"type\":\"output_text\",\"text\":\"Recovered\"}]}],\"usage\":{\"input_tokens\":2,\"output_tokens\":1}}}",
    ].join("\n"));

    await expect(adapter.parseResponse!(response)).resolves.toEqual([
      { type: "text_delta", text: "Recovered" },
      { type: "done", usage: { inputTokens: 2, outputTokens: 1 } },
    ]);
  });

  test("does not synthesize a terminal event on bare Responses EOF", async () => {
    const adapter = createResponsesAdapter({
      adapter: "openai-responses",
      baseUrl: "https://chatgpt.com/backend-api/codex",
      authMode: "oauth",
      apiKey: "token",
    });
    const body = [
      "event: response.created",
      "data: {\"type\":\"response.created\",\"response\":{\"status\":\"in_progress\"}}",
      "",
      "event: response.output_text.delta",
      "data: {\"type\":\"response.output_text.delta\",\"delta\":\"partial\"}",
      "",
    ].join("\n");
    const events = [];
    for await (const event of adapter.parseStream(new Response(body))) events.push(event);

    expect(events).toEqual([
      { type: "activity" },
      { type: "text_delta", text: "partial" },
    ]);
    await expect(adapter.parseResponse!(new Response(body))).rejects.toThrow("stream ended without a terminal event");
  });

  test("recovers output from a final-only completed response", async () => {
    const adapter = createResponsesAdapter({
      adapter: "openai-responses",
      baseUrl: "https://chatgpt.com/backend-api/codex",
      authMode: "oauth",
      apiKey: "token",
    });
    const response = new Response([
      "event: response.completed",
      "data: {\"type\":\"response.completed\",\"response\":{\"status\":\"completed\",\"output\":[{\"type\":\"message\",\"content\":[{\"type\":\"output_text\",\"text\":\"Recovered\"}]}],\"usage\":{\"input_tokens\":2,\"output_tokens\":1}}}",
      "",
    ].join("\n"));

    await expect(adapter.parseResponse!(response)).resolves.toEqual([
      { type: "text_delta", text: "Recovered" },
      { type: "done", usage: { inputTokens: 2, outputTokens: 1 } },
    ]);
  });

  test("turns a failed completed envelope into a terminal error", async () => {
    const adapter = createResponsesAdapter({
      adapter: "openai-responses",
      baseUrl: "https://chatgpt.com/backend-api/codex",
      authMode: "oauth",
      apiKey: "token",
    });
    const response = new Response([
      "event: response.completed",
      "data: {\"type\":\"response.completed\",\"response\":{\"status\":\"failed\",\"output\":[],\"error\":{\"message\":\"Input exceeds the context window\"},\"usage\":null}}",
      "",
    ].join("\n"));

    await expect(adapter.parseResponse!(response)).resolves.toEqual([
      { type: "error", message: "Input exceeds the context window" },
    ]);
  });

  test("rejects a completed response with no assistant output", async () => {
    const adapter = createResponsesAdapter({
      adapter: "openai-responses",
      baseUrl: "https://chatgpt.com/backend-api/codex",
      authMode: "oauth",
      apiKey: "token",
    });
    const response = new Response([
      "event: response.completed",
      "data: {\"type\":\"response.completed\",\"response\":{\"status\":\"completed\",\"output\":[],\"usage\":null}}",
      "",
    ].join("\n"));

    await expect(adapter.parseResponse!(response)).resolves.toEqual([
      { type: "error", message: "Upstream completed without assistant output" },
    ]);
  });
  test("coerces object-shaped input_image.image_url to a string before relaying", () => {
    const adapter = createResponsesAdapter(provider);
    const request = adapter.buildRequest({
      modelId: "gpt-5.5",
      context: { messages: [] },
      stream: true,
      options: {},
      _rawBody: {
        model: "gpt-5.5",
        input: [
          {
            type: "message",
            role: "user",
            content: [
              { type: "input_text", text: "look" },
              // Chat-Completions object shape mistakenly sent to the Responses endpoint.
              { type: "input_image", image_url: { url: "data:image/png;base64,AAAA", detail: "high" } },
            ],
          },
          {
            type: "function_call_output",
            call_id: "call_1",
            output: [
              { type: "input_image", image_url: { url: "https://example.com/a.png" } },
            ],
          },
        ],
      },
    }, { headers: new Headers({ authorization: "Bearer token" }) });
    const body = JSON.parse(request.body) as { input: Array<{ content?: unknown[]; output?: unknown[] }> };

    expect(body.input[0].content![1]).toEqual({
      type: "input_image",
      image_url: "data:image/png;base64,AAAA",
      detail: "high",
    });
    expect(body.input[1].output![0]).toEqual({
      type: "input_image",
      image_url: "https://example.com/a.png",
    });
  });

  test("leaves a string image_url untouched", () => {
    const adapter = createResponsesAdapter(provider);
    const request = adapter.buildRequest({
      modelId: "gpt-5.5",
      context: { messages: [] },
      stream: true,
      options: {},
      _rawBody: {
        model: "gpt-5.5",
        input: [
          {
            type: "message",
            role: "user",
            content: [{ type: "input_image", image_url: "data:image/png;base64,BBBB" }],
          },
        ],
      },
    }, { headers: new Headers({ authorization: "Bearer token" }) });
    const body = JSON.parse(request.body) as { input: Array<{ content?: unknown[] }> };

    expect(body.input[0].content![0]).toEqual({
      type: "input_image",
      image_url: "data:image/png;base64,BBBB",
    });
  });

});

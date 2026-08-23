import { describe, expect, test } from "bun:test";
import { createAnthropicAdapter } from "../src/adapters/anthropic";
import { createGoogleAdapter } from "../src/adapters/google";
import { createOpenAIChatAdapter } from "../src/adapters/openai-chat";
import { buildEffectiveConfig } from "../src/model-catalog-config";
import type { ModelCatalogProviderV1 } from "../src/model-catalog-schema";
import type { SelectedModelCatalog } from "../src/model-catalog-runtime";
import type { FrogProviderConfig } from "../src/types";

const provider = { adapter: "openai-chat", baseUrl: "https://example.test/v1", apiKey: "key" };

function effectiveManagedProvider(
  persisted: FrogProviderConfig,
  catalogProvider: ModelCatalogProviderV1,
): FrogProviderConfig {
  const selected = {
    document: {
      schemaVersion: 1,
      catalogRevision: 1,
      catalogDigest: "0".repeat(64),
      sourceCommit: "0".repeat(40),
      generatedAt: "2026-08-12T00:00:00.000Z",
      minFrogprogsyVersion: "0.0.0",
      providers: [catalogProvider],
    },
    status: {
      source: "bundled",
      catalogRevision: 1,
      catalogDigest: "0".repeat(64),
      sourceCommit: "0".repeat(40),
      generatedAt: "2026-08-12T00:00:00.000Z",
      skippedRecords: 0,
      warnings: [],
    },
  } satisfies SelectedModelCatalog;
  return buildEffectiveConfig({
    port: 3764,
    defaultProvider: "managed",
    providers: {
      managed: {
        ...persisted,
        catalogProviderId: catalogProvider.id,
      },
    },
  }, selected).providers.managed;
}

describe("adapter reasoning and usage details", () => {
  test("effective managed restrictions constrain the actual OpenAI request", () => {
    const effectiveProvider = effectiveManagedProvider({
      adapter: "openai-chat",
      baseUrl: "https://managed.test/v1",
      noReasoningModels: [],
      noTemperatureModels: [],
      noTopPModels: [],
      noPenaltyModels: [],
      autoToolChoiceOnlyModels: [],
    }, {
      id: "managed",
      models: [{
        id: "strict-model",
        noReasoning: true,
        noTemperature: true,
        noTopP: true,
        noPenalty: true,
        autoToolChoiceOnly: true,
      }],
    });
    const request = createOpenAIChatAdapter(effectiveProvider).buildRequest({
      modelId: "strict-model",
      context: {
        messages: [{ role: "user", content: "hello", timestamp: 0 }],
        tools: [{ name: "run_tests", description: "Run tests", parameters: { type: "object", properties: {} } }],
      },
      stream: false,
      options: {
        reasoning: "high",
        temperature: 0.2,
        topP: 0.7,
        presencePenalty: 1,
        frequencyPenalty: 1,
        toolChoice: { name: "run_tests" },
      },
    });
    const body = JSON.parse(request.body as string) as Record<string, unknown>;

    expect(body).not.toHaveProperty("reasoning_effort");
    expect(body).not.toHaveProperty("temperature");
    expect(body).not.toHaveProperty("top_p");
    expect(body).not.toHaveProperty("presence_penalty");
    expect(body).not.toHaveProperty("frequency_penalty");
    expect(body.tool_choice).toBe("auto");
    expect(body).not.toHaveProperty("parallel_tool_calls");
  });

  test("OpenAI-compatible non-streaming maps reasoning_content and usage details", async () => {
    const adapter = createOpenAIChatAdapter(provider);
    const events = await adapter.parseResponse?.(new Response(JSON.stringify({
      choices: [{ message: { reasoning_content: "raw thoughts", content: "answer" } }],
      usage: {
        prompt_tokens: 11,
        completion_tokens: 7,
        prompt_tokens_details: { cached_tokens: 5 },
        completion_tokens_details: { reasoning_tokens: 3 },
      },
    })));

    expect(events).toContainEqual({ type: "reasoning_raw_delta", text: "raw thoughts" });
    expect(events).toContainEqual({ type: "text_delta", text: "answer" });
    expect(events?.at(-1)).toEqual({
      type: "done",
      usage: { inputTokens: 11, outputTokens: 7, cachedInputTokens: 5, reasoningOutputTokens: 3 },
    });
  });

  test("OpenAI-compatible streaming maps reasoning_content and usage details", async () => {
    const adapter = createOpenAIChatAdapter(provider);
    const response = new Response([
      "data: {\"choices\":[{\"delta\":{\"reasoning_content\":\"raw stream\"}}]}\n\n",
      "data: {\"usage\":{\"prompt_tokens\":9,\"completion_tokens\":4,\"prompt_tokens_details\":{\"cached_tokens\":2},\"completion_tokens_details\":{\"reasoning_tokens\":1}}}\n\n",
      "data: [DONE]\n\n",
    ].join(""));

    const events = [];
    for await (const event of adapter.parseStream(response)) events.push(event);

    expect(events).toContainEqual({ type: "reasoning_raw_delta", text: "raw stream" });
    expect(events.at(-1)).toEqual({
      type: "done",
      usage: { inputTokens: 9, outputTokens: 4, cachedInputTokens: 2, reasoningOutputTokens: 1 },
    });
  });

  test("Anthropic usage maps cache tokens only when present", async () => {
    const adapter = createAnthropicAdapter({ ...provider, adapter: "anthropic" });
    const events = await adapter.parseResponse?.(new Response(JSON.stringify({
      content: [{ type: "text", text: "answer" }],
      usage: {
        input_tokens: 20,
        output_tokens: 8,
        cache_read_input_tokens: 4,
        cache_creation_input_tokens: 6,
      },
    })));

    expect(events?.at(-1)).toEqual({
      type: "done",
      usage: { inputTokens: 20, outputTokens: 8, cachedInputTokens: 10 },
    });
  });

  test("Anthropic usage does not fabricate cache tokens when absent", async () => {
    const adapter = createAnthropicAdapter({ ...provider, adapter: "anthropic" });
    const events = await adapter.parseResponse?.(new Response(JSON.stringify({
      content: [{ type: "text", text: "answer" }],
      usage: { input_tokens: 20, output_tokens: 8 },
    })));

    expect(events?.at(-1)).toEqual({
      type: "done",
      usage: { inputTokens: 20, outputTokens: 8 },
    });
  });

  test("Google usage maps cached and thoughts tokens when present", async () => {
    const adapter = createGoogleAdapter({ ...provider, adapter: "google" });
    const events = await adapter.parseResponse?.(new Response(JSON.stringify({
      candidates: [{ content: { parts: [{ text: "answer" }] } }],
      usageMetadata: {
        promptTokenCount: 13,
        candidatesTokenCount: 5,
        cachedContentTokenCount: 3,
        thoughtsTokenCount: 2,
      },
    })));

    expect(events?.at(-1)).toEqual({
      type: "done",
      usage: { inputTokens: 13, outputTokens: 5, cachedInputTokens: 3, reasoningOutputTokens: 2 },
    });
  });
});

describe("usage and content retention (F2)", () => {
  test("openai-chat keeps content when usage and choices share one chunk", async () => {
    const adapter = createOpenAIChatAdapter(provider);
    const response = new Response([
      'data: {"choices":[{"delta":{"content":"final"}}],"usage":{"prompt_tokens":3,"completion_tokens":2}}\n\n',
      "data: [DONE]\n\n",
    ].join(""));
    const events = [];
    for await (const event of adapter.parseStream(response)) events.push(event);
    expect(events).toContainEqual({ type: "text_delta", text: "final" });
    expect(events.at(-1)).toEqual({ type: "done", usage: { inputTokens: 3, outputTokens: 2 } });
  });

  test("openai-chat treats EOF without [DONE] as an error", async () => {
    const adapter = createOpenAIChatAdapter(provider);
    const response = new Response([
      'data: {"choices":[{"delta":{"content":"hi"}}]}\n\n',
      'data: {"usage":{"prompt_tokens":5,"completion_tokens":1}}\n\n',
    ].join(""));
    const events = [];
    for await (const event of adapter.parseStream(response)) events.push(event);
    expect(events).toContainEqual({ type: "text_delta", text: "hi" });
    expect(events.at(-1)).toEqual({ type: "error", message: "upstream stream ended before [DONE]" });
    expect(events.some(event => event.type === "done")).toBe(false);
  });

  test("openai-chat accepts a final [DONE] field without optional space or trailing newline", async () => {
    const adapter = createOpenAIChatAdapter(provider);
    const events = [];
    for await (const event of adapter.parseStream(new Response("data:[DONE]"))) events.push(event);
    expect(events.at(-1)?.type).toBe("done");
  });

  test("openai-chat parses a final content field before reporting missing [DONE]", async () => {
    const adapter = createOpenAIChatAdapter(provider);
    const events = [];
    for await (const event of adapter.parseStream(new Response(
      'data: {"choices":[{"delta":{"content":"final fragment"}}]}',
    ))) events.push(event);
    expect(events).toEqual([
      { type: "text_delta", text: "final fragment" },
      { type: "error", message: "upstream stream ended before [DONE]" },
    ]);
  });

  test("openai-chat maps streaming and non-streaming length termination to max_tokens", async () => {
    const adapter = createOpenAIChatAdapter(provider);
    const streamEvents = [];
    for await (const event of adapter.parseStream(new Response([
      'data: {"choices":[{"delta":{"content":"cut"},"finish_reason":"length"}]}\n\n',
      "data: [DONE]\n\n",
    ].join("")))) streamEvents.push(event);
    expect(streamEvents.at(-1)).toMatchObject({ type: "done", stopReason: "max_tokens" });

    const responseEvents = await adapter.parseResponse?.(Response.json({
      choices: [{ message: { content: "cut" }, finish_reason: "length" }],
    }));
    expect(responseEvents?.at(-1)).toMatchObject({ type: "done", stopReason: "max_tokens" });
  });

  test("openai-chat preserves indexed interleaved tool argument fragments", async () => {
    const adapter = createOpenAIChatAdapter(provider);
    const response = new Response([
      'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"call_a","function":{"name":"alpha","arguments":"{\\"a\\":"}},{"index":1,"id":"call_b","function":{"name":"beta","arguments":"{\\"b\\":\\""}}]}}]}\n\n',
      'data: {"choices":[{"delta":{"tool_calls":[{"index":1,"function":{"arguments":"two\\"}"}},{"index":0,"function":{"arguments":"1}"}}]},"finish_reason":"tool_calls"}]}\n\n',
      "data: [DONE]\n\n",
    ].join(""));
    const events = [];
    for await (const event of adapter.parseStream(response)) events.push(event);
    const toolEvents = events.filter(event => event.type.startsWith("tool_call_"));
    expect(toolEvents).toEqual([
      { type: "tool_call_start", id: "call_a", name: "alpha" },
      { type: "tool_call_delta", arguments: '{"a":' },
      { type: "tool_call_delta", arguments: "1}" },
      { type: "tool_call_end" },
      { type: "tool_call_start", id: "call_b", name: "beta" },
      { type: "tool_call_delta", arguments: '{"b":"' },
      { type: "tool_call_delta", arguments: 'two"}' },
      { type: "tool_call_end" },
    ]);
    expect(events.at(-1)).toMatchObject({ type: "done", stopReason: "tool_use" });
  });

  test("openai-chat recovers omitted indexes and ignores repeated full tool names", async () => {
    const adapter = createOpenAIChatAdapter(provider);
    const response = new Response([
      'data: {"choices":[{"delta":{"tool_calls":[{"id":"call_a","function":{"name":"alpha","arguments":"{\\"a\\":"}}]}}]}\n\n',
      'data: {"choices":[{"delta":{"tool_calls":[{"function":{"name":"alpha","arguments":"1}"}}]},"finish_reason":"tool_calls"}]}\n\n',
      "data: [DONE]\n\n",
    ].join(""));
    const events = [];
    for await (const event of adapter.parseStream(response)) events.push(event);
    expect(events.filter(event => event.type.startsWith("tool_call_"))).toEqual([
      { type: "tool_call_start", id: "call_a", name: "alpha" },
      { type: "tool_call_delta", arguments: '{"a":' },
      { type: "tool_call_delta", arguments: "1}" },
      { type: "tool_call_end" },
    ]);
  });

  test("openai-chat surfaces a non-stream inline error without done", async () => {
    const adapter = createOpenAIChatAdapter(provider);
    const events = await adapter.parseResponse?.(Response.json({
      error: { message: "provider rejected request" },
    }));
    expect(events).toEqual([{ type: "error", message: "provider rejected request" }]);
  });

  test("openai-chat ignores an empty error placeholder when choices are valid", async () => {
    const adapter = createOpenAIChatAdapter(provider);
    const events = await adapter.parseResponse?.(Response.json({
      error: {},
      choices: [{ message: { content: "answer" }, finish_reason: "stop" }],
    }));
    expect(events).toEqual([
      { type: "text_delta", text: "answer" },
      { type: "done", usage: undefined, stopReason: "end_turn" },
    ]);
  });

  test("google emits exactly one done carrying usage", async () => {
    const adapter = createGoogleAdapter({ ...provider, adapter: "google" });
    const response = new Response(
      'data: {"candidates":[{"content":{"parts":[{"text":"a"}]},"finishReason":"STOP"}],"usageMetadata":{"promptTokenCount":4,"candidatesTokenCount":2}}\n\n',
    );
    const events = [];
    for await (const event of adapter.parseStream(response)) events.push(event);
    const dones = events.filter(e => e.type === "done");
    expect(dones.length).toBe(1);
    expect(dones[0]).toEqual({ type: "done", usage: { inputTokens: 4, outputTokens: 2 } });
  });
});

describe("openai-chat tool history repair", () => {
  test("inserts a synthetic assistant tool_call before orphan tool results", () => {
    const adapter = createOpenAIChatAdapter(provider);
    const request = adapter.buildRequest({
      modelId: "deepseek-v4",
      context: {
        messages: [{
          role: "toolResult",
          toolCallId: "call_1",
          toolName: "claude.list_mcp_resources",
          content: '{"resources":[]}',
          isError: false,
          timestamp: 0,
        }],
      },
      stream: true,
      options: {},
    });
    const body = JSON.parse(request.body) as { messages: Record<string, unknown>[] };

    expect(body.messages).toHaveLength(2);
    expect(body.messages[0]).toMatchObject({
      role: "assistant",
      content: null,
      tool_calls: [{
        id: "call_1",
        type: "function",
        function: { name: "claude_list_mcp_resources", arguments: "{}" },
      }],
    });
    expect(body.messages[1]).toMatchObject({
      role: "tool",
      tool_call_id: "call_1",
      content: '{"resources":[]}',
    });
  });

  test("keeps paired tool results attached to the prior assistant tool_call", () => {
    const adapter = createOpenAIChatAdapter(provider);
    const request = adapter.buildRequest({
      modelId: "deepseek-v4",
      context: {
        messages: [
          {
            role: "assistant",
            content: [{
              type: "toolCall",
              id: "call_1",
              name: "read_file",
              arguments: { path: "README.md" },
            }],
            model: "deepseek-v4",
            timestamp: 0,
          },
          {
            role: "toolResult",
            toolCallId: "call_1",
            toolName: "read_file",
            content: "contents",
            isError: false,
            timestamp: 0,
          },
        ],
      },
      stream: true,
      options: {},
    });
    const body = JSON.parse(request.body) as { messages: Record<string, unknown>[] };

    expect(body.messages).toHaveLength(2);
    expect(body.messages[0]).toMatchObject({
      role: "assistant",
      tool_calls: [{
        id: "call_1",
        function: { name: "read_file", arguments: '{"path":"README.md"}' },
      }],
    });
    expect(body.messages[1]).toMatchObject({ role: "tool", tool_call_id: "call_1" });
  });

  test("backfills missing sibling results from a parallel tool batch", () => {
    const adapter = createOpenAIChatAdapter(provider);
    const request = adapter.buildRequest({
      modelId: "deepseek-v4",
      context: {
        messages: [
          {
            role: "assistant",
            content: [
              { type: "toolCall", id: "call_a", name: "alpha", arguments: {} },
              { type: "toolCall", id: "call_b", name: "beta", arguments: {} },
            ],
            model: "deepseek-v4",
            timestamp: 0,
          },
          { role: "toolResult", toolCallId: "call_a", toolName: "alpha", content: "ok", isError: false, timestamp: 0 },
          { role: "user", content: "continue", timestamp: 0 },
        ],
      },
      stream: true,
      options: {},
    });
    const body = JSON.parse(request.body) as { messages: Array<Record<string, unknown>> };

    expect(body.messages.map(message => message.role)).toEqual(["assistant", "tool", "tool", "user"]);
    expect(body.messages[1]).toMatchObject({ role: "tool", tool_call_id: "call_a", content: "ok" });
    expect(body.messages[2]).toMatchObject({
      role: "tool",
      tool_call_id: "call_b",
      content: "[frogprogsy: missing tool_result for this tool_call in Claude Code history]",
    });
  });

  test("marks failed tool results without changing successful result content", () => {
    const adapter = createOpenAIChatAdapter(provider);
    const request = adapter.buildRequest({
      modelId: "deepseek-v4",
      context: {
        messages: [
          {
            role: "assistant",
            content: [{ type: "toolCall", id: "call_1", name: "read_file", arguments: {} }],
            model: "deepseek-v4",
            timestamp: 0,
          },
          {
            role: "toolResult",
            toolCallId: "call_1",
            toolName: "read_file",
            content: "permission denied",
            isError: true,
            timestamp: 0,
          },
        ],
      },
      stream: true,
      options: {},
    });
    const body = JSON.parse(request.body) as { messages: Array<Record<string, unknown>> };

    expect(body.messages[1]).toMatchObject({
      role: "tool",
      tool_call_id: "call_1",
      content: "[frogprogsy: tool_result is_error=true]\npermission denied",
    });
  });

  test("repairs pending siblings before inserting an orphan tool result pair", () => {
    const adapter = createOpenAIChatAdapter(provider);
    const request = adapter.buildRequest({
      modelId: "deepseek-v4",
      context: {
        messages: [
          {
            role: "assistant",
            content: [
              { type: "toolCall", id: "call_a", name: "alpha", arguments: {} },
              { type: "toolCall", id: "call_b", name: "beta", arguments: {} },
            ],
            model: "deepseek-v4",
            timestamp: 0,
          },
          { role: "toolResult", toolCallId: "call_c", toolName: "gamma", content: "orphan", isError: false, timestamp: 0 },
        ],
      },
      stream: true,
      options: {},
    });
    const body = JSON.parse(request.body) as { messages: Array<Record<string, unknown>> };

    expect(body.messages.map(message => message.role)).toEqual(["assistant", "tool", "tool", "assistant", "tool"]);
    expect(body.messages[1]).toMatchObject({ role: "tool", tool_call_id: "call_a" });
    expect(body.messages[2]).toMatchObject({ role: "tool", tool_call_id: "call_b" });
    expect(body.messages[3]).toMatchObject({
      role: "assistant",
      tool_calls: [{ id: "call_c" }],
    });
    expect(body.messages[4]).toMatchObject({ role: "tool", tool_call_id: "call_c", content: "orphan" });
  });
});

describe("anthropic tool result history repair", () => {
  test("merges adjacent tool results after multiple tool uses into one user message", () => {
    const adapter = createAnthropicAdapter({ ...provider, adapter: "anthropic" });
    const request = adapter.buildRequest({
      modelId: "claude-sonnet",
      context: {
        messages: [
          { role: "user", content: "start", timestamp: 0 },
          {
            role: "assistant",
            content: [
              { type: "toolCall", id: "call_1", name: "first_tool", arguments: {} },
              { type: "toolCall", id: "call_2", name: "second_tool", arguments: {} },
            ],
            model: "claude-sonnet",
            timestamp: 0,
          },
          { role: "toolResult", toolCallId: "call_1", toolName: "first_tool", content: "one", isError: false, timestamp: 0 },
          { role: "toolResult", toolCallId: "call_2", toolName: "second_tool", content: "two", isError: false, timestamp: 0 },
          { role: "user", content: "continue", timestamp: 0 },
        ],
      },
      stream: true,
      options: {},
    });
    const body = JSON.parse(request.body) as { messages: Array<{ role: string; content: any }> };

    expect(body.messages).toHaveLength(4);
    expect(body.messages[2].role).toBe("user");
    expect(body.messages[2].content).toEqual([
      { type: "tool_result", tool_use_id: "call_1", content: "one" },
      { type: "tool_result", tool_use_id: "call_2", content: "two" },
    ]);
  });

  test("adds an error tool result when history is missing a tool result", () => {
    const adapter = createAnthropicAdapter({ ...provider, adapter: "anthropic" });
    const request = adapter.buildRequest({
      modelId: "claude-sonnet",
      context: {
        messages: [{
          role: "assistant",
          content: [{ type: "toolCall", id: "call_1", name: "read_file", arguments: {} }],
          model: "claude-sonnet",
          timestamp: 0,
        }],
      },
      stream: true,
      options: {},
    });
    const body = JSON.parse(request.body) as { messages: Array<{ role: string; content: any }> };

    expect(body.messages[1]).toEqual({
      role: "user",
      content: [{
        type: "tool_result",
        tool_use_id: "call_1",
        content: "[frogprogsy: missing tool_result for this tool_use in Claude Code history]",
        is_error: true,
      }],
    });
  });

  test("preserves orphan tool results as text instead of invalid Anthropic tool_result blocks", () => {
    const adapter = createAnthropicAdapter({ ...provider, adapter: "anthropic" });
    const request = adapter.buildRequest({
      modelId: "claude-sonnet",
      context: {
        messages: [{
          role: "toolResult",
          toolCallId: "orphan_call",
          toolName: "lost_tool",
          content: "orphan output",
          isError: false,
          timestamp: 0,
        }],
      },
      stream: true,
      options: {},
    });
    const body = JSON.parse(request.body) as { messages: Array<{ role: string; content: string }> };

    expect(body.messages).toEqual([{
      role: "user",
      content: "[tool_result without adjacent tool_use: lost_tool (orphan_call)]\norphan output",
    }]);
  });

  test("preserves duplicate adjacent tool results as text after the matching result", () => {
    const adapter = createAnthropicAdapter({ ...provider, adapter: "anthropic" });
    const request = adapter.buildRequest({
      modelId: "claude-sonnet",
      context: {
        messages: [
          {
            role: "assistant",
            content: [{ type: "toolCall", id: "call_1", name: "read_file", arguments: {} }],
            model: "claude-sonnet",
            timestamp: 0,
          },
          { role: "toolResult", toolCallId: "call_1", toolName: "read_file", content: "first", isError: false, timestamp: 0 },
          { role: "toolResult", toolCallId: "call_1", toolName: "read_file", content: "duplicate", isError: false, timestamp: 0 },
        ],
      },
      stream: true,
      options: {},
    });
    const body = JSON.parse(request.body) as { messages: Array<{ role: string; content: any }> };

    expect(body.messages[1]).toEqual({
      role: "user",
      content: [
        { type: "tool_result", tool_use_id: "call_1", content: "first" },
        { type: "text", text: "[tool_result without adjacent tool_use: read_file (call_1)]\nduplicate" },
      ],
    });
  });

  test("maps non-string tool result content through Anthropic content blocks", () => {
    const adapter = createAnthropicAdapter({ ...provider, adapter: "anthropic" });
    const request = adapter.buildRequest({
      modelId: "claude-sonnet",
      context: {
        messages: [
          {
            role: "assistant",
            content: [{ type: "toolCall", id: "call_1", name: "view_image", arguments: {} }],
            model: "claude-sonnet",
            timestamp: 0,
          },
          {
            role: "toolResult",
            toolCallId: "call_1",
            toolName: "view_image",
            content: [
              { type: "text", text: "image attached" },
              { type: "image", imageUrl: "data:image/png;base64,AAAA", detail: "high" },
            ],
            isError: false,
            timestamp: 0,
          },
        ],
      },
      stream: true,
      options: {},
    });
    const body = JSON.parse(request.body) as { messages: Array<{ role: string; content: any }> };

    expect(body.messages[1]).toEqual({
      role: "user",
      content: [{
        type: "tool_result",
        tool_use_id: "call_1",
        content: [
          { type: "text", text: "image attached" },
          { type: "image", source: { type: "base64", media_type: "image/png", data: "AAAA" } },
        ],
      }],
    });
  });
});

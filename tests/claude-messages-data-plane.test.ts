import { describe, expect, test } from "bun:test";
import { buildMessageJSON, bridgeToMessagesSSE, formatAnthropicErrorResponse } from "../src/messages/bridge";
import { buildResponsesBody, estimateMessagesInputTokens, parseMessagesRequest } from "../src/messages/parser";
import { createResponsesAdapter } from "../src/adapters/openai-responses";
import { buildAnthropicModelsListFromAliases } from "../src/server";
import type { AdapterEvent } from "../src/types";

async function* replay(events: AdapterEvent[]): AsyncGenerator<AdapterEvent> {
  for (const event of events) yield event;
}

async function collectSse(stream: ReadableStream<Uint8Array>): Promise<{ event?: string; data: Record<string, unknown> }[]> {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let text = "";
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    text += decoder.decode(value, { stream: true });
  }
  return text.split("\n\n")
    .map(frame => frame.trim())
    .filter(frame => frame.length > 0 && !frame.startsWith(":"))
    .map(frame => {
      const lines = frame.split("\n");
      const event = lines.find(line => line.startsWith("event: "))?.slice(7);
      const dataLine = lines.find(line => line.startsWith("data: "));
      return { event, data: JSON.parse(dataLine?.slice(6) ?? "{}") as Record<string, unknown> };
    });
}

function assistantContentFromSse(
  frames: Array<{ event?: string; data: Record<string, unknown> }>,
): Record<string, unknown>[] {
  const content: Array<Record<string, unknown> | undefined> = [];
  const toolArguments = new Map<number, string>();
  for (const frame of frames) {
    const index = typeof frame.data.index === "number" ? frame.data.index : undefined;
    if (index === undefined) continue;
    if (frame.event === "content_block_start") {
      const block = frame.data.content_block;
      if (block && typeof block === "object" && !Array.isArray(block)) {
        content[index] = { ...(block as Record<string, unknown>) };
        if (content[index]?.type === "tool_use") toolArguments.set(index, "");
      }
      continue;
    }
    if (frame.event !== "content_block_delta" || !content[index]) continue;
    const delta = frame.data.delta;
    if (!delta || typeof delta !== "object" || Array.isArray(delta)) continue;
    const block = content[index]!;
    const record = delta as Record<string, unknown>;
    if (record.type === "thinking_delta" && typeof record.thinking === "string") {
      block.thinking = `${typeof block.thinking === "string" ? block.thinking : ""}${record.thinking}`;
    } else if (record.type === "text_delta" && typeof record.text === "string") {
      block.text = `${typeof block.text === "string" ? block.text : ""}${record.text}`;
    } else if (record.type === "input_json_delta" && typeof record.partial_json === "string") {
      toolArguments.set(index, `${toolArguments.get(index) ?? ""}${record.partial_json}`);
    }
  }
  return content.flatMap((block, index) => {
    if (!block) return [];
    const argumentsJson = toolArguments.get(index);
    if (argumentsJson !== undefined) block.input = argumentsJson ? JSON.parse(argumentsJson) : {};
    return [block];
  });
}

describe("Claude Messages data plane", () => {
  test("sends multiple and empty thinking summaries plus multimodal tool history as valid ordered Responses input", () => {
    const parsed = parseMessagesRequest({
      model: "provider/model-a",
      system: [{ type: "text", text: "system" }],
      messages: [
        { role: "user", content: [{ type: "text", text: "hello" }] },
        { role: "assistant", content: [
          { type: "thinking", thinking: "plan one", signature: "sig-1" },
          { type: "thinking", thinking: "", signature: "sig-empty" },
          { type: "text", text: "before tool" },
          { type: "thinking", thinking: "plan two", signature: "sig-2" },
          { type: "tool_use", id: "toolu_1", name: "read_file", input: { path: "README.md" } },
        ] },
        {
          role: "user",
          content: [{
            type: "tool_result",
            tool_use_id: "toolu_1",
            content: [
              { type: "text", text: "file bytes" },
              { type: "image", source: { type: "base64", media_type: "image/png", data: "AAAA" } },
            ],
          }],
        },
      ],
      tools: [{ name: "read_file", description: "Read", input_schema: { type: "object" } }],
      thinking: { type: "adaptive" },
      output_config: { effort: "high" },
      max_tokens: 100,
      stream: false,
    });

    const adapter = createResponsesAdapter({ adapter: "openai-responses", baseUrl: "https://api.openai.test/v1" });
    const raw = JSON.parse(adapter.buildRequest(parsed).body) as Record<string, unknown>;
    expect(raw.model).toBe("provider/model-a");
    expect(raw.instructions).toBe("system");
    expect(raw.reasoning).toEqual({ effort: "high", summary: "auto" });
    expect(raw.input).toEqual([
      { type: "message", role: "user", content: [{ type: "input_text", text: "hello" }] },
      { type: "reasoning", summary: [{ type: "summary_text", text: "plan one" }], content: [] },
      { type: "reasoning", summary: [], content: [] },
      { type: "message", role: "assistant", content: [{ type: "output_text", text: "before tool" }] },
      { type: "reasoning", summary: [{ type: "summary_text", text: "plan two" }], content: [] },
      { type: "function_call", call_id: "toolu_1", name: "read_file", arguments: "{\"path\":\"README.md\"}" },
      {
        type: "function_call_output",
        call_id: "toolu_1",
        output: [
          { type: "input_text", text: "file bytes" },
          { type: "input_image", image_url: "data:image/png;base64,AAAA" },
        ],
      },
    ]);
  });

  test("rejects unsupported image fidelity instead of silently dropping the requested detail", () => {
    const parsed = parseMessagesRequest({ model: "provider/model-a", messages: [] });
    parsed.context.messages.push({
      role: "user",
      content: [{ type: "image", imageUrl: "https://example.test/image.png", detail: "unsupported" }],
      timestamp: 0,
    });
    expect(() => buildResponsesBody(parsed, {})).toThrow(Error);
  });

  test("replays adaptive-effort reasoning and a tool result through JSON and SSE Messages bridges", async () => {
    const adapter = createResponsesAdapter({ adapter: "openai-responses", baseUrl: "https://api.openai.test/v1" });
    const firstTurn = parseMessagesRequest({
      model: "provider/model-a",
      messages: [{ role: "user", content: "inspect the file" }],
      thinking: { type: "adaptive" },
      output_config: { effort: "high" },
    });
    const jsonEvents = await adapter.parseResponse!(new Response(JSON.stringify({
      status: "completed",
      output: [
        { type: "reasoning", summary: [{ type: "summary_text", text: "inspect " }] },
        { type: "reasoning", summary: [] },
        { type: "reasoning", summary: [{ type: "summary_text", text: "then read" }] },
        { type: "function_call", call_id: "call_1", name: "read_file", arguments: "{\"path\":\"README.md\"}" },
      ],
      usage: { input_tokens: 4, output_tokens: 3 },
    }), { headers: { "content-type": "application/json" } }));
    const jsonMessage = buildMessageJSON(jsonEvents, firstTurn.modelId, firstTurn.options);

    const upstreamSse = new Response([
      'event: response.reasoning_summary_text.delta',
      'data: {"type":"response.reasoning_summary_text.delta","delta":"inspect "}',
      "",
      'event: response.reasoning_summary_text.delta',
      'data: {"type":"response.reasoning_summary_text.delta","delta":"then read"}',
      "",
      'event: response.output_item.added',
      'data: {"type":"response.output_item.added","output_index":1,"item":{"type":"function_call","id":"fc_1","call_id":"call_1","name":"read_file","arguments":""}}',
      "",
      'event: response.output_item.done',
      'data: {"type":"response.output_item.done","output_index":1,"item":{"type":"function_call","id":"fc_1","call_id":"call_1","name":"read_file","arguments":"{\\"path\\":\\"README.md\\"}"}}',
      "",
      'event: response.completed',
      'data: {"type":"response.completed","response":{"status":"completed","usage":{"input_tokens":4,"output_tokens":3}}}',
      "",
    ].join("\n"));
    const sseEvents: AdapterEvent[] = [];
    for await (const event of adapter.parseStream(upstreamSse)) sseEvents.push(event);
    const downstreamFrames = await collectSse(bridgeToMessagesSSE(
      replay(sseEvents),
      firstTurn.modelId,
      undefined,
      60_000,
      firstTurn.options,
    ));

    const responseSurfaces = [
      { stream: false, content: jsonMessage.content as Record<string, unknown>[] },
      { stream: true, content: assistantContentFromSse(downstreamFrames) },
    ];
    for (const surface of responseSurfaces) {
      expect(surface.content).toEqual([
        { type: "thinking", thinking: "inspect then read" },
        { type: "tool_use", id: "call_1", name: "read_file", input: { path: "README.md" } },
      ]);
      const nextTurn = parseMessagesRequest({
        model: "provider/model-a",
        messages: [
          { role: "user", content: "inspect the file" },
          { role: "assistant", content: surface.content },
          {
            role: "user",
            content: [{
              type: "tool_result",
              tool_use_id: "call_1",
              content: [
                { type: "text", text: "file bytes" },
                { type: "image", source: { type: "url", url: "https://example.test/shot.png" } },
              ],
            }],
          },
        ],
        thinking: { type: "adaptive" },
        output_config: { effort: "high" },
        stream: surface.stream,
      });
      const nextBody = JSON.parse(adapter.buildRequest(nextTurn).body);
      expect(nextBody.reasoning).toEqual({ effort: "high", summary: "auto" });
      expect(nextBody.stream).toBe(surface.stream);
      expect(nextBody.input).toEqual([
        { type: "message", role: "user", content: [{ type: "input_text", text: "inspect the file" }] },
        { type: "reasoning", summary: [{ type: "summary_text", text: "inspect then read" }], content: [] },
        { type: "function_call", call_id: "call_1", name: "read_file", arguments: "{\"path\":\"README.md\"}" },
        {
          type: "function_call_output",
          call_id: "call_1",
          output: [
            { type: "input_text", text: "file bytes" },
            { type: "input_image", image_url: "https://example.test/shot.png" },
          ],
        },
      ]);
    }
  });

  test("explicit effort reaches Responses with adaptive thinking and takes precedence over legacy budgets", () => {
    const adapter = createResponsesAdapter({ adapter: "openai-responses", baseUrl: "https://api.openai.com/v1" });
    for (const thinking of [{ type: "adaptive" }, { type: "enabled", budget_tokens: 4096 }]) {
      const parsed = parseMessagesRequest({
        model: "gpt-6-astra",
        messages: [{ role: "user", content: "Hello" }],
        thinking,
        output_config: { effort: "xhigh" },
      });
      const body = JSON.parse(adapter.buildRequest(parsed).body);
      expect(body.reasoning.effort).toBe("xhigh");
    }
  });

  test("non-streaming bridge returns Anthropic Message JSON with text, thinking, tool_use, and usage", () => {
    const json = buildMessageJSON([
      { type: "thinking_delta", thinking: "plan" },
      { type: "text_delta", text: "Use " },
      { type: "text_delta", text: "tool" },
      { type: "tool_call_start", id: "call_1", name: "read_file" },
      { type: "tool_call_delta", arguments: "{\"path\":\"README.md\"}" },
      { type: "tool_call_end" },
      { type: "done", usage: { inputTokens: 12, outputTokens: 5, cachedInputTokens: 3 } },
    ], "provider/model-a", { hideThinkingSummary: false });

    expect(json).toMatchObject({ type: "message", role: "assistant", model: "provider/model-a", stop_reason: "tool_use" });
    expect(json.content).toEqual([
      { type: "thinking", thinking: "plan" },
      { type: "text", text: "Use tool" },
      { type: "tool_use", id: "call_1", name: "read_file", input: { path: "README.md" } },
    ]);
    expect(json.usage).toMatchObject({ input_tokens: 12, output_tokens: 5, cache_read_input_tokens: 3 });
  });

  test("streaming bridge emits Anthropic event order and input_json_delta for tool calls", async () => {
    const frames = await collectSse(bridgeToMessagesSSE(replay([
      { type: "text_delta", text: "hi" },
      { type: "tool_call_start", id: "call_1", name: "read_file" },
      { type: "tool_call_delta", arguments: "{\"path\":" },
      { type: "tool_call_delta", arguments: "\"README.md\"}" },
      { type: "tool_call_end" },
      { type: "done", usage: { inputTokens: 3, outputTokens: 2 } },
    ]), "provider/model-a"));

    expect(frames.map(f => f.event)).toEqual([
      "message_start",
      "content_block_start",
      "content_block_delta",
      "content_block_stop",
      "content_block_start",
      "content_block_delta",
      "content_block_delta",
      "content_block_stop",
      "message_delta",
      "message_stop",
    ]);
    expect(frames[5].data.delta).toMatchObject({ type: "input_json_delta", partial_json: "{\"path\":" });
    expect(frames[8].data.delta).toMatchObject({ stop_reason: "tool_use" });
  });

  test("OpenAI Responses adapter parses provider-internal Responses output for Messages responses", async () => {
    const adapter = createResponsesAdapter({ adapter: "openai-responses", baseUrl: "https://api.openai.test/v1", apiKey: "key" });
    const response = new Response(JSON.stringify({
      output: [
        { type: "message", content: [{ type: "output_text", text: "hello" }] },
        { type: "function_call", call_id: "call_1", name: "read_file", arguments: "{\"path\":\"x\"}" },
      ],
      usage: { input_tokens: 7, output_tokens: 4 },
    }), { headers: { "content-type": "application/json" } });

    const events = await adapter.parseResponse!(response);
    expect(events).toEqual([
      { type: "text_delta", text: "hello" },
      { type: "tool_call_start", id: "call_1", name: "read_file" },
      { type: "tool_call_delta", arguments: "{\"path\":\"x\"}" },
      { type: "tool_call_end" },
      { type: "done", usage: { inputTokens: 7, outputTokens: 4 } },
    ]);
  });

  test("count-token fallback is deterministic and handles images/tools without crashing", () => {
    const parsed = parseMessagesRequest({
      model: "provider/model-a",
      messages: [{ role: "user", content: [
        { type: "text", text: "hello" },
        { type: "image", source: { type: "base64", media_type: "image/png", data: "AAAA" } },
      ] }],
      tools: [{ name: "read_file", input_schema: { type: "object" } }],
    });
    expect(estimateMessagesInputTokens(parsed)).toBeGreaterThan(1000);
  });

  test("model discovery uses strict Anthropic list envelope", () => {
    const list = buildAnthropicModelsListFromAliases([
      {
        alias: "claude-frogp-provider-model-a",
        provider: "provider",
        model: "model-a",
        routeKey: "provider/model-a",
        displayName: "provider/model-a",
        createdAt: "1970-01-01T00:00:00.000Z",
      },
    ]);
    expect(list).toEqual({
      type: "list",
      data: [
        {
          id: "claude-frogp-provider-model-a",
          type: "model",
          display_name: "provider/model-a",
          created_at: "1970-01-01T00:00:00.000Z",
        },
      ],
      has_more: false,
      first_id: "claude-frogp-provider-model-a",
      last_id: "claude-frogp-provider-model-a",
    });
  });
  test("Anthropic error responses do not leak stacks and keep Anthropic envelope", async () => {
    const response = formatAnthropicErrorResponse(529, "upstream_error", "server is overloaded");
    expect(response.status).toBe(529);
    const json = await response.json() as Record<string, unknown>;
    expect(json).toEqual({ type: "error", error: { type: "overloaded_error", message: "server is overloaded" } });
  });
});

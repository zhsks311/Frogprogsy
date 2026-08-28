import { describe, expect, test } from "bun:test";
import { createKiroAdapter, __kiroEventStreamTestUtils } from "../src/adapters/kiro";
import { parseMessagesRequest } from "../src/messages/parser";
import { bridgeToMessagesSSE } from "../src/messages/bridge";
import type { ProviderAdapter } from "../src/adapters/base";
import type { AdapterEvent, FrogProviderConfig } from "../src/types";

const encoder = new TextEncoder();
interface KiroRequestBody {
  profileArn: string;
  conversationState: {
    history?: Array<{
      userInputMessage?: { content: string; userInputMessageContext?: Record<string, unknown> };
      assistantResponseMessage?: { content: string; toolUses?: unknown[] };
    }>;
    currentMessage: {
      userInputMessage: {
        modelId: string;
        userInputMessageContext?: { tools?: unknown[]; toolResults?: unknown[] };
      };
    };
  };
}


function eventMessage(payload: Record<string, unknown>, extraHeaders: Record<string, string> = {}): Uint8Array {
  const headers: number[] = [];
  for (const [name, value] of Object.entries({
    ":message-type": "event",
    ":event-type": "assistantResponseEvent",
    ":content-type": "application/json",
    ...extraHeaders,
  })) {
    const nameBytes = encoder.encode(name);
    const valueBytes = encoder.encode(value);
    headers.push(nameBytes.length, ...nameBytes, 7, valueBytes.length >>> 8, valueBytes.length & 0xff, ...valueBytes);
  }
  const payloadBytes = __kiroEventStreamTestUtils.encodePayloadForTest(payload);
  const totalLength = 16 + headers.length + payloadBytes.length;
  const output = new Uint8Array(totalLength);
  const view = new DataView(output.buffer);
  view.setUint32(0, totalLength, false);
  view.setUint32(4, headers.length, false);
  view.setUint32(8, __kiroEventStreamTestUtils.crc32(output.subarray(0, 8)), false);
  output.set(headers, 12);
  output.set(payloadBytes, 12 + headers.length);
  view.setUint32(totalLength - 4, __kiroEventStreamTestUtils.crc32(output.subarray(0, totalLength - 4)), false);
  return output;
}

function concatBytes(...parts: Uint8Array[]): Uint8Array {
  const output = new Uint8Array(parts.reduce((sum, part) => sum + part.length, 0));
  let offset = 0;
  for (const part of parts) {
    output.set(part, offset);
    offset += part.length;
  }
  return output;
}

function responseFromChunks(chunks: Uint8Array[]): Response {
  return new Response(new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(chunk);
      controller.close();
    },
  }), { headers: { "content-type": "application/vnd.amazon.eventstream" } });
}

async function collectEvents(adapter: ProviderAdapter, response: Response): Promise<AdapterEvent[]> {
  const events: AdapterEvent[] = [];
  for await (const event of adapter.parseStream(response)) events.push(event);
  return events;
}

function authenticatedProvider(): FrogProviderConfig {
  return {
    adapter: "kiro",
    baseUrl: "https://runtime.us-east-1.kiro.dev",
    authMode: "oauth",
    apiKey: "test-access-token",
    runtimeAuth: {
      kind: "kiro",
      region: "eu-central-1",
      profileArn: "arn:aws:codewhisperer:eu-central-1:000000000000:profile/test",
    },
  };
}

describe("Kiro adapter request mapping", () => {
  test("routes the selected model, history, tools, and profile to the credential region", () => {
    const adapter = createKiroAdapter(authenticatedProvider());
    const parsed = parseMessagesRequest({
      model: "claude-sonnet-4.6",
      max_tokens: 1024,
      stream: true,
      system: "Keep changes narrow.",
      tools: [{
        name: "read_file",
        description: "Read one file",
        input_schema: {
          type: "object",
          properties: {
            path: { type: "string", additionalProperties: false },
            options: { anyOf: [{ type: "object", required: [], additionalProperties: false }] },
            additionalProperties: { type: "string" },
          },
          required: ["path"],
          additionalProperties: false,
        },
      }],
      messages: [
        { role: "user", content: "Inspect the source." },
        { role: "assistant", content: [{ type: "text", text: "I will inspect it." }] },
        { role: "user", content: "Continue." },
      ],
    });

    const request = adapter.buildRequest(parsed);
    const body = JSON.parse(request.body) as KiroRequestBody;

    expect(request.url).toBe("https://runtime.eu-central-1.kiro.dev/generateAssistantResponse");
    expect(request.headers.Authorization).toBe("Bearer test-access-token");
    expect(request.headers["x-amzn-codewhisperer-optout"]).toBe("true");
    expect(body.profileArn).toBe("arn:aws:codewhisperer:eu-central-1:000000000000:profile/test");
    expect(body.conversationState.history![0]!.userInputMessage!.content).toContain("Keep changes narrow.");
    expect(body.conversationState.currentMessage.userInputMessage.modelId).toBe("claude-sonnet-4.6");
    expect(body.conversationState.currentMessage.userInputMessage.userInputMessageContext!.tools![0]).toEqual({
      toolSpecification: {
        name: "read_file",
        description: "Read one file",
        inputSchema: {
          json: {
            type: "object",
            properties: {
              path: { type: "string" },
              options: { anyOf: [{ type: "object" }] },
              additionalProperties: { type: "string" },
            },
            required: ["path"],
          },
        },
      },
    });
  });

  test("turns orphan tool history into valid Kiro context without silently inventing an enabled tool", () => {
    const parsed = parseMessagesRequest({
      model: "claude-sonnet-4.6",
      max_tokens: 64,
      messages: [
        { role: "user", content: "Inspect the source." },
        { role: "assistant", content: [{ type: "tool_use", id: "tool-1", name: "read_file", input: { path: "src/index.ts" } }] },
        { role: "user", content: [{ type: "tool_result", tool_use_id: "tool-1", content: "file contents" }] },
      ],
    });

    const body = JSON.parse(createKiroAdapter(authenticatedProvider()).buildRequest(parsed).body) as KiroRequestBody;

    expect(body.conversationState.currentMessage.userInputMessage.userInputMessageContext).toBeUndefined();
    expect(JSON.stringify(body)).toContain("Tool call read_file");
    expect(JSON.stringify(body)).toContain("Tool result for read_file");
    expect(JSON.stringify(body)).not.toContain("\"toolResults\"");
  });

  test("keeps parallel tool results in one Kiro user-result batch", () => {
    const parsed = parseMessagesRequest({
      model: "claude-sonnet-4.6",
      max_tokens: 64,
      tools: [
        { name: "read_file", description: "Read a file", input_schema: { type: "object" } },
        { name: "write_file", description: "Write a file", input_schema: { type: "object" } },
      ],
      messages: [
        { role: "user", content: "Update both files." },
        {
          role: "assistant",
          content: [
            { type: "tool_use", id: "tool-1", name: "read_file", input: { path: "a.ts" } },
            { type: "tool_use", id: "tool-2", name: "write_file", input: { path: "b.ts", content: "next" } },
          ],
        },
        {
          role: "user",
          content: [
            { type: "tool_result", tool_use_id: "tool-1", content: "old" },
            { type: "tool_result", tool_use_id: "tool-2", content: "written" },
          ],
        },
      ],
    });

    const body = JSON.parse(createKiroAdapter(authenticatedProvider()).buildRequest(parsed).body) as KiroRequestBody;
    const assistant = body.conversationState.history?.find(entry => entry.assistantResponseMessage)?.assistantResponseMessage;
    const toolResults = body.conversationState.currentMessage.userInputMessage.userInputMessageContext?.toolResults;

    expect(assistant?.toolUses).toHaveLength(2);
    expect(toolResults).toHaveLength(2);
    expect(JSON.stringify(body)).not.toContain("(tool call)");
  });

  test("fails closed when request-scoped Kiro metadata is absent", () => {
    const adapter = createKiroAdapter({
      adapter: "kiro",
      baseUrl: "https://runtime.us-east-1.kiro.dev",
      authMode: "oauth",
      apiKey: "test-access-token",
    });
    const parsed = parseMessagesRequest({ model: "claude-sonnet-4.6", max_tokens: 64, messages: [{ role: "user", content: "hello" }] });

    expect(() => adapter.buildRequest(parsed)).toThrow("frogp login kiro");
  });
});

describe("Kiro AWS event-stream mapping", () => {
  test("reassembles binary frame boundaries while preserving tool JSON fragments", async () => {
    const stream = concatBytes(
      eventMessage({ content: "Checking" }),
      eventMessage({ content: "Checking" }),
      eventMessage({ name: "read_file", toolUseId: "tool-1", input: {} }),
      eventMessage({ input: "{\"path\":" }),
      eventMessage({ input: "\"src/index.ts\"}" }),
      eventMessage({ stop: true }),
    );
    const split = [stream.slice(0, 7), stream.slice(7, 41), stream.slice(41, stream.length - 3), stream.slice(stream.length - 3)];

    const events = await collectEvents(createKiroAdapter(authenticatedProvider()), responseFromChunks(split));

    expect(events).toEqual([
      { type: "text_delta", text: "Checking" },
      { type: "tool_call_start", id: "tool-1", name: "read_file" },
      { type: "tool_call_delta", arguments: "{\"path\":" },
      { type: "tool_call_delta", arguments: "\"src/index.ts\"}" },
      { type: "tool_call_end" },
      { type: "done", stopReason: "tool_use" },
    ]);
  });

  test("closes an active tool before a second source-verified Kiro tool-start event", async () => {
    const stream = concatBytes(
      eventMessage({ name: "first_tool", toolUseId: "tool-1", input: "{\"a\":1}" }),
      eventMessage({ name: "second_tool", toolUseId: "tool-2", input: {} }),
      eventMessage({ input: "{\"b\":2}" }),
      eventMessage({ stop: true }),
    );

    const events = await collectEvents(createKiroAdapter(authenticatedProvider()), responseFromChunks([stream]));

    expect(events).toEqual([
      { type: "tool_call_start", id: "tool-1", name: "first_tool" },
      { type: "tool_call_delta", arguments: "{\"a\":1}" },
      { type: "tool_call_end" },
      { type: "tool_call_start", id: "tool-2", name: "second_tool" },
      { type: "tool_call_delta", arguments: "{\"b\":2}" },
      { type: "tool_call_end" },
      { type: "done", stopReason: "tool_use" },
    ]);
  });

  test("preserves partial tool JSON through the Claude Messages SSE bridge", async () => {
    const stream = concatBytes(
      eventMessage({ name: "read_file", toolUseId: "tool-1", input: {} }),
      eventMessage({ input: "{\"path\":" }),
      eventMessage({ input: "\"src/index.ts\"}" }),
      eventMessage({ stop: true }),
    );
    const adapterEvents = createKiroAdapter(authenticatedProvider()).parseStream(responseFromChunks([stream]));
    const sse = await new Response(bridgeToMessagesSSE(adapterEvents, "kiro/claude-sonnet-4.6", undefined, 60_000)).text();
    const data = sse.split("\n")
      .filter(line => line.startsWith("data: "))
      .map(line => JSON.parse(line.slice(6)) as { delta?: { type?: string; partial_json?: string } });
    const partialJson = data
      .filter(event => event.delta?.type === "input_json_delta")
      .map(event => event.delta?.partial_json ?? "")
      .join("");

    expect(partialJson).toBe("{\"path\":\"src/index.ts\"}");
    expect(sse).toContain("\"stop_reason\":\"tool_use\"");
    expect(sse).not.toContain("\"type\":\"error\"");
  });

  test("maps inline exceptions to a fixed terminal error without a success trailer", async () => {
    const frame = eventMessage(
      { message: "upstream body must not be relayed" },
      { ":message-type": "exception", ":exception-type": "AccessDeniedException" },
    );

    const events = await collectEvents(createKiroAdapter(authenticatedProvider()), responseFromChunks([frame]));

    expect(events).toEqual([{ type: "error", message: "Kiro upstream stream error (AccessDeniedException)" }]);
    expect(JSON.stringify(events)).not.toContain("upstream body");
    expect(events.some(event => event.type === "done")).toBe(false);
  });

  test("rejects a truncated binary frame instead of returning partial success", async () => {
    const frame = eventMessage({ content: "partial" });

    const events = await collectEvents(createKiroAdapter(authenticatedProvider()), responseFromChunks([frame.slice(0, frame.length - 2)]));

    expect(events).toEqual([{ type: "error", message: "Kiro upstream returned a malformed event stream" }]);
  });
});

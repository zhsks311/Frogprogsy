import { describe, expect, jest, test } from "bun:test";
import { createAnthropicAdapter } from "../src/adapters/anthropic";
import { bridgeToMessagesSSE } from "../src/messages/bridge";
import type { AdapterEvent } from "../src/types";

async function* replay(events: AdapterEvent[]): AsyncGenerator<AdapterEvent> {
  for (const event of events) yield event;
}

async function collectText(stream: ReadableStream<Uint8Array>): Promise<string> {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let text = "";
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    text += decoder.decode(value, { stream: true });
  }
  return text;
}

describe("Anthropic Messages bridge lifecycle", () => {
  test("client cancellation invokes upstream cancellation hook", async () => {
    let cancelled = 0;
    const blocker = Promise.withResolvers<void>();
    async function* slowEvents(): AsyncGenerator<AdapterEvent> {
      yield { type: "text_delta", text: "partial" };
      await blocker.promise;
    }

    const stream = bridgeToMessagesSSE(slowEvents(), "model-a", () => {
      cancelled++;
      blocker.resolve();
    });
    const reader = stream.getReader();
    await reader.read();
    await reader.cancel("client closed");

    expect(cancelled).toBe(1);
  });

  test("adapter error emits Anthropic error event and closes without message_stop", async () => {
    const text = await collectText(bridgeToMessagesSSE(replay([
      { type: "text_delta", text: "before" },
      { type: "error", message: "upstream exploded" },
    ]), "model-a"));

    expect(text).toContain("event: message_start");
    expect(text).toContain("event: content_block_start");
    expect(text).toContain("event: content_block_stop");
    expect(text).toContain("event: error");

    expect(text).toContain('"type":"api_error"');
    expect(text).toContain("upstream exploded");
    expect(text).not.toContain("event: message_stop");
  });

  test("quota errors use the Anthropic billing error type", async () => {
    const text = await collectText(bridgeToMessagesSSE(replay([
      { type: "error", message: "insufficient_quota" },
    ]), "model-a"));

    expect(text).toContain('"type":"billing_error"');
    expect(text).not.toContain("event: message_stop");
  });


  test("iterator EOF without an explicit terminal event fails closed", async () => {
    const text = await collectText(bridgeToMessagesSSE(replay([
      { type: "text_delta", text: "partial" },
    ]), "model-a"));

    expect(text).toContain("event: content_block_stop");
    expect(text).toContain("event: error");
    expect(text).toContain("upstream stream ended without a terminal event");
    expect(text).not.toContain("event: message_delta");
    expect(text).not.toContain("event: message_stop");
  });

  test("Anthropic adapter EOF without message_delta fails closed", async () => {
    const adapter = createAnthropicAdapter({ adapter: "anthropic", baseUrl: "https://example.test" });
    const upstream = new Response([
      'data: {"type":"message_start","message":{"usage":{"input_tokens":1,"output_tokens":0}}}\n\n',
      'data: {"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}\n\n',
      'data: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"partial"}}\n\n',
    ].join(""));
    const text = await collectText(bridgeToMessagesSSE(adapter.parseStream(upstream), "model-a"));

    expect(text).toContain("partial");
    expect(text).toContain("event: error");
    expect(text).not.toContain("event: message_stop");
  });

  test("upstream stall emits one error and cancels upstream once", async () => {
    jest.useFakeTimers();
    try {
      let cancelled = 0;
      const blocked = Promise.withResolvers<void>();
      const waiting = Promise.withResolvers<void>();
      async function* stalledEvents(): AsyncGenerator<AdapterEvent> {
        yield { type: "text_delta", text: "partial" };
        waiting.resolve();
        await blocked.promise;
      }

      const collecting = collectText(bridgeToMessagesSSE(
        stalledEvents(),
        "model-a",
        () => {
          cancelled++;
          blocked.resolve();
        },
        10,
        { stallTimeoutSec: 1 },
      ));
      await waiting.promise;
      jest.advanceTimersByTime(1_010);
      const text = await collecting;

      expect((text.match(/event: error/g) ?? [])).toHaveLength(1);
      expect(text).toContain("upstream stream stalled");
      expect(text).not.toContain("event: message_stop");
      expect(cancelled).toBe(1);
    } finally {
      jest.useRealTimers();
    }
  });

  test("hidden thinking activity resets the stall deadline", async () => {
    jest.useFakeTimers();
    try {
      const releaseThinking = Promise.withResolvers<void>();
      const thinkingConsumed = Promise.withResolvers<void>();
      const releaseDone = Promise.withResolvers<void>();
      async function* thinkingEvents(): AsyncGenerator<AdapterEvent> {
        await releaseThinking.promise;
        yield { type: "thinking_delta", thinking: "hidden" };
        thinkingConsumed.resolve();
        await releaseDone.promise;
        yield { type: "done" };
      }

      const collecting = collectText(bridgeToMessagesSSE(
        thinkingEvents(),
        "model-a",
        undefined,
        10,
        { hideThinkingSummary: true, stallTimeoutSec: 1 },
      ));
      jest.advanceTimersByTime(900);
      releaseThinking.resolve();
      await thinkingConsumed.promise;
      jest.advanceTimersByTime(200);
      releaseDone.resolve();
      const text = await collecting;

      expect(text).toContain("event: message_stop");
      expect(text).not.toContain("event: error");
      expect(text).not.toContain("hidden");
    } finally {
      jest.useRealTimers();
    }
  });

  test("terminal done without content still emits message_delta and message_stop", async () => {
    const text = await collectText(bridgeToMessagesSSE(replay([
      { type: "done", usage: { inputTokens: 1, outputTokens: 0 } },
    ]), "model-a"));

    expect(text).toContain("event: message_start");
    expect(text).toContain("event: message_delta");
    expect(text).toContain('"stop_reason":"end_turn"');
    expect(text).toContain('"input_tokens":1');
    expect(text).toContain("event: message_stop");
  });
});

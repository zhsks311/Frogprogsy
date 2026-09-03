import { afterEach, beforeEach, describe, expect, jest, test } from "bun:test";
import { __requestLogTest } from "../src/server";
import { bridgeToMessagesSSE } from "../src/messages/bridge";
import type { AdapterEvent, FrogConfig } from "../src/types";
import { readUsageEntries } from "../src/usage-log";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

let usageHome = "";
let previousFrogHome: string | undefined;

beforeEach(() => {
  previousFrogHome = process.env.FROGPROGSY_HOME;
  usageHome = mkdtempSync(join(tmpdir(), "frog-usage-log-"));
  process.env.FROGPROGSY_HOME = usageHome;
});

afterEach(() => {
  if (previousFrogHome === undefined) delete process.env.FROGPROGSY_HOME;
  else process.env.FROGPROGSY_HOME = previousFrogHome;
  if (usageHome) rmSync(usageHome, { recursive: true, force: true });
  usageHome = "";
});

function asText(value: unknown): string {
  return JSON.stringify(value);
}

describe("privacy-safe request logs", () => {
  test("persisted provider failures store structured codes, not free-form snippets", () => {
    __requestLogTest.clear();
    const ctx = __requestLogTest.createRequestLog("/v1/messages", "POST", new Headers({ "content-length": "123" }));
    ctx.entry.route.provider = "codex";
    ctx.entry.route.routedModelLabel = "gpt-5.5";
    ctx.entry.upstream = { status: 400, contentTypeFamily: "json" };

    __requestLogTest.finalizeRequestLog(ctx, "provider_non_2xx", 400, {
      kind: "upstream",
      code: "provider_non_2xx",
      upstreamStatus: 400,
    });

    const [entry] = __requestLogTest.requestLogSnapshot();
    expect(entry).toMatchObject({
      lifecycle: "provider_non_2xx",
      endpoint: "/v1/messages",
      method: "POST",
      status: 400,
      request: { requestBytes: 123 },
      route: { provider: "codex", routedModelLabel: "gpt-5.5" },
      error: { kind: "upstream", code: "provider_non_2xx", upstreamStatus: 400 },
    });

    expect("timestamp" in entry).toBe(false);
    expect(typeof entry.error).toBe("object");
    const serialized = asText(entry);
    for (const forbidden of [
      "sk-test-secret",
      "Bearer abc.def.ghi",
      "Authorization",
      "cookie=secret",
      "user@example.com",
      "/Users/alice/private-project",
      "prompt text echoed by provider",
      "tool args",
      "provider raw body",
    ]) {
      expect(serialized).not.toContain(forbidden);
    }
  });

  test("stream observation finalizes completed lifecycle and byte counts", async () => {
    __requestLogTest.clear();
    const ctx = __requestLogTest.createRequestLog("/v1/messages", "POST", new Headers());
    const encoder = new TextEncoder();
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(encoder.encode("abc"));
        controller.enqueue(encoder.encode("de"));
        controller.close();
      },
    });

    const reader = __requestLogTest.observeLoggedStream(stream, ctx).getReader();
    while (!(await reader.read()).done) {
      // drain
    }

    const [entry] = __requestLogTest.requestLogSnapshot();
    expect(entry.lifecycle).toBe("completed");
    expect(entry.status).toBe(200);
    expect(entry.upstream?.responseBytes).toBe(5);
    expect(entry.phases.some(phase => phase.name === "stream_bridge" && phase.status === "ok")).toBe(true);
  });
  test("adapter stream errors finalize as provider stream failures", async () => {
    __requestLogTest.clear();
    const ctx = __requestLogTest.createRequestLog("/v1/messages", "POST", new Headers());

    async function* errorEvents(): AsyncGenerator<AdapterEvent> {
      yield { type: "error", message: "Upstream completed without assistant output" };
    }

    const events = __requestLogTest.observeUsageEvents(errorEvents(), ctx);
    const bridged = bridgeToMessagesSSE(events, "gpt-5.6-sol");
    const body = await new Response(__requestLogTest.observeLoggedStream(bridged, ctx)).text();

    expect(body).toContain("event: error");
    expect(body).toContain("Upstream completed without assistant output");
    const [entry] = __requestLogTest.requestLogSnapshot();
    expect(entry.lifecycle).toBe("bridge_error");
    expect(entry.status).toBe(502);
    expect(entry.error).toEqual({ kind: "upstream", code: "provider_stream_error" });
    expect(entry.phases.some(phase =>
      phase.name === "stream_bridge"
      && phase.status === "error"
      && phase.code === "provider_stream_error"
    )).toBe(true);
  });

  test("synthesized stream stalls finalize as bridge errors", async () => {
    jest.useFakeTimers();
    try {
      __requestLogTest.clear();
      const ctx = __requestLogTest.createRequestLog("/v1/messages", "POST", new Headers());
      const blocked = Promise.withResolvers<void>();
      const waiting = Promise.withResolvers<void>();
      async function* stalledEvents(): AsyncGenerator<AdapterEvent> {
        yield { type: "text_delta", text: "partial" };
        waiting.resolve();
        await blocked.promise;
      }

      const bridged = bridgeToMessagesSSE(
        stalledEvents(),
        "gpt-5.6-sol",
        () => blocked.resolve(),
        10,
        {
          stallTimeoutSec: 1,
          onTerminalError: code => {
            ctx.entry.error = { kind: "upstream", code };
          },
        },
      );
      const collecting = new Response(__requestLogTest.observeLoggedStream(bridged, ctx)).text();
      await waiting.promise;
      jest.advanceTimersByTime(1_010);
      const body = await collecting;

      expect(body).toContain("event: error");
      const [entry] = __requestLogTest.requestLogSnapshot();
      expect(entry.lifecycle).toBe("bridge_error");
      expect(entry.status).toBe(502);
      expect(entry.error).toEqual({ kind: "upstream", code: "upstream_stall_timeout" });
    } finally {
      jest.useRealTimers();
    }
  });

  test("stream cancellation finalizes client_cancel once", async () => {
    __requestLogTest.clear();
    const ctx = __requestLogTest.createRequestLog("/v1/messages", "POST", new Headers());
    const encoder = new TextEncoder();
    const stream = new ReadableStream<Uint8Array>({
      pull(controller) {
        controller.enqueue(encoder.encode("chunk"));
      },
    });

    const reader = __requestLogTest.observeLoggedStream(stream, ctx).getReader();
    await reader.read();
    await reader.cancel("client closed");
    __requestLogTest.finalizeRequestLog(ctx, "completed", 200);

    const [entry] = __requestLogTest.requestLogSnapshot();
    expect(entry.lifecycle).toBe("client_cancel");
    expect(entry.status).toBe(499);
    expect(entry.error).toEqual({ kind: "internal", code: "client_cancel" });
    expect(entry.phases.filter(phase => phase.name === "finalize")).toHaveLength(1);
  });

  test("management snapshots are defensive copies", () => {
    __requestLogTest.clear();
    const ctx = __requestLogTest.createRequestLog("/v1/messages/count_tokens", "POST", new Headers());
    __requestLogTest.finalizeRequestLog(ctx, "completed", 200);

    const snapshot = __requestLogTest.requestLogSnapshot();
    snapshot[0].route.provider = "mutated";

    expect(__requestLogTest.requestLogSnapshot()[0].route.provider).toBe("unknown");
  });

  test("non-stream bridge failures finalize without persisting provider body", async () => {
    __requestLogTest.clear();
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async () => new Response("provider raw body with secret-token", {
      status: 200,
      headers: { "content-type": "application/json" },
    })) as typeof fetch;
    try {
      const ctx = __requestLogTest.createRequestLog("/v1/messages", "POST", new Headers());
      const response = await __requestLogTest.handleMessages(
        new Request("http://127.0.0.1/v1/messages", {
          method: "POST",
          body: JSON.stringify({
            model: "claude-opus-4-8",
            max_tokens: 10,
            messages: [{ role: "user", content: "hello" }],
          }),
        }),
        {
          port: 10100,
          defaultProvider: "codex",
          providers: {
            codex: {
              adapter: "openai-responses",
              baseUrl: "https://chatgpt.test/backend-api/codex",
              defaultModel: "gpt-5.5",
              apiKey: "test-key",
            },
          },
        },
        ctx,
      );

      const [entry] = __requestLogTest.requestLogSnapshot();
      expect(response.status).toBe(502);
      expect(entry.lifecycle).toBe("bridge_error");
      expect(entry.error).toEqual({ kind: "bridge", code: "bridge_parse_error" });
      expect(entry.phases.some(phase => phase.name === "nonstream_bridge" && phase.status === "error")).toBe(true);
      expect(asText(entry)).not.toContain("provider raw body");
      expect(asText(entry)).not.toContain("secret-token");
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test("Codex non-stream messages use streaming upstream and bridge back to JSON", async () => {
    __requestLogTest.clear();
    const originalFetch = globalThis.fetch;
    let upstreamBody: Record<string, unknown> | undefined;
    globalThis.fetch = (async (_url, init) => {
      upstreamBody = JSON.parse(String(init?.body)) as Record<string, unknown>;
      const body = [
        "event: response.output_text.delta",
        "data: {\"type\":\"response.output_text.delta\",\"delta\":\"OK\"}",
        "",
        "event: response.completed",
        "data: {\"type\":\"response.completed\",\"response\":{\"usage\":{\"input_tokens\":3,\"output_tokens\":1}}}",
        "",
      ].join("\n");
      return new Response(body, { status: 200, headers: { "content-type": "text/event-stream" } });
    }) as typeof fetch;

    try {
      const ctx = __requestLogTest.createRequestLog("/v1/messages", "POST", new Headers());
      const response = await __requestLogTest.handleMessages(
        new Request("http://127.0.0.1/v1/messages", {
          method: "POST",
          body: JSON.stringify({
            model: "gpt-5.5",
            max_tokens: 10,
            messages: [{ role: "user", content: "hello" }],
            stream: false,
          }),
        }),
        {
          port: 10100,
          defaultProvider: "codex",
          providers: {
            codex: {
              adapter: "openai-responses",
              baseUrl: "https://chatgpt.com/backend-api/codex",
              defaultModel: "gpt-5.5",
              apiKey: "test-key",
            },
          },
        },
        ctx,
      );

      const json = await response.json() as Record<string, unknown>;
      const [entry] = __requestLogTest.requestLogSnapshot();
      expect(response.status).toBe(200);
      expect(upstreamBody?.stream).toBe(true);
      expect(json).toMatchObject({
        type: "message",
        role: "assistant",
        model: "gpt-5.5",
        content: [{ type: "text", text: "OK" }],
        usage: { input_tokens: 3, output_tokens: 1 },
      });
      expect(entry.phases.some(phase => phase.name === "nonstream_bridge" && phase.status === "ok")).toBe(true);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
  test("Codex stream flushes an unterminated terminal frame through /v1/messages", async () => {
    __requestLogTest.clear();
    const originalFetch = globalThis.fetch;
    let aborted = 0;
    globalThis.fetch = (async (_url, init) => {
      init?.signal?.addEventListener("abort", () => {
        aborted++;
      });
      return new Response([
        "event: response.created",
        "data: {\"type\":\"response.created\",\"response\":{\"status\":\"in_progress\"}}",
        "",
        ": upstream keepalive",
        "",
        "event: response.in_progress",
        "data: {\"type\":\"response.in_progress\",\"response\":{\"status\":\"in_progress\"}}",
        "",
        "event: response.completed",
        "data: {\"type\":\"response.completed\",\"response\":{\"status\":\"completed\",\"output\":[{\"type\":\"message\",\"content\":[{\"type\":\"output_text\",\"text\":\"Recovered\"}]}],\"usage\":{\"input_tokens\":2,\"output_tokens\":1}}}",
      ].join("\n"), {
        status: 200,
        headers: { "content-type": "text/event-stream" },
      });
    }) as typeof fetch;

    try {
      const ctx = __requestLogTest.createRequestLog("/v1/messages", "POST", new Headers());
      const response = await __requestLogTest.handleMessages(
        new Request("http://127.0.0.1/v1/messages", {
          method: "POST",
          body: JSON.stringify({
            model: "gpt-5.5",
            max_tokens: 10,
            messages: [{ role: "user", content: "hello" }],
            stream: true,
          }),
        }),
        {
          port: 10100,
          defaultProvider: "codex",
          providers: {
            codex: {
              adapter: "openai-responses",
              baseUrl: "https://chatgpt.com/backend-api/codex",
              defaultModel: "gpt-5.5",
              apiKey: "test-key",
            },
          },
        },
        ctx,
      );
      const body = await response.text();

      expect(body).toContain("Recovered");
      expect(body).toContain("event: message_stop");
      expect(body).not.toContain("event: error");
      expect(aborted).toBe(0);
      const [entry] = __requestLogTest.requestLogSnapshot();
      expect(entry.lifecycle).toBe("completed");
      expect(entry.error).toBeUndefined();
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test("Codex bare stream EOF fails closed once without synthesizing success", async () => {
    __requestLogTest.clear();
    const originalFetch = globalThis.fetch;
    let aborted = 0;
    globalThis.fetch = (async (_url, init) => {
      init?.signal?.addEventListener("abort", () => {
        aborted++;
      });
      return new Response([
        "event: response.created",
        "data: {\"type\":\"response.created\",\"response\":{\"status\":\"in_progress\"}}",
        "",
        "event: response.output_text.delta",
        "data: {\"type\":\"response.output_text.delta\",\"delta\":\"partial\"}",
        "",
      ].join("\n"), {
        status: 200,
        headers: { "content-type": "text/event-stream" },
      });
    }) as typeof fetch;

    try {
      const ctx = __requestLogTest.createRequestLog("/v1/messages", "POST", new Headers());
      const response = await __requestLogTest.handleMessages(
        new Request("http://127.0.0.1/v1/messages", {
          method: "POST",
          body: JSON.stringify({
            model: "gpt-5.5",
            max_tokens: 10,
            messages: [{ role: "user", content: "hello" }],
            stream: true,
          }),
        }),
        {
          port: 10100,
          defaultProvider: "codex",
          providers: {
            codex: {
              adapter: "openai-responses",
              baseUrl: "https://chatgpt.com/backend-api/codex",
              defaultModel: "gpt-5.5",
              apiKey: "test-key",
            },
          },
        },
        ctx,
      );
      const body = await response.text();

      expect((body.match(/event: error/g) ?? [])).toHaveLength(1);
      expect(body).toContain("upstream stream ended without a terminal event");
      expect(body).not.toContain("event: message_stop");
      expect(aborted).toBe(0);
      const [entry] = __requestLogTest.requestLogSnapshot();
      expect(entry.lifecycle).toBe("bridge_error");
      expect(entry.error).toEqual({ kind: "upstream", code: "adapter_eof" });
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test("Codex empty non-stream completions return a visible upstream error", async () => {
    __requestLogTest.clear();
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async () => {
      const body = [
        "event: response.completed",
        "data: {\"type\":\"response.completed\",\"response\":{\"status\":\"completed\",\"output\":[],\"usage\":null}}",
        "",
      ].join("\n");
      return new Response(body, { status: 200, headers: { "content-type": "text/event-stream" } });
    }) as typeof fetch;

    try {
      const ctx = __requestLogTest.createRequestLog("/v1/messages", "POST", new Headers());
      const response = await __requestLogTest.handleMessages(
        new Request("http://127.0.0.1/v1/messages", {
          method: "POST",
          body: JSON.stringify({
            model: "gpt-5.6-sol",
            max_tokens: 10,
            messages: [{ role: "user", content: "hello" }],
            stream: false,
          }),
        }),
        {
          port: 10100,
          defaultProvider: "codex",
          providers: {
            codex: {
              adapter: "openai-responses",
              baseUrl: "https://chatgpt.com/backend-api/codex",
              defaultModel: "gpt-5.6-sol",
              apiKey: "test-key",
            },
          },
        },
        ctx,
      );

      expect(response.status).toBe(502);
      expect(await response.json()).toMatchObject({
        type: "error",
        error: {
          type: "api_error",
          message: "Upstream completed without assistant output",
        },
      });
      const [entry] = __requestLogTest.requestLogSnapshot();
      expect(entry.lifecycle).toBe("bridge_error");
      expect(entry.status).toBe(502);
      expect(entry.error).toEqual({ kind: "upstream", code: "provider_response_error" });
      expect(entry.phases.some(phase =>
        phase.name === "nonstream_bridge"
        && phase.status === "error"
        && phase.code === "provider_response_error"
      )).toBe(true);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test("messages preserve safe upstream usage headers and keep partial cache usage unavailable", async () => {
    __requestLogTest.clear();
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async () => new Response(JSON.stringify({
      id: "msg_1",
      type: "message",
      role: "assistant",
      model: "claude-sonnet-4-6",
      content: [{ type: "text", text: "OK" }],
      usage: { input_tokens: 11, output_tokens: 7, cache_read_input_tokens: 3 },
    }), {
      status: 200,
      headers: {
        "content-type": "application/json",
        "anthropic-ratelimit-unified-reset": "2026-06-29T00:00:00Z",
        "x-claude-primary-used-percent": "42",
        "set-cookie": "must-not-leak=true",
      },
    })) as typeof fetch;

    try {
      const ctx = __requestLogTest.createRequestLog("/v1/messages", "POST", new Headers());
      const response = await __requestLogTest.handleMessages(
        new Request("http://127.0.0.1/v1/messages", {
          method: "POST",
          body: JSON.stringify({
            model: "anthropic/claude-sonnet-4-6",
            max_tokens: 10,
            messages: [{ role: "user", content: "hello" }],
          }),
        }),
        {
          port: 10100,
          defaultProvider: "anthropic",
          providers: {
            anthropic: {
              adapter: "anthropic",
              baseUrl: "https://api.anthropic.test",
              defaultModel: "claude-sonnet-4-6",
              apiKey: "test-key",
            },
          },
        },
        ctx,
      );

      expect(response.status).toBe(200);
      expect(response.headers.get("anthropic-ratelimit-unified-reset")).toBe("2026-06-29T00:00:00Z");
      expect(response.headers.get("x-claude-primary-used-percent")).toBe("42");
      expect(response.headers.get("set-cookie")).toBeNull();

      __requestLogTest.finalizeRequestLog(ctx, "completed", 200);

      const summary = __requestLogTest.usageSummarySnapshot();
      expect(summary.summary).toMatchObject({
        requests: 1,
        reportedRequests: 1,
        unreportedRequests: 0,
        inputTokens: 11,
        outputTokens: 7,
        cachedInputTokens: 0,
        totalTokens: 18,
      });
      expect(summary.providers[0]).toMatchObject({ provider: "anthropic", totalTokens: 18 });
      expect(summary.models[0]).toMatchObject({ provider: "anthropic", model: "claude-sonnet-4-6", inputTokens: 11, outputTokens: 7 });
      const [persisted] = readUsageEntries();
      expect(persisted).toMatchObject({
        cacheUsageStatus: "unavailable",
        cacheUsageSemantics: "anthropic_separate_input_buckets",
        usage: { inputTokens: 11, outputTokens: 7, cacheReadInputTokens: 3 },
      });
      expect(persisted.usage).not.toHaveProperty("cachedInputTokens");
      expect(persisted.usage).not.toHaveProperty("cacheCreationInputTokens");
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test("streamed messages aggregate terminal usage", async () => {
    __requestLogTest.clear();
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async () => {
      const body = [
        "event: message_start",
        "data: {\"type\":\"message_start\",\"message\":{\"id\":\"msg_1\",\"type\":\"message\",\"role\":\"assistant\",\"content\":[],\"model\":\"claude-sonnet-4-6\"}}",
        "",
        "event: content_block_start",
        "data: {\"type\":\"content_block_start\",\"index\":0,\"content_block\":{\"type\":\"text\",\"text\":\"\"}}",
        "",
        "event: content_block_delta",
        "data: {\"type\":\"content_block_delta\",\"index\":0,\"delta\":{\"type\":\"text_delta\",\"text\":\"OK\"}}",
        "",
        "event: message_delta",
        "data: {\"type\":\"message_delta\",\"delta\":{\"stop_reason\":\"end_turn\",\"stop_sequence\":null},\"usage\":{\"input_tokens\":5,\"output_tokens\":2}}",
        "",
        "event: message_stop",
        "data: {\"type\":\"message_stop\"}",
        "",
      ].join("\n");
      return new Response(body, {
        status: 200,
        headers: {
          "content-type": "text/event-stream",
          "anthropic-ratelimit-unified-remaining": "58",
        },
      });
    }) as typeof fetch;

    try {
      const ctx = __requestLogTest.createRequestLog("/v1/messages", "POST", new Headers());
      const response = await __requestLogTest.handleMessages(
        new Request("http://127.0.0.1/v1/messages", {
          method: "POST",
          body: JSON.stringify({
            model: "anthropic/claude-sonnet-4-6",
            max_tokens: 10,
            stream: true,
            messages: [{ role: "user", content: "hello" }],
          }),
        }),
        {
          port: 10100,
          defaultProvider: "anthropic",
          providers: {
            anthropic: {
              adapter: "anthropic",
              baseUrl: "https://api.anthropic.test",
              defaultModel: "claude-sonnet-4-6",
              apiKey: "test-key",
            },
          },
        },
        ctx,
      );

      expect(response.headers.get("anthropic-ratelimit-unified-remaining")).toBe("58");
      const reader = response.body!.getReader();
      while (!(await reader.read()).done) {
        // drain stream so observeLoggedStream finalizes and usage is recorded
      }

      const summary = __requestLogTest.usageSummarySnapshot();
      expect(summary.summary).toMatchObject({
        requests: 1,
        reportedRequests: 1,
        inputTokens: 5,
        outputTokens: 2,
        totalTokens: 7,
      });
    } finally {
      globalThis.fetch = originalFetch;
    }
  });


  test("native OpenAI routes persist denominator provenance for positive, zero, absent, and error outcomes", async () => {
    __requestLogTest.clear();
    const originalFetch = globalThis.fetch;
    let chatCalls = 0;
    let responsesCalls = 0;
    globalThis.fetch = (async (url) => {
      if (String(url).endsWith("/chat/completions")) {
        chatCalls += 1;
        return Response.json({
          choices: [{ message: { content: "chat answer" }, finish_reason: "stop" }],
          usage: chatCalls === 1
            ? { prompt_tokens: 11, completion_tokens: 2, prompt_tokens_details: { cached_tokens: 5 } }
            : { prompt_tokens: 11, completion_tokens: 2 },
        });
      }
      responsesCalls += 1;
      if (responsesCalls === 2) {
        return Response.json({ error: { message: "upstream failed" } }, { status: 500 });
      }
      return Response.json({
        output: [{ type: "message", content: [{ type: "output_text", text: "responses answer" }] }],
        usage: { input_tokens: 13, output_tokens: 3, input_tokens_details: { cached_tokens: 0 } },
      });
    }) as typeof fetch;

    const config = {
      port: 10100,
      defaultProvider: "chat",
      providers: {
        chat: {
          adapter: "openai-chat",
          baseUrl: "https://api.openai.com/v1",
          apiKey: "sk-test",
          catalogProviderId: "openai-apikey",
          defaultModel: "gpt-chat",
          models: ["gpt-chat"],
        },
        responses: {
          adapter: "openai-responses",
          baseUrl: "https://api.openai.com/v1",
          apiKey: "sk-test",
          catalogProviderId: "openai-apikey",
          defaultModel: "gpt-responses",
          models: ["gpt-responses"],
        },
      },
    } satisfies FrogConfig;

    try {
      const routes = [
        ["chat/gpt-chat", 200],
        ["responses/gpt-responses", 200],
        ["chat/gpt-chat", 200],
        ["responses/gpt-responses", 500],
      ] as const;
      for (const [model, expectedStatus] of routes) {
        const ctx = __requestLogTest.createRequestLog("/v1/messages", "POST", new Headers());
        const response = await __requestLogTest.handleMessages(
          new Request("http://127.0.0.1/v1/messages", {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({
              model,
              max_tokens: 10,
              messages: [{ role: "user", content: "hello" }],
            }),
          }),
          config,
          ctx,
        );
        expect(response.status).toBe(expectedStatus);
        __requestLogTest.finalizeRequestLog(ctx, expectedStatus === 200 ? "completed" : "provider_non_2xx", expectedStatus);
      }

      const requestEntries = __requestLogTest.requestLogSnapshot();
      expect(requestEntries.map(entry => entry.route.cacheUsageSemantics)).toEqual([
        "openai_input_total_includes_cached",
        "openai_input_total_includes_cached",
        "openai_input_total_includes_cached",
        "openai_input_total_includes_cached",
      ]);
      expect(requestEntries[0].upstream?.usage).toMatchObject({ inputTokens: 11, cacheReadInputTokens: 5 });
      expect(requestEntries[1].upstream?.usage).toMatchObject({ inputTokens: 13, cacheReadInputTokens: 0 });
      expect(requestEntries[2].upstream?.usage).toEqual({ inputTokens: 11, outputTokens: 2 });
      expect(requestEntries[3].upstream?.usage).toBeUndefined();

      const persisted = readUsageEntries();
      expect(persisted.map(entry => ({
        semantics: entry.cacheUsageSemantics,
        status: entry.cacheUsageStatus,
      }))).toEqual([
        { semantics: "openai_input_total_includes_cached", status: "reported" },
        { semantics: "openai_input_total_includes_cached", status: "reported" },
        { semantics: "openai_input_total_includes_cached", status: "unavailable" },
        { semantics: "openai_input_total_includes_cached", status: "unavailable" },
      ]);
      expect(__requestLogTest.usageSummarySnapshot().cacheHitRate).toMatchObject({
        status: "available",
        cacheReadInputTokens: 5,
        cacheCreationInputTokens: 0,
        totalInputTokens: 24,
        hitRate: 5 / 24,
        reportedRequests: 2,
        unavailableRequests: 1,
        failedRequests: 1,
      });
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test("effective Anthropic wire override owns cache provenance instead of the configured adapter", async () => {
    __requestLogTest.clear();
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async (url) => {
      expect(String(url)).toBe("https://go.test/v1/messages");
      return Response.json({
        id: "msg_wire_override",
        type: "message",
        role: "assistant",
        content: [{ type: "text", text: "answer" }],
        usage: {
          input_tokens: 10,
          output_tokens: 3,
          cache_read_input_tokens: 4,
          cache_creation_input_tokens: 2,
        },
      });
    }) as typeof fetch;

    try {
      const ctx = __requestLogTest.createRequestLog("/v1/messages", "POST", new Headers());
      const response = await __requestLogTest.handleMessages(
        new Request("http://127.0.0.1/v1/messages", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            model: "opencode-go/qwen3.5-plus",
            max_tokens: 10,
            messages: [{ role: "user", content: "hello" }],
          }),
        }),
        {
          port: 10100,
          defaultProvider: "opencode-go",
          providers: {
            "opencode-go": {
              adapter: "openai-chat",
              baseUrl: "https://go.test",
              apiKey: "test-key",
              defaultModel: "qwen3.5-plus",
              models: ["qwen3.5-plus"],
            },
          },
        },
        ctx,
      );
      expect(response.status).toBe(200);
      __requestLogTest.finalizeRequestLog(ctx, "completed", 200);

      const [requestEntry] = __requestLogTest.requestLogSnapshot();
      expect(requestEntry.route).toMatchObject({
        provider: "opencode-go",
        routedModelLabel: "qwen3.5-plus",
        adapter: "anthropic",
        cacheUsageSemantics: "anthropic_separate_input_buckets",
      });
      expect(readUsageEntries()[0]).toMatchObject({
        provider: "opencode-go",
        model: "qwen3.5-plus",
        cacheUsageStatus: "reported",
        cacheUsageSemantics: "anthropic_separate_input_buckets",
      });
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test("fusion and pipeline final targets alone own Anthropic and native OpenAI cache provenance", async () => {
    __requestLogTest.clear();
    const originalFetch = globalThis.fetch;
    const calls: string[] = [];
    globalThis.fetch = (async (url, init) => {
      calls.push(String(url));
      if (String(url) === "https://anthropic.test/v1/messages") {
        const body = JSON.parse(String(init?.body)) as { stream?: boolean };
        if (body.stream === false) {
          return Response.json({
            id: "msg_buffered",
            type: "message",
            role: "assistant",
            content: [{ type: "text", text: "buffered stage" }],
            usage: {
              input_tokens: 100,
              output_tokens: 3,
              cache_read_input_tokens: 90,
              cache_creation_input_tokens: 5,
            },
          });
        }
        return new Response([
          "event: message_start\n",
          "data: {\"type\":\"message_start\",\"message\":{\"usage\":{\"input_tokens\":10,\"output_tokens\":0,\"cache_read_input_tokens\":4,\"cache_creation_input_tokens\":2}}}\n\n",
          "event: content_block_start\n",
          "data: {\"type\":\"content_block_start\",\"content_block\":{\"type\":\"text\"}}\n\n",
          "event: content_block_delta\n",
          "data: {\"type\":\"content_block_delta\",\"delta\":{\"type\":\"text_delta\",\"text\":\"anthropic final\"}}\n\n",
          "event: message_delta\n",
          "data: {\"type\":\"message_delta\",\"delta\":{\"stop_reason\":\"end_turn\"},\"usage\":{\"output_tokens\":3}}\n\n",
          "event: message_stop\n",
          "data: {\"type\":\"message_stop\"}\n\n",
        ].join(""), { headers: { "content-type": "text/event-stream" } });
      }
      expect(String(url)).toBe("https://api.openai.com/v1/responses");
      return new Response([
        "event: response.output_text.delta\n",
        "data: {\"type\":\"response.output_text.delta\",\"delta\":\"openai final\"}\n\n",
        "event: response.completed\n",
        "data: {\"type\":\"response.completed\",\"response\":{\"status\":\"completed\",\"usage\":{\"input_tokens\":12,\"output_tokens\":4,\"input_tokens_details\":{\"cached_tokens\":3}}}}\n\n",
      ].join(""), { headers: { "content-type": "text/event-stream" } });
    }) as typeof fetch;

    const providers = {
      anthropic: {
        adapter: "anthropic",
        baseUrl: "https://anthropic.test",
        apiKey: "test-key",
        defaultModel: "claude-final",
        models: ["claude-final"],
      },
      openai: {
        adapter: "openai-responses",
        baseUrl: "https://api.openai.com/v1",
        apiKey: "test-key",
        catalogProviderId: "openai-apikey",
        defaultModel: "gpt-final",
        models: ["gpt-final"],
      },
    } satisfies FrogConfig["providers"];

    try {
      for (const scenario of [
        { combine: "fusion" as const, finalTarget: { provider: "anthropic", model: "claude-final" } },
        { combine: "pipeline" as const, finalTarget: { provider: "openai", model: "gpt-final" } },
      ]) {
        const { combine, finalTarget } = scenario;
        const ctx = __requestLogTest.createRequestLog("/v1/messages", "POST", new Headers());
        const response = await __requestLogTest.handleMessages(
          new Request("http://127.0.0.1/v1/messages", {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({
              model: "frogp/mix",
              max_tokens: 10,
              messages: [{ role: "user", content: "hello" }],
            }),
          }),
          {
            port: 10100,
            defaultProvider: finalTarget.provider,
            providers,
            modelMixing: combine === "fusion"
              ? {
                  enabled: true,
                  aliasId: "frogp/mix",
                  combine,
                  agents: [finalTarget],
                  fusion: {
                    panel: [finalTarget],
                    judge: finalTarget,
                    synthesizer: finalTarget,
                  },
                }
              : {
                  enabled: true,
                  aliasId: "frogp/mix",
                  combine,
                  pipeline: [{ role: "final", ...finalTarget }],
                },
          },
          ctx,
        );
        expect(response.status).toBe(200);
        __requestLogTest.finalizeRequestLog(ctx, "completed", 200);
      }

      expect(calls).toEqual([
        "https://anthropic.test/v1/messages",
        "https://anthropic.test/v1/messages",
        "https://anthropic.test/v1/messages",
        "https://api.openai.com/v1/responses",
      ]);
      expect(__requestLogTest.requestLogSnapshot().map(entry => ({
        provider: entry.route.provider,
        model: entry.route.routedModelLabel,
        adapter: entry.route.adapter,
        semantics: entry.route.cacheUsageSemantics,
      }))).toEqual([
        {
          provider: "anthropic",
          model: "claude-final",
          adapter: "anthropic",
          semantics: "anthropic_separate_input_buckets",
        },
        {
          provider: "openai",
          model: "gpt-final",
          adapter: "openai-responses",
          semantics: "openai_input_total_includes_cached",
        },
      ]);
      expect(readUsageEntries().map(entry => ({
        provider: entry.provider,
        status: entry.cacheUsageStatus,
        semantics: entry.cacheUsageSemantics,
      }))).toEqual([
        {
          provider: "anthropic",
          status: "reported",
          semantics: "anthropic_separate_input_buckets",
        },
        {
          provider: "openai",
          status: "reported",
          semantics: "openai_input_total_includes_cached",
        },
      ]);
      expect(__requestLogTest.usageSummarySnapshot().cacheHitRate).toMatchObject({
        cacheReadInputTokens: 7,
        cacheCreationInputTokens: 2,
        inputTokens: 22,
        totalInputTokens: 28,
        hitRate: 0.25,
        reportedRequests: 2,
      });
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test("an early pipeline tool-call response persists the stage's effective cache provenance", async () => {
    __requestLogTest.clear();
    const originalFetch = globalThis.fetch;
    const calls: string[] = [];
    globalThis.fetch = (async (url) => {
      calls.push(String(url));
      return Response.json({
        id: "msg_tool_stage",
        type: "message",
        role: "assistant",
        model: "tool-model",
        content: [{
          type: "tool_use",
          id: "toolu_1",
          name: "read_file",
          input: { path: "README.md" },
        }],
        stop_reason: "tool_use",
        usage: {
          input_tokens: 10,
          output_tokens: 3,
          cache_read_input_tokens: 4,
          cache_creation_input_tokens: 2,
        },
      });
    }) as typeof fetch;

    try {
      const ctx = __requestLogTest.createRequestLog("/v1/messages", "POST", new Headers());
      const response = await __requestLogTest.handleMessages(
        new Request("http://127.0.0.1/v1/messages", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            model: "frogp/mix",
            max_tokens: 10,
            messages: [{ role: "user", content: "hello" }],
          }),
        }),
        {
          port: 10100,
          defaultProvider: "tool-stage",
          providers: {
            "tool-stage": {
              adapter: "anthropic",
              baseUrl: "https://tool-stage.test",
              apiKey: "test-key",
              defaultModel: "tool-model",
              models: ["tool-model"],
            },
            final: {
              adapter: "anthropic",
              baseUrl: "https://final.test",
              apiKey: "test-key",
              defaultModel: "final-model",
              models: ["final-model"],
            },
          },
          modelMixing: {
            enabled: true,
            aliasId: "frogp/mix",
            combine: "pipeline",
            pipeline: [
              { role: "worker", provider: "tool-stage", model: "tool-model" },
              { role: "verifier", provider: "final", model: "final-model" },
            ],
          },
        },
        ctx,
      );
      expect(response.status).toBe(200);
      expect((await response.json()).content).toContainEqual({
        type: "tool_use",
        id: "toolu_1",
        name: "read_file",
        input: { path: "README.md" },
      });
      __requestLogTest.finalizeRequestLog(ctx, "completed", 200);

      expect(calls).toEqual(["https://tool-stage.test/v1/messages"]);
      const [requestEntry] = __requestLogTest.requestLogSnapshot();
      expect(requestEntry.route).toMatchObject({
        provider: "tool-stage",
        routedModelLabel: "tool-model",
        adapter: "anthropic",
        cacheUsageSemantics: "anthropic_separate_input_buckets",
      });
      expect(readUsageEntries()[0]).toMatchObject({
        provider: "tool-stage",
        model: "tool-model",
        cacheUsageStatus: "reported",
        cacheUsageSemantics: "anthropic_separate_input_buckets",
      });
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test("usage API exposes summary under Claude Code compatible aliases", async () => {
    __requestLogTest.clear();
    const ctx = __requestLogTest.createRequestLog("/v1/messages", "POST", new Headers());
    ctx.entry.route.provider = "codex";
    ctx.entry.route.routedModelLabel = "gpt-5.5";
    ctx.entry.upstream = { usage: { inputTokens: 2, outputTokens: 3 } };
    __requestLogTest.finalizeRequestLog(ctx, "completed", 200);

    const config = { port: 10100, defaultProvider: "codex", providers: {} };
    const usageRes = await __requestLogTest.handleManagementAPI(
      new Request("http://127.0.0.1/api/usage"),
      new URL("http://127.0.0.1/api/usage"),
      config,
    );
    const oauthUsageRes = await __requestLogTest.handleManagementAPI(
      new Request("http://127.0.0.1/api/oauth/usage"),
      new URL("http://127.0.0.1/api/oauth/usage"),
      config,
    );

    expect(usageRes?.status).toBe(200);
    expect(oauthUsageRes?.status).toBe(200);
    const usageBody = await usageRes!.json();
    const oauthUsageBody = await oauthUsageRes!.json();
    expect(usageBody).toMatchObject({
      summary: { requests: 1, reportedRequests: 1, totalTokens: 5 },
      providers: [{ provider: "codex", totalTokens: 5 }],
      sourceState: {
        observedUsage: { available: true, source: "local_request_log", authoritative: false },
        sessionLimits: { available: false, source: null, reason: "no_authoritative_source" },
        cost: { available: false, source: null, reason: "no_authoritative_source" },
      },
    });
    expect(oauthUsageBody).toMatchObject({
      summary: { totalTokens: 5 },
      sourceState: {
        sessionLimits: { available: false, reason: "no_authoritative_source" },
        cost: { available: false, reason: "no_authoritative_source" },
      },
    });
  });

  test("usage API classifies a completed non-Anthropic request without usage as unsupported", async () => {
    __requestLogTest.clear();
    const ctx = __requestLogTest.createRequestLog("/v1/messages", "POST", new Headers());
    ctx.entry.route.provider = "codex";
    ctx.entry.route.adapter = "openai-responses";
    ctx.entry.route.routedModelLabel = "gpt-5.5";
    __requestLogTest.finalizeRequestLog(ctx, "completed", 200);

    const config = { port: 10100, defaultProvider: "codex", providers: {} };
    const response = await __requestLogTest.handleManagementAPI(
      new Request("http://127.0.0.1/api/usage"),
      new URL("http://127.0.0.1/api/usage"),
      config,
    );

    expect(response?.status).toBe(200);
    const body = await response!.json();
    expect(body.summary).toMatchObject({
      requests: 1,
      reportedRequests: 0,
      unreportedRequests: 1,
    });
    expect(body.cacheHitRate).toMatchObject({
      status: "unsupported",
      hitRate: null,
      reportedRequests: 0,
      unsupportedRequests: 1,
      unavailableRequests: 0,
    });
  });

  test("count-token upstream fetch observes client aborts", async () => {
    __requestLogTest.clear();
    const originalFetch = globalThis.fetch;
    const client = new AbortController();
    globalThis.fetch = (async (_url, init) => new Promise<Response>((_resolve, reject) => {
      const signal = init?.signal;
      if (signal?.aborted) {
        reject(signal.reason);
        return;
      }
      signal?.addEventListener("abort", () => reject(signal.reason), { once: true });
      setTimeout(() => client.abort(new DOMException("Client closed", "AbortError")), 0);
    })) as typeof fetch;
    try {
      const ctx = __requestLogTest.createRequestLog("/v1/messages/count_tokens", "POST", new Headers());
      const response = await __requestLogTest.handleCountTokens(
        new Request("http://127.0.0.1/v1/messages/count_tokens", {
          method: "POST",
          body: JSON.stringify({
            model: "anthropic/claude-sonnet-4-6",
            messages: [{ role: "user", content: "hello" }],
          }),
        }),
        {
          port: 10100,
          defaultProvider: "anthropic",
          providers: {
            anthropic: {
              adapter: "anthropic",
              baseUrl: "https://api.anthropic.test",
              defaultModel: "claude-sonnet-4-6",
              apiKey: "test-key",
            },
          },
        },
        ctx,
        { abortSignal: client.signal },
      );

      const [entry] = __requestLogTest.requestLogSnapshot();
      expect(response.status).toBe(502);
      expect(entry.lifecycle).toBe("upstream_abort");
      expect(entry.error).toEqual({ kind: "upstream", code: "upstream_unreachable" });
      expect(entry.phases.some(phase => phase.name === "upstream_connect" && phase.status === "error")).toBe(true);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test("logged data-plane wrapper finalizes thrown handlers generically", async () => {
    __requestLogTest.clear();
    const response = await __requestLogTest.runLoggedDataPlane(
      new Request("http://127.0.0.1/v1/messages", { method: "POST", body: "{}" }),
      "/v1/messages",
      async () => {
        throw new Error("secret-token provider raw body /Users/alice/private.txt");
      },
    );

    const [entry] = __requestLogTest.requestLogSnapshot();
    expect(response.status).toBe(500);
    expect(entry.lifecycle).toBe("internal_error");
    expect(entry.error).toEqual({ kind: "internal", code: "handler_exception" });
    expect(asText(entry)).not.toContain("secret-token");
    expect(asText(entry)).not.toContain("/Users/alice");
    expect(entry.phases.filter(phase => phase.name === "finalize")).toHaveLength(1);
  });
  test("provider fallback logs final provider/model/usage and redacted attempt diagnostics", async () => {
    __requestLogTest.clear();
    const originalFetch = globalThis.fetch;
    const calls: string[] = [];
    globalThis.fetch = (async (url) => {
      calls.push(String(url));
      if (String(url).startsWith("https://primary.test")) {
        return new Response(JSON.stringify({ error: { type: "rate_limit_error", message: "quota hit for sk-primary-secret" } }), {
          status: 429,
          headers: { "content-type": "application/json" },
        });
      }
      return new Response(JSON.stringify({
        id: "msg_ok",
        type: "message",
        role: "assistant",
        model: "fallback-model",
        content: [{ type: "text", text: "fallback ok" }],
        usage: { input_tokens: 13, output_tokens: 5, cache_read_input_tokens: 2, cache_creation_input_tokens: 0 },
      }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }) as typeof fetch;

    try {
      const ctx = __requestLogTest.createRequestLog("/v1/messages", "POST", new Headers());
      const response = await __requestLogTest.handleMessages(
        new Request("http://127.0.0.1/v1/messages", {
          method: "POST",
          body: JSON.stringify({
            model: "primary/primary-model",
            max_tokens: 10,
            messages: [{ role: "user", content: "hello" }],
          }),
        }),
        {
          port: 10100,
          defaultProvider: "primary",
          fallbackProviders: ["fallback"],
          providers: {
            primary: {
              adapter: "anthropic",
              baseUrl: "https://primary.test",
              apiKey: "sk-primary-secret",
              defaultModel: "primary-model",
              models: ["primary-model"],
            },
            fallback: {
              adapter: "anthropic",
              baseUrl: "https://fallback.test",
              apiKey: "sk-fallback-secret",
              defaultModel: "fallback-model",
              models: ["fallback-model"],
            },
          },
        },
        ctx,
      );

      expect(response.status).toBe(200);
      __requestLogTest.finalizeRequestLog(ctx, "completed", 200);

      const [entry] = __requestLogTest.requestLogSnapshot();
      expect(calls).toEqual(["https://primary.test/v1/messages", "https://fallback.test/v1/messages"]);
      expect(entry.route.provider).toBe("fallback");
      expect(entry.route.routedModelLabel).toBe("fallback-model");
      expect(entry.upstream?.usage).toEqual({
        inputTokens: 13,
        outputTokens: 5,
        cachedInputTokens: 2,
        cacheReadInputTokens: 2,
        cacheCreationInputTokens: 0,
      });
      expect(entry.attempts).toEqual([
        { provider: "primary", model: "primary-model", source: "primary", keyIndex: 0, status: "error", code: "provider_non_2xx", upstreamStatus: 429 },
        { provider: "fallback", model: "fallback-model", source: "fallback", keyIndex: 0, status: "ok", upstreamStatus: 200 },
      ]);
      expect(entry.lifecycle).toBe("completed");
      expect(entry.status).toBe(200);
      expect(entry.phases.filter(phase => phase.name === "finalize")).toHaveLength(1);
      const serialized = asText(entry);
      expect(serialized).not.toContain("quota hit");
      expect(serialized).not.toContain("sk-primary-secret");
      expect(serialized).not.toContain("sk-fallback-secret");

      const summary = __requestLogTest.usageSummarySnapshot();
      expect(summary.providers[0]).toMatchObject({ provider: "fallback", totalTokens: 18 });
      expect(summary.models[0]).toMatchObject({ provider: "fallback", model: "fallback-model", totalTokens: 18 });
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});

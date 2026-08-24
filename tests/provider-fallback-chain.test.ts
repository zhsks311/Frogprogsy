import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { __requestLogTest } from "../src/server";
import { ContinuityCircuit } from "../src/model-continuity";
import type { FrogConfig } from "../src/types";

let testHome = "";
let previousFrogHome: string | undefined;

beforeEach(() => {
  previousFrogHome = process.env.FROGPROGSY_HOME;
  testHome = mkdtempSync(join(tmpdir(), "frog-provider-fallback-chain-"));
  process.env.FROGPROGSY_HOME = testHome;
  __requestLogTest.clear();
});

afterEach(() => {
  if (previousFrogHome === undefined) delete process.env.FROGPROGSY_HOME;
  else process.env.FROGPROGSY_HOME = previousFrogHome;
  if (testHome) rmSync(testHome, { recursive: true, force: true });
  testHome = "";
  __requestLogTest.clear();
});

function baseConfig(): FrogConfig {
  return {
    port: 10100,
    defaultProvider: "primary",
    providers: {
      primary: {
        adapter: "anthropic",
        baseUrl: "https://primary.test",
        apiKey: "sk-primary-secret",
        defaultModel: "primary-default",
        models: ["primary-model", "primary-default"],
      },
      fallback: {
        adapter: "anthropic",
        baseUrl: "https://fallback.test",
        apiKey: "sk-fallback-secret",
        defaultModel: "fallback-default",
        models: ["fallback-default", "fallback-other"],
      },
      later: {
        adapter: "anthropic",
        baseUrl: "https://later.test",
        apiKey: "sk-later-secret",
        defaultModel: "later-default",
        models: ["later-default"],
      },
    },
  };
}

function messagesBody(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    model: "primary/primary-model",
    max_tokens: 10,
    messages: [{ role: "user", content: "hello" }],
    ...overrides,
  };
}

async function invokeMessages(
  config: FrogConfig,
  body: Record<string, unknown> = messagesBody(),
  options: {
    continuityCircuit?: ContinuityCircuit;
    now?: () => number;
    retiredTargets?: ReadonlySet<string>;
    abortSignal?: AbortSignal;
  } = {},
  headers = new Headers(),
): Promise<Response> {
  const ctx = __requestLogTest.createRequestLog("/v1/messages", "POST", headers);
  return __requestLogTest.handleMessages(
    new Request("http://127.0.0.1/v1/messages", {
      method: "POST",
      headers,
      body: JSON.stringify(body),
    }),
    config,
    ctx,
    options,
  );
}

function anthropicOk(text: string, inputTokens = 7, outputTokens = 3): Response {
  return new Response(JSON.stringify({
    id: "msg_ok",
    type: "message",
    role: "assistant",
    model: "upstream-model",
    content: [{ type: "text", text }],
    usage: { input_tokens: inputTokens, output_tokens: outputTokens },
  }), { status: 200, headers: { "content-type": "application/json" } });
}

describe("provider fallback chain", () => {
  test("provider fallback is a no-op when config is unset", async () => {
    const cfg = baseConfig();
    const calls: Array<{ url: string; body: Record<string, unknown> }> = [];
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async (url, init) => {
      calls.push({ url: String(url), body: JSON.parse(String(init?.body)) as Record<string, unknown> });
      return new Response(JSON.stringify({ error: { type: "server_error", message: "primary down" } }), {
        status: 503,
        headers: { "content-type": "application/json" },
      });
    }) as typeof fetch;

    try {
      const response = await invokeMessages(cfg);
      expect(response.status).toBe(503);
      expect(calls).toHaveLength(1);
      expect(calls[0].url).toBe("https://primary.test/v1/messages");
      expect(calls[0].body.model).toBe("primary-model");
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test("direct upstream errors preserve Retry-After and filter unsafe headers", async () => {
    const cfg = baseConfig();
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async () => new Response(JSON.stringify({
      error: { type: "rate_limit_error", message: "rate limit reached" },
    }), {
      status: 429,
      headers: {
        "content-type": "application/json",
        "retry-after": "7",
        "set-cookie": "provider-secret=leak",
      },
    })) as typeof fetch;

    try {
      const response = await invokeMessages(cfg);
      expect(response.status).toBe(429);
      expect(response.headers.get("retry-after")).toBe("7");
      expect(response.headers.get("set-cookie")).toBeNull();
      await expect(response.json()).resolves.toMatchObject({
        type: "error",
        error: { type: "rate_limit_error" },
      });
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test("HTTP 200 inline adapter errors preserve safe headers and never become empty success", async () => {
    const cfg = baseConfig();
    cfg.providers.primary = {
      adapter: "openai-chat",
      baseUrl: "https://primary.test/v1",
      apiKey: "sk-primary-secret",
      defaultModel: "primary-model",
      models: ["primary-model"],
    };
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async () => Response.json({
      error: { message: "provider rejected request" },
    }, {
      headers: {
        "retry-after": "11",
        "set-cookie": "provider-secret=leak",
      },
    })) as typeof fetch;

    try {
      const response = await invokeMessages(cfg);
      expect(response.status).toBe(502);
      expect(response.headers.get("retry-after")).toBe("11");
      expect(response.headers.get("set-cookie")).toBeNull();
      await expect(response.json()).resolves.toEqual({
        type: "error",
        error: { type: "api_error", message: "provider rejected request" },
      });
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test("uses only the first valid fallback provider and its defaultModel", async () => {
    const cfg = baseConfig();
    cfg.fallbackProviders = ["missing", "fallback", "later"];
    const calls: Array<{ url: string; body: Record<string, unknown> }> = [];
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async (url, init) => {
      const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
      calls.push({ url: String(url), body });
      if (String(url).startsWith("https://primary.test")) {
        return new Response(JSON.stringify({ error: { type: "server_error", message: "primary down" } }), {
          status: 503,
          headers: { "content-type": "application/json" },
        });
      }
      if (String(url).startsWith("https://fallback.test")) return anthropicOk("fallback ok");
      throw new Error(`unexpected fallback candidate reached: ${url}`);
    }) as typeof fetch;

    try {
      const response = await invokeMessages(cfg);
      const json = await response.json() as Record<string, unknown>;
      expect(response.status).toBe(200);
      expect(json).toMatchObject({ content: [{ type: "text", text: "fallback ok" }] });
      expect(calls.map(call => call.url)).toEqual([
        "https://primary.test/v1/messages",
        "https://fallback.test/v1/messages",
      ]);
      expect(calls[0].body.model).toBe("primary-model");
      expect(calls[1].body.model).toBe("fallback-default");
      const [entry] = __requestLogTest.requestLogSnapshot();
      expect(entry.route.provider).toBe("fallback");
      expect(entry.route.routedModelLabel).toBe("fallback-default");
      expect(entry.upstream?.usage).toEqual({ inputTokens: 7, outputTokens: 3 });
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test("does not continue past the first valid fallback provider after fallback failure", async () => {
    const cfg = baseConfig();
    cfg.fallbackProviders = ["missing", "fallback", "later"];
    const calls: string[] = [];
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async (url) => {
      calls.push(String(url));
      if (String(url).startsWith("https://primary.test")) {
        return new Response(JSON.stringify({ error: { type: "server_error", message: "primary down" } }), {
          status: 503,
          headers: { "content-type": "application/json" },
        });
      }
      if (String(url).startsWith("https://fallback.test")) {
        return new Response(JSON.stringify({ error: { type: "server_error", message: "fallback down" } }), {
          status: 503,
          headers: { "content-type": "application/json" },
        });
      }
      throw new Error(`unexpected later fallback reached: ${url}`);
    }) as typeof fetch;

    try {
      const response = await invokeMessages(cfg);
      expect(response.status).toBe(503);
      expect(calls).toEqual([
        "https://primary.test/v1/messages",
        "https://fallback.test/v1/messages",
      ]);
      const json = await response.json() as { error?: { message?: string } };
      expect(json.error?.message).toBe("fallback down");
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test.each([
    [400, { error: { type: "invalid_request_error", message: "bad request" } }],
    [400, { error: { type: "invalid_request_error", message: "context_length exceeded" } }],
    [503, { error: { type: "server_error", message: "context_length_exceeded" } }],
    [401, { error: { type: "authentication_error", message: "bad key" } }],
    [402, { error: { type: "billing_error", message: "payment required" } }],
    [403, { error: { type: "permission_error", message: "forbidden" } }],
  ])("status %i is terminal and does not use provider fallback", async (status, payload) => {
    const cfg = baseConfig();
    cfg.fallbackProviders = ["fallback"];
    const calls: string[] = [];
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async (url) => {
      calls.push(String(url));
      return new Response(JSON.stringify(payload), { status, headers: { "content-type": "application/json" } });
    }) as typeof fetch;

    try {
      const response = await invokeMessages(cfg);
      expect(response.status).toBe(status);
      expect(calls).toEqual(["https://primary.test/v1/messages"]);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test("oauth token resolution failure is terminal and does not use provider fallback", async () => {
    const cfg = baseConfig();
    cfg.fallbackProviders = ["fallback"];
    cfg.providers.primary = { ...cfg.providers.primary, authMode: "oauth", apiKey: undefined };
    const calls: string[] = [];
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async (url) => {
      calls.push(String(url));
      return anthropicOk("should not be called");
    }) as typeof fetch;

    try {
      const response = await invokeMessages(cfg);
      expect(response.status).toBe(401);
      expect(calls).toEqual([]);
      const [entry] = __requestLogTest.requestLogSnapshot();
      expect(entry.attempts).toEqual([
        { provider: "primary", model: "primary-model", source: "primary", status: "error", code: "oauth_missing" },
      ]);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test("successful upstream OK and bridge parse errors never trigger fallback", async () => {
    const cfg = baseConfig();
    cfg.fallbackProviders = ["fallback"];
    const calls: string[] = [];
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async (url) => {
      calls.push(String(url));
      return new Response("not json", { status: 200, headers: { "content-type": "application/json" } });
    }) as typeof fetch;

    try {
      const response = await invokeMessages(cfg);
      expect(response.status).toBe(502);
      expect(calls).toEqual(["https://primary.test/v1/messages"]);
      const [entry] = __requestLogTest.requestLogSnapshot();
      expect(entry.lifecycle).toBe("bridge_error");
      expect(JSON.stringify(entry)).not.toContain("sk-primary-secret");
      expect(JSON.stringify(entry)).not.toContain("sk-fallback-secret");
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test("stream body start commits the attempt and suppresses fallback", async () => {
    const cfg = baseConfig();
    cfg.fallbackProviders = ["fallback"];
    const calls: string[] = [];
    const encoder = new TextEncoder();
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async (url) => {
      calls.push(String(url));
      return new Response(new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(encoder.encode("event: content_block_delta\n"));
          controller.enqueue(encoder.encode("data: {\"type\":\"content_block_delta\",\"index\":0,\"delta\":{\"type\":\"text_delta\",\"text\":\"hi\"}}\n\n"));
          controller.close();
        },
      }), { status: 200, headers: { "content-type": "text/event-stream" } });
    }) as typeof fetch;

    try {
      const response = await invokeMessages(cfg, messagesBody({ stream: true }));
      expect(response.status).toBe(200);
      const reader = response.body!.getReader();
      while (!(await reader.read()).done) {
        // drain stream to exercise post-start bridge behavior
      }
      expect(calls).toEqual(["https://primary.test/v1/messages"]);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test("stream errors after body start do not trigger provider fallback", async () => {
    const cfg = baseConfig();
    cfg.fallbackProviders = ["fallback"];
    const calls: string[] = [];
    const encoder = new TextEncoder();
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async (url) => {
      calls.push(String(url));
      return new Response(new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(encoder.encode("event: content_block_delta\n"));
          controller.enqueue(encoder.encode("data: {\"type\":\"content_block_delta\",\"index\":0,\"delta\":{\"type\":\"text_delta\",\"text\":\"hi\"}}\n\n"));
          controller.error(new Error("stream exploded after first chunk"));
        },
      }), { status: 200, headers: { "content-type": "text/event-stream" } });
    }) as typeof fetch;

    try {
      const response = await invokeMessages(cfg, messagesBody({ stream: true }));
      expect(response.status).toBe(200);
      const reader = response.body!.getReader();
      try {
        while (!(await reader.read()).done) {
          // drain until the post-start upstream stream error is surfaced
        }
      } catch {
        // The important contract is that fallback is not attempted after the stream has started.
      }
      expect(calls).toEqual(["https://primary.test/v1/messages"]);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test("count_tokens applies long-context routing before building the upstream count request", async () => {
    const cfg = baseConfig();
    cfg.fallbackProviders = ["fallback"];
    cfg.longContext = { thresholdTokens: 10, provider: "fallback", model: "fallback-default" };
    const calls: Array<{ url: string; body: Record<string, unknown> }> = [];
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async (url, init) => {
      calls.push({ url: String(url), body: JSON.parse(String(init?.body)) as Record<string, unknown> });
      return new Response(JSON.stringify({ input_tokens: 123 }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }) as typeof fetch;

    try {
      const ctx = __requestLogTest.createRequestLog("/v1/messages/count_tokens", "POST", new Headers());
      const response = await __requestLogTest.handleCountTokens(
        new Request("http://127.0.0.1/v1/messages/count_tokens", {
          method: "POST",
          body: JSON.stringify(messagesBody({ model: "primary-model", messages: [{ role: "user", content: "x".repeat(200) }] })),
        }),
        cfg,
        ctx,
      );
      const json = await response.json() as Record<string, unknown>;
      expect(response.status).toBe(200);
      expect(json.input_tokens).toBe(123);
      expect(calls).toHaveLength(1);
      expect(calls[0].url).toBe("https://fallback.test/v1/messages/count_tokens");
      expect(calls[0].body.model).toBe("fallback-default");
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test("count_tokens does not run provider fallback after count-token upstream failure", async () => {
    const cfg = baseConfig();
    cfg.fallbackProviders = ["fallback"];
    const calls: string[] = [];
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async (url) => {
      calls.push(String(url));
      return new Response(JSON.stringify({ error: { type: "rate_limit_error", message: "limited" } }), {
        status: 429,
        headers: { "content-type": "application/json" },
      });
    }) as typeof fetch;

    try {
      const ctx = __requestLogTest.createRequestLog("/v1/messages/count_tokens", "POST", new Headers());
      const response = await __requestLogTest.handleCountTokens(
        new Request("http://127.0.0.1/v1/messages/count_tokens", { method: "POST", body: JSON.stringify(messagesBody()) }),
        cfg,
        ctx,
      );
      expect(response.status).toBe(429);
      expect(calls).toEqual(["https://primary.test/v1/messages/count_tokens"]);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test("503 uses the exact continuity fallback instead of fallbackProviders default", async () => {
    const cfg = baseConfig();
    cfg.fallbackProviders = ["later"];
    cfg.modelContinuity = {
      "primary/primary-model": {
        fallbacks: ["fallback/fallback-other"],
        automatic: "transient",
      },
    };
    const calls: Array<{ url: string; body: Record<string, unknown> }> = [];
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async (url, init) => {
      const call = {
        url: String(url),
        body: JSON.parse(String(init?.body)) as Record<string, unknown>,
      };
      calls.push(call);
      return call.url.startsWith("https://primary.test")
        ? new Response(JSON.stringify({ error: { type: "server_error", message: "primary down" } }), {
            status: 503,
            headers: { "content-type": "application/json" },
          })
        : anthropicOk("exact fallback");
    }) as typeof fetch;

    try {
      const response = await invokeMessages(cfg, messagesBody(), {
        continuityCircuit: new ContinuityCircuit(),
      });
      expect(response.status).toBe(200);
      expect((await response.json() as { model?: string }).model).toBe("primary/primary-model");
      expect(calls.map(call => [call.url, call.body.model])).toEqual([
        ["https://primary.test/v1/messages", "primary-model"],
        ["https://fallback.test/v1/messages", "fallback-other"],
      ]);
      const [entry] = __requestLogTest.requestLogSnapshot();
      expect(entry.continuityReason).toBe("http_5xx");
      expect(entry.route.requestedModelLabel).toBe("primary/primary-model");
      const [managementEntry] = __requestLogTest.requestLogManagementSnapshot();
      expect(managementEntry.continuityReason).toBe("http_5xx");
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test("continuity skips a key-auth fallback with no effective key", async () => {
    const cfg = baseConfig();
    cfg.providers.missingKey = {
      adapter: "anthropic",
      baseUrl: "https://missing-key.test",
      defaultModel: "missing-key-model",
      models: ["missing-key-model"],
    };
    cfg.modelContinuity = {
      "primary/primary-model": {
        fallbacks: ["missingKey/missing-key-model", "fallback/fallback-other"],
        automatic: "transient",
      },
    };
    const calls: string[] = [];
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async url => {
      const target = String(url);
      calls.push(target);
      return target.startsWith("https://primary.test")
        ? new Response(JSON.stringify({ error: { type: "server_error", message: "primary down" } }), {
            status: 503,
            headers: { "content-type": "application/json" },
          })
        : anthropicOk("exact fallback");
    }) as typeof fetch;

    try {
      const response = await invokeMessages(cfg, messagesBody(), {
        continuityCircuit: new ContinuityCircuit(),
      });
      expect(response.status).toBe(200);
      expect(calls).toEqual([
        "https://primary.test/v1/messages",
        "https://fallback.test/v1/messages",
      ]);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test("exhausted continuity preserves the last upstream safe headers after an auth skip", async () => {
    const cfg = baseConfig();
    cfg.providers.missingKey = {
      adapter: "anthropic",
      baseUrl: "https://missing-key.test",
      defaultModel: "missing-key-model",
      models: ["missing-key-model"],
    };
    cfg.modelContinuity = {
      "primary/primary-model": {
        fallbacks: ["missingKey/missing-key-model"],
        automatic: "transient",
      },
    };
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async () => new Response(JSON.stringify({
      error: { type: "server_error", message: "primary down" },
    }), {
      status: 503,
      headers: {
        "content-type": "application/json",
        "retry-after": "13",
        "set-cookie": "provider-secret=leak",
      },
    })) as typeof fetch;

    try {
      const response = await invokeMessages(cfg, messagesBody(), {
        continuityCircuit: new ContinuityCircuit(),
      });
      expect(response.status).toBe(503);
      expect(response.headers.get("retry-after")).toBe("13");
      expect(response.headers.get("set-cookie")).toBeNull();
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test.each([400, 401, 402, 403])("continuity leaves HTTP %i terminal", async status => {
    const cfg = baseConfig();
    cfg.modelContinuity = {
      "primary/primary-model": {
        fallbacks: ["fallback/fallback-other"],
        automatic: "transient",
      },
    };
    const calls: string[] = [];
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async url => {
      calls.push(String(url));
      return new Response(JSON.stringify({ error: { type: "upstream_error", message: "terminal" } }), {
        status,
        headers: { "content-type": "application/json" },
      });
    }) as typeof fetch;

    try {
      const response = await invokeMessages(cfg, messagesBody(), {
        continuityCircuit: new ContinuityCircuit(),
      });
      expect(response.status).toBe(status);
      expect(calls).toEqual(["https://primary.test/v1/messages"]);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test.each([
    [404, "http_404"],
    [410, "http_410"],
    [429, "http_429"],
    [500, "http_5xx"],
    [599, "http_5xx"],
  ] as const)("continuity retries exact target after HTTP %i", async (status, reason) => {
    const cfg = baseConfig();
    cfg.modelContinuity = {
      "primary/primary-model": {
        fallbacks: ["fallback/fallback-other"],
        automatic: "transient",
      },
    };
    const calls: string[] = [];
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async url => {
      calls.push(String(url));
      return String(url).startsWith("https://primary.test")
        ? new Response(JSON.stringify({ error: { type: "upstream_error", message: "retryable" } }), {
            status,
            headers: { "content-type": "application/json" },
          })
        : anthropicOk("fallback");
    }) as typeof fetch;

    try {
      const response = await invokeMessages(cfg, messagesBody(), {
        continuityCircuit: new ContinuityCircuit(),
      });
      expect(response.status).toBe(200);
      expect(calls).toEqual([
        "https://primary.test/v1/messages",
        "https://fallback.test/v1/messages",
      ]);
      const [entry] = __requestLogTest.requestLogSnapshot();
      expect(entry.continuityReason).toBe(reason);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test("retired mode selects the exact fallback without fetching primary", async () => {
    const cfg = baseConfig();
    cfg.fallbackProviders = ["later"];
    cfg.modelContinuity = {
      "primary/primary-model": {
        fallbacks: ["fallback/fallback-other"],
        automatic: "retired",
      },
    };
    const calls: Array<{ url: string; model: unknown }> = [];
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async (url, init) => {
      calls.push({
        url: String(url),
        model: (JSON.parse(String(init?.body)) as Record<string, unknown>).model,
      });
      return anthropicOk("retired fallback");
    }) as typeof fetch;

    try {
      const response = await invokeMessages(cfg, messagesBody(), {
        continuityCircuit: new ContinuityCircuit(),
        retiredTargets: new Set(["primary/primary-model"]),
      });
      expect(response.status).toBe(200);
      expect(calls).toEqual([
        { url: "https://fallback.test/v1/messages", model: "fallback-other" },
      ]);
      const [entry] = __requestLogTest.requestLogSnapshot();
      expect(entry.continuityReason).toBe("retired");
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test("retired mode with no usable exact fallback keeps the actionable 410 response", async () => {
    const cfg = baseConfig();
    cfg.modelContinuity = {
      "primary/primary-model": {
        fallbacks: ["removed/no-longer-available"],
        automatic: "retired",
      },
    };
    const calls: string[] = [];
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async url => {
      calls.push(String(url));
      return anthropicOk("must not be called");
    }) as typeof fetch;

    try {
      const response = await invokeMessages(cfg, messagesBody(), {
        continuityCircuit: new ContinuityCircuit(),
        retiredTargets: new Set(["primary/primary-model"]),
      });
      expect(response.status).toBe(410);
      expect(await response.text()).toContain("frogp models continuity");
      expect(calls).toEqual([]);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test("retired mode returns 410 when the exact fallback has no usable authentication", async () => {
    const cfg = baseConfig();
    delete cfg.providers.fallback!.apiKey;
    cfg.modelContinuity = {
      "primary/primary-model": {
        fallbacks: ["fallback/fallback-other"],
        automatic: "retired",
      },
    };
    const calls: string[] = [];
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async url => {
      calls.push(String(url));
      return anthropicOk("must not be called");
    }) as typeof fetch;

    try {
      const response = await invokeMessages(cfg, messagesBody(), {
        continuityCircuit: new ContinuityCircuit(),
        retiredTargets: new Set(["primary/primary-model"]),
      });
      expect(response.status).toBe(410);
      expect(await response.text()).toContain("frogp models continuity");
      expect(calls).toEqual([]);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test("open circuit skips primary and retries it after clock expiry", async () => {
    const cfg = baseConfig();
    cfg.modelContinuity = {
      "primary/primary-model": {
        fallbacks: ["fallback/fallback-other"],
        automatic: "transient",
      },
    };
    const circuit = new ContinuityCircuit();
    let now = 1_000;
    const calls: string[] = [];
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async url => {
      calls.push(String(url));
      if (String(url).startsWith("https://primary.test") && now === 1_000) {
        return new Response(JSON.stringify({ error: { type: "server_error", message: "primary down" } }), {
          status: 503,
          headers: { "content-type": "application/json" },
        });
      }
      return anthropicOk("ok");
    }) as typeof fetch;

    try {
      expect((await invokeMessages(cfg, messagesBody(), { continuityCircuit: circuit, now: () => now })).status).toBe(200);
      now = 2_000;
      expect((await invokeMessages(cfg, messagesBody(), { continuityCircuit: circuit, now: () => now })).status).toBe(200);
      now = 31_001;
      expect((await invokeMessages(cfg, messagesBody(), { continuityCircuit: circuit, now: () => now })).status).toBe(200);
      expect(calls).toEqual([
        "https://primary.test/v1/messages",
        "https://fallback.test/v1/messages",
        "https://fallback.test/v1/messages",
        "https://primary.test/v1/messages",
      ]);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test.each([
    ["connect failure", false, "connect_failure"],
    ["header timeout", true, "connect_timeout"],
  ] as const)("continuity retries after %s", async (_label, timeout, reason) => {
    const cfg = baseConfig();
    cfg.connectTimeoutMs = 1;
    cfg.modelContinuity = {
      "primary/primary-model": {
        fallbacks: ["fallback/fallback-other"],
        automatic: "transient",
      },
    };
    const calls: string[] = [];
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async (url, init) => {
      calls.push(String(url));
      if (!String(url).startsWith("https://primary.test")) return anthropicOk("fallback");
      if (!timeout) throw new Error("connection refused");
      return await new Promise<Response>((_resolve, reject) => {
        const signal = init?.signal;
        signal?.addEventListener("abort", () => reject(signal.reason), { once: true });
      });
    }) as typeof fetch;

    try {
      const response = await invokeMessages(cfg, messagesBody(), {
        continuityCircuit: new ContinuityCircuit(),
      });
      expect(response.status).toBe(200);
      expect(calls).toEqual([
        "https://primary.test/v1/messages",
        "https://fallback.test/v1/messages",
      ]);
      const [entry] = __requestLogTest.requestLogSnapshot();
      expect(entry.continuityReason).toBe(reason);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test("HTTP 200 stream adapter error never fetches another target", async () => {
    const cfg = baseConfig();
    cfg.modelContinuity = {
      "primary/primary-model": {
        fallbacks: ["fallback/fallback-other"],
        automatic: "transient",
      },
    };
    const calls: string[] = [];
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async url => {
      calls.push(String(url));
      return new Response([
        "event: error",
        "data: {\"type\":\"error\",\"error\":{\"type\":\"api_error\",\"message\":\"stream failed\"}}",
        "",
      ].join("\n"), {
        status: 200,
        headers: { "content-type": "text/event-stream" },
      });
    }) as typeof fetch;

    try {
      const response = await invokeMessages(cfg, messagesBody({ stream: true }), {
        continuityCircuit: new ContinuityCircuit(),
      });
      expect(response.status).toBe(200);
      await response.text();
      expect(calls).toEqual(["https://primary.test/v1/messages"]);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test("request-dependent auth skips an unusable exact candidate", async () => {
    const cfg = baseConfig();
    cfg.providers.forwarded = {
      adapter: "anthropic",
      authMode: "forward",
      baseUrl: "https://forwarded.test",
      defaultModel: "forwarded-default",
      models: ["forwarded-model"],
    };
    cfg.modelContinuity = {
      "primary/primary-model": {
        fallbacks: ["forwarded/forwarded-model", "fallback/fallback-other"],
        automatic: "transient",
      },
    };
    const calls: Array<{ url: string; headers: Headers }> = [];
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async (url, init) => {
      calls.push({ url: String(url), headers: new Headers(init?.headers) });
      if (String(url).startsWith("https://primary.test")) {
        return new Response(JSON.stringify({ error: { type: "server_error", message: "primary down" } }), {
          status: 503,
          headers: { "content-type": "application/json" },
        });
      }
      return anthropicOk("fallback");
    }) as typeof fetch;

    try {
      const circuit = new ContinuityCircuit();
      expect((await invokeMessages(cfg, messagesBody(), { continuityCircuit: circuit })).status).toBe(200);
      expect(calls.map(call => call.url)).toEqual([
        "https://primary.test/v1/messages",
        "https://fallback.test/v1/messages",
      ]);
      let [entry] = __requestLogTest.requestLogSnapshot();
      expect(entry.attempts).toContainEqual({
        provider: "forwarded",
        model: "forwarded-model",
        source: "continuity",
        status: "skipped",
        code: "auth_missing",
      });

      calls.length = 0;
      __requestLogTest.clear();
      circuit.succeed("primary/primary-model");
      const headers = new Headers({ "x-api-key": "forwarded-request-key" });
      expect((await invokeMessages(cfg, messagesBody(), { continuityCircuit: circuit }, headers)).status).toBe(200);
      expect(calls.map(call => call.url)).toEqual([
        "https://primary.test/v1/messages",
        "https://forwarded.test/v1/messages",
      ]);
      expect(calls[1].headers.get("x-api-key")).toBe("forwarded-request-key");
      [entry] = __requestLogTest.requestLogSnapshot();
      expect(entry.attempts?.some(attempt => attempt.provider === "fallback")).toBeFalse();
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test("stale exact candidates are skipped independently for active and retired primaries", async () => {
    const cfg = baseConfig();
    cfg.modelContinuity = {
      "primary/primary-model": {
        fallbacks: ["claude-frogprogsy-stale", "fallback/fallback-other"],
        automatic: "all",
      },
    };
    const calls: string[] = [];
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async url => {
      calls.push(String(url));
      return anthropicOk("ok");
    }) as typeof fetch;

    try {
      const circuit = new ContinuityCircuit();
      expect((await invokeMessages(cfg, messagesBody(), { continuityCircuit: circuit })).status).toBe(200);
      expect(calls).toEqual(["https://primary.test/v1/messages"]);

      calls.length = 0;
      expect((await invokeMessages(cfg, messagesBody(), {
        continuityCircuit: circuit,
        retiredTargets: new Set(["primary/primary-model"]),
      })).status).toBe(200);
      expect(calls).toEqual(["https://fallback.test/v1/messages"]);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test.each([
    ["code", { error: { code: "context_length_exceeded" } }],
    ["type", { error: { type: "context_length_exceeded" } }],
  ] as const)("structured context %s without a message never uses continuity", async (_field, payload) => {
    const cfg = baseConfig();
    cfg.modelContinuity = {
      "primary/primary-model": {
        fallbacks: ["fallback/fallback-other"],
        automatic: "transient",
      },
    };
    const calls: string[] = [];
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async url => {
      calls.push(String(url));
      return String(url).startsWith("https://primary.test")
        ? new Response(JSON.stringify(payload), {
            status: 500,
            headers: { "content-type": "application/json" },
          })
        : anthropicOk("must not fallback");
    }) as typeof fetch;

    try {
      const response = await invokeMessages(cfg, messagesBody(), {
        continuityCircuit: new ContinuityCircuit(),
      });
      expect(response.status).toBe(500);
      expect(calls).toEqual(["https://primary.test/v1/messages"]);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test("free-form context wording alone remains an eligible 5xx", async () => {
    const cfg = baseConfig();
    cfg.modelContinuity = {
      "primary/primary-model": {
        fallbacks: ["fallback/fallback-other"],
        automatic: "transient",
      },
    };
    const calls: string[] = [];
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async url => {
      calls.push(String(url));
      return String(url).startsWith("https://primary.test")
        ? new Response(JSON.stringify({
            error: { type: "upstream_error", message: "context window exceeded" },
          }), {
            status: 500,
            headers: { "content-type": "application/json" },
          })
        : anthropicOk("fallback");
    }) as typeof fetch;

    try {
      const response = await invokeMessages(cfg, messagesBody(), {
        continuityCircuit: new ContinuityCircuit(),
      });
      expect(response.status).toBe(200);
      expect(calls).toEqual([
        "https://primary.test/v1/messages",
        "https://fallback.test/v1/messages",
      ]);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test("eligible failure opens the circuit without candidates while unusable candidates keep primary safe", async () => {
    const noCandidate = baseConfig();
    noCandidate.modelContinuity = {
      "primary/primary-model": {
        fallbacks: [],
        automatic: "transient",
      },
    };
    const boundaryCircuit = new ContinuityCircuit();
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async () => new Response(JSON.stringify({
      error: { type: "server_error", message: "primary down" },
    }), {
      status: 503,
      headers: { "content-type": "application/json" },
    })) as typeof fetch;

    try {
      expect((await invokeMessages(noCandidate, messagesBody(), {
        continuityCircuit: boundaryCircuit,
        now: () => 1_000,
      })).status).toBe(503);
      expect(boundaryCircuit.isOpen("primary/primary-model", 30_999)).toBeTrue();
      expect(boundaryCircuit.isOpen("primary/primary-model", 31_000)).toBeFalse();

      const disabledCandidate = baseConfig();
      disabledCandidate.disabledModels = ["fallback/fallback-other"];
      disabledCandidate.modelContinuity = {
        "primary/primary-model": {
          fallbacks: ["fallback/fallback-other"],
          automatic: "transient",
        },
      };
      const circuit = new ContinuityCircuit();
      let now = 1_000;
      const calls: string[] = [];
      globalThis.fetch = (async url => {
        calls.push(String(url));
        return String(url).startsWith("https://primary.test")
          ? new Response(JSON.stringify({ error: { type: "server_error", message: "primary down" } }), {
              status: 503,
              headers: { "content-type": "application/json" },
            })
          : anthropicOk("fallback");
      }) as typeof fetch;

      expect((await invokeMessages(disabledCandidate, messagesBody(), {
        continuityCircuit: circuit,
        now: () => now,
      })).status).toBe(503);
      expect(circuit.isOpen("primary/primary-model", 1_001)).toBeTrue();

      now = 2_000;
      expect((await invokeMessages(disabledCandidate, messagesBody(), {
        continuityCircuit: circuit,
        now: () => now,
      })).status).toBe(503);
      expect(calls).toEqual([
        "https://primary.test/v1/messages",
        "https://primary.test/v1/messages",
      ]);

      disabledCandidate.disabledModels = [];
      calls.length = 0;
      now = 3_000;
      expect((await invokeMessages(disabledCandidate, messagesBody(), {
        continuityCircuit: circuit,
        now: () => now,
      })).status).toBe(200);
      expect(calls).toEqual(["https://fallback.test/v1/messages"]);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test("all auth-skipped continuity candidates preserve the primary upstream failure", async () => {
    const cfg = baseConfig();
    cfg.providers.forwarded = {
      adapter: "anthropic",
      authMode: "forward",
      baseUrl: "https://forwarded.test",
      models: ["forwarded-model"],
    };
    cfg.modelContinuity = {
      "primary/primary-model": {
        fallbacks: ["forwarded/forwarded-model"],
        automatic: "transient",
      },
    };
    const calls: string[] = [];
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async url => {
      calls.push(String(url));
      return new Response(JSON.stringify({
        error: { type: "server_error", message: "primary down" },
      }), {
        status: 503,
        headers: { "content-type": "application/json" },
      });
    }) as typeof fetch;

    try {
      const response = await invokeMessages(cfg, messagesBody(), {
        continuityCircuit: new ContinuityCircuit(),
      });
      expect(response.status).toBe(503);
      expect((await response.json() as { error?: { message?: string } }).error?.message).toBe("primary down");
      expect(calls).toEqual(["https://primary.test/v1/messages"]);
      const [entry] = __requestLogTest.requestLogSnapshot();
      expect(entry.attempts).toContainEqual({
        provider: "forwarded",
        model: "forwarded-model",
        source: "continuity",
        status: "skipped",
        code: "auth_missing",
      });
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test("open circuit keeps primary when the only OAuth candidate cannot authenticate", async () => {
    const cfg = baseConfig();
    cfg.providers.oauthFallback = {
      adapter: "anthropic",
      authMode: "oauth",
      baseUrl: "https://oauth-fallback.test",
      models: ["oauth-model"],
    };
    cfg.modelContinuity = {
      "primary/primary-model": {
        fallbacks: ["oauthFallback/oauth-model"],
        automatic: "transient",
      },
    };
    const circuit = new ContinuityCircuit();
    circuit.open("primary/primary-model", "http_5xx", 1_000);
    const calls: string[] = [];
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async url => {
      calls.push(String(url));
      return anthropicOk("primary safe");
    }) as typeof fetch;

    try {
      const response = await invokeMessages(cfg, messagesBody(), {
        continuityCircuit: circuit,
        now: () => 2_000,
      });
      expect(response.status).toBe(200);
      expect(calls).toEqual(["https://primary.test/v1/messages"]);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test("client cancellation neither falls back nor opens the continuity circuit", async () => {
    const cfg = baseConfig();
    cfg.modelContinuity = {
      "primary/primary-model": {
        fallbacks: ["fallback/fallback-other"],
        automatic: "transient",
      },
    };
    const circuit = new ContinuityCircuit();
    const client = new AbortController();
    const calls: string[] = [];
    const originalFetch = globalThis.fetch;
    let firstRequest = true;
    globalThis.fetch = (async (url, init) => {
      calls.push(String(url));
      if (!firstRequest) return anthropicOk("primary recovered");
      firstRequest = false;
      return await new Promise<Response>((_resolve, reject) => {
        const signal = init?.signal;
        signal?.addEventListener("abort", () => reject(signal.reason), { once: true });
        queueMicrotask(() => client.abort(new DOMException("PRIVATE abort detail", "AbortError")));
      });
    }) as typeof fetch;

    try {
      const cancelled = await invokeMessages(cfg, messagesBody(), {
        abortSignal: client.signal,
        continuityCircuit: circuit,
        now: () => 1_000,
      });
      expect(cancelled.status).toBe(499);
      expect(calls).toEqual(["https://primary.test/v1/messages"]);
      expect(circuit.snapshot(1_001)).toEqual([]);
      let [entry] = __requestLogTest.requestLogSnapshot();
      expect(entry.lifecycle).toBe("client_cancel");
      expect(entry.error).toEqual({ kind: "internal", code: "client_cancel" });
      expect(JSON.stringify(await cancelled.json())).not.toContain("PRIVATE abort detail");
      expect(JSON.stringify(entry)).not.toContain("PRIVATE abort detail");

      __requestLogTest.clear();
      const recovered = await invokeMessages(cfg, messagesBody(), {
        continuityCircuit: circuit,
        now: () => 2_000,
      });
      expect(recovered.status).toBe(200);
      expect(calls).toEqual([
        "https://primary.test/v1/messages",
        "https://primary.test/v1/messages",
      ]);
      [entry] = __requestLogTest.requestLogSnapshot();
      expect(entry.attempts).toContainEqual({
        provider: "primary",
        model: "primary-model",
        source: "primary",
        keyIndex: 0,
        status: "ok",
        upstreamStatus: 200,
      });
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});

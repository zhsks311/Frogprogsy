import { describe, expect, test } from "bun:test";
import { OAuthCallbackFlow, parseCallbackInput } from "../src/oauth/callback-server";
import type { OAuthController, OAuthCredentials } from "../src/oauth/types";

/** Picks a port that is very unlikely to collide with another test process. */
function freePort(): number {
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response("ok") });
  const port = server.port;
  server.stop(true);
  return port;
}

class TestFlow extends OAuthCallbackFlow {
  authUrls: { state: string; redirectUri: string }[] = [];
  exchanges: { code: string; state: string; redirectUri: string }[] = [];
  exchangeError: Error | undefined;

  async generateAuthUrl(state: string, redirectUri: string): Promise<{ url: string; instructions?: string }> {
    this.authUrls.push({ state, redirectUri });
    return { url: `https://provider.example/authorize?state=${state}`, instructions: "open the browser" };
  }

  async exchangeToken(code: string, state: string, redirectUri: string): Promise<OAuthCredentials> {
    this.exchanges.push({ code, state, redirectUri });
    if (this.exchangeError) throw this.exchangeError;
    return { access: `access-for-${code}`, refresh: "refresh", expires: Date.now() + 60_000 };
  }
}

interface Harness {
  flow: TestFlow;
  progress: string[];
  authInfo: Promise<{ url: string; instructions?: string }>;
}

function harness(port: number, extra: Partial<OAuthController> = {}, options?: { redirectUri?: string }): Harness {
  const progress: string[] = [];
  let announce: (info: { url: string; instructions?: string }) => void = () => {};
  const authInfo = new Promise<{ url: string; instructions?: string }>(resolve => { announce = resolve; });
  const ctrl: OAuthController = {
    onProgress: message => progress.push(message),
    onAuth: info => announce(info),
    ...extra,
  };
  const flow = new TestFlow(ctrl, {
    preferredPort: port,
    callbackPath: "/callback",
    callbackHostname: "127.0.0.1",
    callbackBindHostname: "127.0.0.1",
    ...(options?.redirectUri ? { redirectUri: options.redirectUri } : {}),
  });
  return { flow, progress, authInfo };
}

/** Attaches a handler immediately so a rejection before the assertion is not reported as unhandled. */
function settle(login: Promise<OAuthCredentials>): Promise<Error | undefined> {
  return login.then(() => undefined, (error: Error) => error);
}

function callbackUrl(port: number, params: Record<string, string>, path = "/callback"): string {
  return `http://127.0.0.1:${port}${path}?${new URLSearchParams(params).toString()}`;
}

describe("OAuth callback flow", () => {
  test("state is a fresh 32-character hex token", () => {
    const flow = new TestFlow({}, 1234);
    const a = flow.generateState();
    expect(a).toMatch(/^[0-9a-f]{32}$/);
    expect(a).not.toBe(flow.generateState());
  });

  test("legacy positional construction keeps the default hostname and path", () => {
    const flow = new TestFlow({}, 1234);
    expect(flow.callbackPath).toBe("/callback");
    expect(flow.callbackHostname).toBe("localhost");
    expect(flow.callbackBindHostname).toBe("localhost");
    expect(flow.redirectUri).toBeUndefined();
  });

  test("a browser callback completes the login and returns the exchanged credentials", async () => {
    const port = freePort();
    const { flow, progress, authInfo } = harness(port);
    const login = flow.login();

    const info = await authInfo;
    expect(info.instructions).toBe("open the browser");
    const state = new URL(info.url).searchParams.get("state") ?? "";
    expect(flow.authUrls[0]).toEqual({ state, redirectUri: `http://127.0.0.1:${port}/callback` });

    const response = await fetch(callbackUrl(port, { code: "auth-code", state }));
    expect(response.status).toBe(200);
    expect(await response.text()).toContain("Login complete");

    await expect(login).resolves.toMatchObject({ access: "access-for-auth-code" });
    expect(flow.exchanges).toEqual([{ code: "auth-code", state, redirectUri: `http://127.0.0.1:${port}/callback` }]);
    expect(progress).toEqual(["Waiting for browser authentication...", "Exchanging authorization code for tokens..."]);
  });

  test("requests outside the callback path are not found", async () => {
    const port = freePort();
    const { flow, authInfo } = harness(port);
    const login = flow.login();
    const state = new URL((await authInfo).url).searchParams.get("state") ?? "";

    const response = await fetch(`http://127.0.0.1:${port}/favicon.ico`);
    expect(response.status).toBe(404);

    await fetch(callbackUrl(port, { code: "auth-code", state }));
    await login;
  });

  test.each([
    ["provider error", { error: "access_denied", error_description: "user said no" }, "Authorization failed: user said no"],
    ["bare provider error", { error: "access_denied" }, "Authorization failed: access_denied"],
    ["missing code", { state: "irrelevant" }, "Missing authorization code"],
  ])("%s fails the login and renders the reason", async (_label, params, message) => {
    const port = freePort();
    const { flow, authInfo } = harness(port);
    const failure = settle(flow.login());
    await authInfo;

    const response = await fetch(callbackUrl(port, params));
    expect(response.status).toBe(500);
    expect(await response.text()).toContain(message);
    expect((await failure)?.message).toBe(message);
    expect(flow.exchanges).toEqual([]);
  });

  test("a mismatched state is rejected as a possible CSRF attempt", async () => {
    const port = freePort();
    const { flow, authInfo } = harness(port);
    const failure = settle(flow.login());
    await authInfo;

    const response = await fetch(callbackUrl(port, { code: "auth-code", state: "not-the-state" }));
    expect(response.status).toBe(500);
    expect((await failure)?.message).toBe("State mismatch - possible CSRF attack");
  });

  test("the error page escapes provider-supplied text", async () => {
    const port = freePort();
    const { flow, authInfo } = harness(port);
    const failure = settle(flow.login());
    await authInfo;

    const response = await fetch(callbackUrl(port, { error: "x", error_description: "<script>alert('x')</script>" }));
    const body = await response.text();
    expect(body).not.toContain("<script>");
    expect(body).toContain("&lt;script&gt;alert(&#39;x&#39;)&lt;/script&gt;");
    expect((await failure)?.message).toContain("Authorization failed");
  });

  test("an aborted controller cancels the wait", async () => {
    const port = freePort();
    const controller = new AbortController();
    const { flow, authInfo } = harness(port, { signal: controller.signal });
    const login = flow.login();
    await authInfo;
    controller.abort(new Error("user cancelled"));
    await expect(login).rejects.toThrow(/OAuth callback cancelled/);
  });

  test("an occupied preferred port falls back to a random port", async () => {
    const port = freePort();
    const blocker = Bun.serve({ hostname: "127.0.0.1", port, fetch: () => new Response("busy") });
    try {
      const { flow, progress, authInfo } = harness(port);
      const login = flow.login();
      await authInfo;

      const redirectUri = flow.authUrls[0]?.redirectUri ?? "";
      const actualPort = Number(new URL(redirectUri).port);
      expect(actualPort).not.toBe(port);
      expect(progress[0]).toBe(`Preferred port ${port} unavailable, using port ${actualPort}`);

      const state = flow.authUrls[0]?.state ?? "";
      await fetch(callbackUrl(actualPort, { code: "auth-code", state }));
      await expect(login).resolves.toMatchObject({ access: "access-for-auth-code" });
    } finally {
      blocker.stop(true);
    }
  });

  test("a fixed redirect URI cannot fall back to another port", async () => {
    const port = freePort();
    const blocker = Bun.serve({ hostname: "127.0.0.1", port, fetch: () => new Response("busy") });
    try {
      const { flow } = harness(port, {}, { redirectUri: `http://127.0.0.1:${port}/callback` });
      await expect(flow.login()).rejects.toThrow(`OAuth callback port ${port} unavailable; cannot fall back to a random port`);
    } finally {
      blocker.stop(true);
    }
  });

  test("manual code entry completes the login, ignoring unusable inputs", async () => {
    const port = freePort();
    const inputs = ["", "https://provider.example/callback?state=wrong-state&code=mismatched", "manual-code"];
    let index = 0;
    const { flow, authInfo } = harness(port, { onManualCodeInput: async () => inputs[index++] ?? "manual-code" });
    const login = flow.login();
    await authInfo;

    await expect(login).resolves.toMatchObject({ access: "access-for-manual-code" });
    expect(flow.exchanges[0]?.code).toBe("manual-code");
  });
});

describe("parseCallbackInput", () => {
  test.each([
    ["", {}],
    ["   ", {}],
    ["https://provider.example/cb?code=abc&state=xyz", { code: "abc", state: "xyz" }],
    ["https://provider.example/cb", { code: undefined, state: undefined }],
    ["?code=abc&state=xyz", { code: "abc", state: "xyz" }],
    ["#code=abc", { code: "abc", state: undefined }],
    ["code=abc", { code: "abc", state: undefined }],
    ["raw-code", { code: "raw-code", state: undefined }],
    ["raw-code#state-1", { code: "raw-code", state: "state-1" }],
  ])("parses %p", (input, expected) => {
    expect(parseCallbackInput(input)).toEqual(expected);
  });
});

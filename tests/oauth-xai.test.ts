import { afterEach, describe, expect, test } from "bun:test";
import {
  discoverXaiOAuthEndpoints,
  refreshXaiToken,
  XAI_OAUTH_CLIENT_ID,
  XAI_OAUTH_DISCOVERY_URL,
  XAI_OAUTH_SCOPE,
  XaiOAuthFlow,
} from "../src/oauth/xai";

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
});

const DISCOVERY = {
  authorization_endpoint: "https://auth.x.ai/oauth2/auth",
  token_endpoint: "https://auth.x.ai/oauth2/token",
};

function jwt(payload: Record<string, unknown>): string {
  return [
    Buffer.from(JSON.stringify({ alg: "none" })).toString("base64url"),
    Buffer.from(JSON.stringify(payload)).toString("base64url"),
    "sig",
  ].join(".");
}

interface StubCall {
  url: string;
  init: RequestInit | undefined;
}

/** Replaces global fetch with a URL-keyed stub and records every call. */
function stubFetch(routes: Record<string, () => Response>): StubCall[] {
  const calls: StubCall[] = [];
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    calls.push({ url, init });
    const route = Object.entries(routes).find(([prefix]) => url.startsWith(prefix));
    if (!route) throw new Error(`unexpected fetch: ${url}`);
    return route[1]();
  }) as typeof fetch;
  return calls;
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

describe("xAI OAuth discovery", () => {
  test("returns the advertised endpoints when they are https x.ai URLs", async () => {
    const calls = stubFetch({ [XAI_OAUTH_DISCOVERY_URL]: () => json(DISCOVERY) });
    await expect(discoverXaiOAuthEndpoints()).resolves.toEqual({
      authorizationEndpoint: "https://auth.x.ai/oauth2/auth",
      tokenEndpoint: "https://auth.x.ai/oauth2/token",
    });
    expect(calls).toHaveLength(1);
    expect((calls[0]?.init?.headers as Record<string, string>).Accept).toBe("application/json");
  });

  test("rejects a non-2xx discovery response", async () => {
    stubFetch({ [XAI_OAUTH_DISCOVERY_URL]: () => new Response("nope", { status: 503 }) });
    await expect(discoverXaiOAuthEndpoints()).rejects.toThrow("xAI OAuth discovery failed: 503 nope");
  });

  test("rejects a discovery payload missing the endpoints", async () => {
    stubFetch({ [XAI_OAUTH_DISCOVERY_URL]: () => json({ token_endpoint: DISCOVERY.token_endpoint }) });
    await expect(discoverXaiOAuthEndpoints()).rejects.toThrow(/missing authorization\/token endpoints/);
  });

  test("rejects endpoints that are not https on an x.ai host", async () => {
    stubFetch({ [XAI_OAUTH_DISCOVERY_URL]: () => json({ ...DISCOVERY, token_endpoint: "https://evil.example.com/token" }) });
    await expect(discoverXaiOAuthEndpoints()).rejects.toThrow(/unexpected endpoint: https:\/\/evil.example.com\/token/);

    stubFetch({ [XAI_OAUTH_DISCOVERY_URL]: () => json({ ...DISCOVERY, authorization_endpoint: "http://auth.x.ai/auth" }) });
    await expect(discoverXaiOAuthEndpoints()).rejects.toThrow(/unexpected endpoint: http:\/\/auth.x.ai\/auth/);
  });

  test("propagates an aborted caller signal", async () => {
    stubFetch({ [XAI_OAUTH_DISCOVERY_URL]: () => json(DISCOVERY) });
    globalThis.fetch = (async (_input: RequestInfo | URL, init?: RequestInit) => {
      init?.signal?.throwIfAborted();
      return json(DISCOVERY);
    }) as typeof fetch;
    await expect(discoverXaiOAuthEndpoints(AbortSignal.abort())).rejects.toThrow();
  });
});

describe("xAI OAuth authorization URL", () => {
  test("carries the PKCE challenge, client id, scope and state", async () => {
    stubFetch({ [XAI_OAUTH_DISCOVERY_URL]: () => json(DISCOVERY) });
    const flow = new XaiOAuthFlow({});
    const { url, instructions } = await flow.generateAuthUrl("state-1", "http://127.0.0.1:56121/callback");
    const parsed = new URL(url);
    expect(parsed.origin + parsed.pathname).toBe(DISCOVERY.authorization_endpoint);
    expect(parsed.searchParams.get("response_type")).toBe("code");
    expect(parsed.searchParams.get("client_id")).toBe(XAI_OAUTH_CLIENT_ID);
    expect(parsed.searchParams.get("redirect_uri")).toBe("http://127.0.0.1:56121/callback");
    expect(parsed.searchParams.get("scope")).toBe(XAI_OAUTH_SCOPE);
    expect(parsed.searchParams.get("code_challenge_method")).toBe("S256");
    expect(parsed.searchParams.get("code_challenge")).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(parsed.searchParams.get("state")).toBe("state-1");
    expect(parsed.searchParams.get("nonce")).toMatch(/^[0-9a-f-]{36}$/);
    expect(instructions).toContain("xAI/Grok login");
  });

  test("exchangeToken refuses to run before the PKCE verifier exists", async () => {
    await expect(new XaiOAuthFlow({}).exchangeToken("code", "state", "http://127.0.0.1:56121/callback"))
      .rejects.toThrow("xAI OAuth PKCE verifier was not initialized");
  });
});

describe("xAI OAuth token exchange", () => {
  test("posts the authorization code with the PKCE verifier and derives identity from the id token", async () => {
    const access = jwt({ sub: "sub-from-access" });
    const idToken = jwt({ sub: "acct-1", email: "User@Example.com" });
    const calls = stubFetch({
      [XAI_OAUTH_DISCOVERY_URL]: () => json(DISCOVERY),
      [DISCOVERY.token_endpoint]: () => json({ access_token: access, refresh_token: "refresh-1", expires_in: 3600, id_token: idToken }),
    });

    const flow = new XaiOAuthFlow({});
    const { url } = await flow.generateAuthUrl("state-1", "http://127.0.0.1:56121/callback");
    const verifierChallenge = new URL(url).searchParams.get("code_challenge");
    const credentials = await flow.exchangeToken("auth-code", "state-1", "http://127.0.0.1:56121/callback");

    expect(credentials).toMatchObject({ access, refresh: "refresh-1", accountId: "acct-1", email: "user@example.com" });
    expect(credentials.expires).toBeGreaterThan(Date.now());
    expect(credentials.expires).toBeLessThanOrEqual(Date.now() + 3600_000);

    // discovery is reused from generateAuthUrl, so only one extra request is made
    expect(calls).toHaveLength(2);
    const body = new URLSearchParams(String(calls[1]?.init?.body));
    expect(Object.fromEntries(body)).toMatchObject({
      grant_type: "authorization_code",
      client_id: XAI_OAUTH_CLIENT_ID,
      code: "auth-code",
      redirect_uri: "http://127.0.0.1:56121/callback",
    });
    expect(body.get("code_verifier")).toBeTruthy();
    expect(verifierChallenge).toBeTruthy();
  });

  test("falls back to the access token payload for identity and defaults the lifetime", async () => {
    stubFetch({
      [XAI_OAUTH_DISCOVERY_URL]: () => json(DISCOVERY),
      [DISCOVERY.token_endpoint]: () => json({ access_token: jwt({ sub: "acct-2", email: "a@b.io" }), refresh_token: "r" }),
    });
    const credentials = await refreshXaiToken("old-refresh");
    expect(credentials).toMatchObject({ accountId: "acct-2", email: "a@b.io" });
    expect(credentials.expires).toBeGreaterThan(Date.now() + 3000_000);
  });

  test("an unparsable access token yields credentials without identity", async () => {
    stubFetch({
      [XAI_OAUTH_DISCOVERY_URL]: () => json(DISCOVERY),
      [DISCOVERY.token_endpoint]: () => json({ access_token: "opaque-token", refresh_token: "r", id_token: "a.b" }),
    });
    const credentials = await refreshXaiToken("old-refresh");
    expect(credentials.accountId).toBeUndefined();
    expect(credentials.email).toBeUndefined();
  });

  test("rejects a token response without an access token or refresh token", async () => {
    stubFetch({
      [XAI_OAUTH_DISCOVERY_URL]: () => json(DISCOVERY),
      [DISCOVERY.token_endpoint]: () => json({ refresh_token: "r" }),
    });
    await expect(refreshXaiToken("old")).rejects.toThrow("xAI token response did not include an access token");

    stubFetch({
      [XAI_OAUTH_DISCOVERY_URL]: () => json(DISCOVERY),
      [DISCOVERY.token_endpoint]: () => json({ access_token: "tok" }),
    });
    const flow = new XaiOAuthFlow({});
    await flow.generateAuthUrl("state-1", "http://127.0.0.1:56121/callback");
    await expect(flow.exchangeToken("code", "state-1", "http://127.0.0.1:56121/callback"))
      .rejects.toThrow("xAI token response did not include a refresh token");
  });

  test("surfaces a failing token request with status and body", async () => {
    stubFetch({
      [XAI_OAUTH_DISCOVERY_URL]: () => json(DISCOVERY),
      [DISCOVERY.token_endpoint]: () => new Response("invalid_grant", { status: 400 }),
    });
    await expect(refreshXaiToken("old")).rejects.toThrow("xAI token request failed: 400 invalid_grant");
  });
});

describe("xAI token refresh", () => {
  test("refresh reuses the supplied token when the response omits one", async () => {
    const calls = stubFetch({
      [XAI_OAUTH_DISCOVERY_URL]: () => json(DISCOVERY),
      [DISCOVERY.token_endpoint]: () => json({ access_token: "tok", expires_in: 600 }),
    });
    const credentials = await refreshXaiToken("kept-refresh");
    expect(credentials.refresh).toBe("kept-refresh");
    expect(Object.fromEntries(new URLSearchParams(String(calls[1]?.init?.body)))).toEqual({
      grant_type: "refresh_token",
      client_id: XAI_OAUTH_CLIENT_ID,
      refresh_token: "kept-refresh",
    });
  });

  test("refresh without a token fails before any network call", async () => {
    const calls = stubFetch({});
    await expect(refreshXaiToken("")).rejects.toThrow(/expired and do not include a refresh token/);
    expect(calls).toHaveLength(0);
  });
});

import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { getConfigDir } from "../src/config";
import { loginKimi, refreshKimiToken } from "../src/oauth/kimi";

const originalFetch = globalThis.fetch;
const originalHost = process.env.KIMI_CODE_OAUTH_HOST;

afterEach(() => {
  globalThis.fetch = originalFetch;
  if (originalHost === undefined) delete process.env.KIMI_CODE_OAUTH_HOST;
  else process.env.KIMI_CODE_OAUTH_HOST = originalHost;
});

interface StubCall {
  url: string;
  headers: Record<string, string>;
  body: URLSearchParams;
}

/** Replaces global fetch with a queue of scripted responses and records every call. */
function stubFetch(responses: (() => Response)[]): StubCall[] {
  const calls: StubCall[] = [];
  let index = 0;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    calls.push({
      url,
      headers: (init?.headers ?? {}) as Record<string, string>,
      body: new URLSearchParams(String(init?.body ?? "")),
    });
    const next = responses[index++];
    if (!next) throw new Error(`unexpected fetch #${index}: ${url}`);
    return next();
  }) as typeof fetch;
  return calls;
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

const DEVICE_OK = () => json({
  user_code: "ABCD-1234",
  device_code: "device-1",
  verification_uri: "https://auth.kimi.com/device",
  verification_uri_complete: "https://auth.kimi.com/device?code=ABCD-1234",
  expires_in: 900,
  interval: 1,
});

describe("Kimi device authorization", () => {
  test("reports the verification URL and code, then returns the polled credentials", async () => {
    const calls = stubFetch([DEVICE_OK, () => json({ access_token: "access-1", refresh_token: "refresh-1", expires_in: 3600 })]);
    const seen: { url: string; instructions?: string }[] = [];

    const credentials = await loginKimi({ onAuth: info => seen.push(info) });

    expect(seen).toEqual([{ url: "https://auth.kimi.com/device?code=ABCD-1234", instructions: "Enter code: ABCD-1234" }]);
    expect(credentials).toMatchObject({ access: "access-1", refresh: "refresh-1" });
    // expiry is skewed 5 minutes earlier than the raw expires_in
    expect(credentials.expires).toBeLessThanOrEqual(Date.now() + 3600_000 - 300_000);
    expect(calls[0]?.url).toBe("https://auth.kimi.com/api/oauth/device_authorization");
    expect(calls[1]?.url).toBe("https://auth.kimi.com/api/oauth/token");
    expect(calls[1]?.body.get("grant_type")).toBe("urn:ietf:params:oauth:grant-type:device_code");
    expect(calls[1]?.body.get("device_code")).toBe("device-1");
  });

  test("falls back to verification_uri when the complete URL is absent", async () => {
    stubFetch([
      () => json({ user_code: "C", device_code: "d", verification_uri: "https://auth.kimi.com/device" }),
      () => json({ access_token: "a", refresh_token: "r", expires_in: 60 }),
    ]);
    const seen: string[] = [];
    await loginKimi({ onAuth: info => seen.push(info.url) });
    expect(seen).toEqual(["https://auth.kimi.com/device"]);
  });

  test("honours KIMI_CODE_OAUTH_HOST", async () => {
    process.env.KIMI_CODE_OAUTH_HOST = "https://kimi.test";
    const calls = stubFetch([DEVICE_OK, () => json({ access_token: "a", refresh_token: "r", expires_in: 60 })]);
    await loginKimi({});
    expect(calls[0]?.url).toBe("https://kimi.test/api/oauth/device_authorization");
  });

  test("sends the Kimi CLI identification headers and a stable device id", async () => {
    const calls = stubFetch([DEVICE_OK, () => json({ access_token: "a", refresh_token: "r", expires_in: 60 })]);
    await loginKimi({});

    const headers = calls[0]?.headers ?? {};
    expect(headers["User-Agent"]).toMatch(/^KimiCLI\//);
    expect(headers["X-Msh-Platform"]).toBe("kimi_cli");
    expect(headers["X-Msh-Device-Id"]).toMatch(/^[0-9a-f]{32}$/);
    expect(calls[1]?.headers["X-Msh-Device-Id"]).toBe(headers["X-Msh-Device-Id"]);

    const deviceIdPath = join(getConfigDir(), "kimi-device-id");
    expect(existsSync(deviceIdPath)).toBe(true);
    expect(readFileSync(deviceIdPath, "utf8").trim()).toBe(headers["X-Msh-Device-Id"] ?? "");
  });

  test("rejects a failed or incomplete device authorization response", async () => {
    stubFetch([() => new Response("rate limited", { status: 429 })]);
    await expect(loginKimi({})).rejects.toThrow("Kimi device authorization failed: 429 rate limited");

    stubFetch([() => json({ user_code: "C", device_code: "d" })]);
    await expect(loginKimi({})).rejects.toThrow("Kimi device authorization response missing required fields");
  });

  test("times out without polling when the device flow is already expired", async () => {
    const calls = stubFetch([() => json({ user_code: "C", device_code: "d", verification_uri: "https://auth.kimi.com/device", expires_in: 0 })]);
    await expect(loginKimi({})).rejects.toThrow("Kimi device flow timed out");
    expect(calls).toHaveLength(1);
  });
});

describe("Kimi device-flow polling", () => {
  test("keeps polling while the authorization is pending", async () => {
    const calls = stubFetch([
      DEVICE_OK,
      () => json({ error: "authorization_pending" }, 400),
      () => json({ access_token: "access-2", refresh_token: "refresh-2", expires_in: 120 }),
    ]);
    await expect(loginKimi({})).resolves.toMatchObject({ access: "access-2" });
    expect(calls).toHaveLength(3);
  });

  test("a cancelled login stops the poll wait", async () => {
    const controller = new AbortController();
    stubFetch([DEVICE_OK, () => { controller.abort(); return json({ error: "slow_down", interval: 30 }, 429); }]);
    await expect(loginKimi({ signal: controller.signal })).rejects.toThrow("Login cancelled");
  });

  test("a pre-aborted signal never reaches the token endpoint", async () => {
    const calls = stubFetch([DEVICE_OK]);
    await expect(loginKimi({ signal: AbortSignal.abort() })).rejects.toThrow("Login cancelled");
    expect(calls).toHaveLength(1);
  });

  test("maps terminal device-flow errors to explicit messages", async () => {
    for (const [error, message] of [
      ["expired_token", "Kimi device authorization expired"],
      ["access_denied", "Kimi device authorization denied"],
    ] as const) {
      stubFetch([DEVICE_OK, () => json({ error }, 400)]);
      await expect(loginKimi({})).rejects.toThrow(message);
    }

    stubFetch([DEVICE_OK, () => json({ error: "invalid_client", error_description: "bad client" }, 401)]);
    await expect(loginKimi({})).rejects.toThrow("Kimi device flow failed: invalid_client: bad client");

    stubFetch([DEVICE_OK, () => json({}, 500)]);
    await expect(loginKimi({})).rejects.toThrow("Kimi device flow failed: 500");
  });

  test("rejects a token payload missing the access token or refresh token", async () => {
    stubFetch([DEVICE_OK, () => json({ access_token: "a" })]);
    await expect(loginKimi({})).rejects.toThrow("Kimi token response missing required fields");

    stubFetch([DEVICE_OK, () => json({ access_token: "a", expires_in: 60 })]);
    await expect(loginKimi({})).rejects.toThrow("Kimi token response missing refresh token");
  });
});

describe("Kimi token refresh", () => {
  test("sends the refresh grant and keeps the existing refresh token when none is returned", async () => {
    const calls = stubFetch([() => json({ access_token: "access-3", expires_in: 1800 })]);
    const credentials = await refreshKimiToken("refresh-old");

    expect(Object.fromEntries(calls[0]?.body ?? new URLSearchParams())).toMatchObject({
      grant_type: "refresh_token",
      refresh_token: "refresh-old",
    });
    expect(credentials).toMatchObject({ access: "access-3", refresh: "refresh-old" });
  });

  test("surfaces the upstream error description on a failed refresh", async () => {
    stubFetch([() => json({ error_description: "refresh expired" }, 401)]);
    await expect(refreshKimiToken("refresh-old")).rejects.toThrow("Kimi token refresh failed: 401: refresh expired");

    stubFetch([() => new Response("nope", { status: 500 })]);
    await expect(refreshKimiToken("refresh-old")).rejects.toThrow("Kimi token refresh failed: 500");
  });

  test("rejects a refresh payload without the required fields", async () => {
    stubFetch([() => json({ access_token: "a" })]);
    await expect(refreshKimiToken("refresh-old")).rejects.toThrow("Kimi token response missing required fields");
  });
});

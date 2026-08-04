import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getLocalAccessTokenPath, readLocalAccessToken, saveConfig } from "../src/config";
import {
  __resetLocalAccessRegistry,
  __resetLocalAccessRequestWindows,
  authorizeLocalAccess,
  generateLocalAccessSecret,
  hashLocalAccessSecret,
  isLocalAccessSecret,
  localAccessConfigIssue,
  registerLocalAccessKeys,
  LOCAL_ACCESS_HEADER,
} from "../src/local-access";
import { startServer } from "../src/server";
import type { FrogConfig, LocalAccessKeyConfig } from "../src/types";

let testDir = "";
let previousFrogHome: string | undefined;
let previousNoClaudeWrites: string | undefined;

const SECRET = "frogp_test-key-value";

function key(overrides: Partial<LocalAccessKeyConfig> = {}): LocalAccessKeyConfig {
  return { id: "lk_test", label: "test", secretHash: hashLocalAccessSecret(SECRET), ...overrides };
}

function baseConfig(overrides: Partial<FrogConfig> = {}): FrogConfig {
  return {
    port: 0,
    hostname: "127.0.0.1",
    defaultProvider: "anthropic",
    providers: {
      anthropic: {
        adapter: "anthropic",
        baseUrl: "https://api.anthropic.com",
        authMode: "forward",
        defaultModel: "claude-haiku-4-5",
        models: ["claude-haiku-4-5"],
      },
    },
    ...overrides,
  } as FrogConfig;
}

function headers(entries: Record<string, string>): Headers {
  return new Headers(entries);
}

beforeEach(() => {
  previousFrogHome = process.env.FROGPROGSY_HOME;
  previousNoClaudeWrites = process.env.FROGPROGSY_NO_CLAUDE_WRITES;
  testDir = mkdtempSync(join(tmpdir(), "frog-local-access-"));
  process.env.FROGPROGSY_HOME = testDir;
  process.env.FROGPROGSY_NO_CLAUDE_WRITES = "1";
  __resetLocalAccessRegistry();
  __resetLocalAccessRequestWindows();
});

afterEach(() => {
  if (previousFrogHome === undefined) delete process.env.FROGPROGSY_HOME;
  else process.env.FROGPROGSY_HOME = previousFrogHome;
  if (previousNoClaudeWrites === undefined) delete process.env.FROGPROGSY_NO_CLAUDE_WRITES;
  else process.env.FROGPROGSY_NO_CLAUDE_WRITES = previousNoClaudeWrites;
  __resetLocalAccessRegistry();
  __resetLocalAccessRequestWindows();
  if (testDir) rmSync(testDir, { recursive: true, force: true });
  testDir = "";
});

describe("local access key verification", () => {
  test("stores only a sha256 digest and generates unique 256-bit keys", () => {
    const hash = hashLocalAccessSecret(SECRET);
    expect(hash).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(hash).not.toContain(SECRET);
    expect(generateLocalAccessSecret()).not.toBe(generateLocalAccessSecret());
  });

  test("accepts a matching key from every supported header and rejects everything else", () => {
    const config = baseConfig({ localAccess: { enabled: true, keys: [key()] } });

    for (const carrier of [
      { [LOCAL_ACCESS_HEADER]: SECRET },
      { "x-api-key": SECRET },
      { authorization: `Bearer ${SECRET}` },
    ]) {
      expect(authorizeLocalAccess(config, headers(carrier)).ok).toBe(true);
    }

    expect(authorizeLocalAccess(config, headers({}))).toEqual({ ok: false, reason: "missing_key" });
    expect(authorizeLocalAccess(config, headers({ "x-api-key": "frogp_wrong" }))).toEqual({ ok: false, reason: "unknown_key" });
    expect(authorizeLocalAccess(config, headers({ "x-api-key": SECRET.slice(0, -1) }))).toEqual({ ok: false, reason: "unknown_key" });
  });

  test("enforces the per-key sliding window and reports when it reopens", () => {
    const config = baseConfig({
      localAccess: { enabled: true, keys: [key({ requestLimit: { windowSec: 60, maxRequests: 2 } })] },
    });
    const carrier = headers({ [LOCAL_ACCESS_HEADER]: SECRET });
    const start = 1_000_000;

    expect(authorizeLocalAccess(config, carrier, start).ok).toBe(true);
    expect(authorizeLocalAccess(config, carrier, start + 1000).ok).toBe(true);
    expect(authorizeLocalAccess(config, carrier, start + 2000)).toEqual({ ok: false, reason: "rate_limited", retryAfterSec: 58 });
    // The window slides: once the first hit ages out, the key is admitted again.
    expect(authorizeLocalAccess(config, carrier, start + 61_000).ok).toBe(true);
  });

  test("a registered key is not treated as a caller credential to relay upstream", () => {
    expect(isLocalAccessSecret(SECRET)).toBe(false);
    registerLocalAccessKeys(baseConfig({ localAccess: { enabled: true, keys: [key()] } }));
    expect(isLocalAccessSecret(SECRET)).toBe(true);
    expect(isLocalAccessSecret(`Bearer ${SECRET}`)).toBe(true);
    expect(isLocalAccessSecret("sk-a-real-provider-key")).toBe(false);
  });
});

describe("local access config validation", () => {
  test("rejects a key list that cannot authenticate anything", () => {
    expect(localAccessConfigIssue(baseConfig({ localAccess: { enabled: true, keys: [] } }))).toContain("empty");
    expect(localAccessConfigIssue(baseConfig({ localAccess: { enabled: true, keys: [key({ id: "" })] } }))).toContain("non-empty id");
    expect(localAccessConfigIssue(baseConfig({ localAccess: { enabled: true, keys: [key(), key()] } }))).toContain("duplicate");
    expect(localAccessConfigIssue(baseConfig({ localAccess: { enabled: true, keys: [key({ secretHash: "not-a-hash" })] } }))).toContain("secretHash");
    expect(localAccessConfigIssue(baseConfig({
      localAccess: { enabled: true, keys: [key({ requestLimit: { windowSec: 0, maxRequests: 5 } })] },
    }))).toContain("requestLimit");
    expect(localAccessConfigIssue(baseConfig({ localAccess: { enabled: true, keys: [key({ providers: ["anthropic"] })] } })))
      .toContain("not enforced yet");
    expect(localAccessConfigIssue(baseConfig({ localAccess: { enabled: true, keys: [key()] } }))).toBeNull();
  });
});

describe("relay enforcement", () => {
  test("an enabled relay authenticates /api and /v1 while /healthz stays open", async () => {
    saveConfig(baseConfig({ localAccess: { enabled: true, keys: [key()] } }));
    const server = startServer(0);
    try {
      const anonymous = await fetch(new URL("/api/settings", server.url));
      expect(anonymous.status).toBe(401);
      expect((await anonymous.json() as { error?: { message?: string } }).error?.message).toContain(LOCAL_ACCESS_HEADER);

      const wrongKey = await fetch(new URL("/api/settings", server.url), { headers: { [LOCAL_ACCESS_HEADER]: "frogp_wrong" } });
      expect(wrongKey.status).toBe(401);

      const authenticated = await fetch(new URL("/api/settings", server.url), { headers: { [LOCAL_ACCESS_HEADER]: SECRET } });
      expect(authenticated.status).toBe(200);

      const dataPlane = await fetch(new URL("/v1/models", server.url));
      expect(dataPlane.status).toBe(401);

      const health = await fetch(new URL("/healthz", server.url));
      expect(health.status).toBe(200);
    } finally {
      await server.stop(true);
    }
  });

  test("a spent request limit answers 429 with Retry-After", async () => {
    saveConfig(baseConfig({
      localAccess: { enabled: true, keys: [key({ requestLimit: { windowSec: 60, maxRequests: 1 } })] },
    }));
    const server = startServer(0);
    try {
      const first = await fetch(new URL("/api/settings", server.url), { headers: { [LOCAL_ACCESS_HEADER]: SECRET } });
      expect(first.status).toBe(200);
      const second = await fetch(new URL("/api/settings", server.url), { headers: { [LOCAL_ACCESS_HEADER]: SECRET } });
      expect(second.status).toBe(429);
      expect(Number(second.headers.get("Retry-After"))).toBeGreaterThan(0);
    } finally {
      await server.stop(true);
    }
  });

  test("an enabled relay admits same-machine tooling through the per-start token file", async () => {
    saveConfig(baseConfig({ localAccess: { enabled: true, keys: [key()] } }));
    const server = startServer(0);
    try {
      const token = readLocalAccessToken();
      expect(token).toMatch(/^frogp_/);
      expect(token).not.toBe(SECRET);
      // Windows has no POSIX permission bits; NTFS reports 0o666 regardless of the requested mode.
      if (process.platform !== "win32") {
        expect(statSync(getLocalAccessTokenPath()).mode & 0o777).toBe(0o600);
      }

      const withToken = await fetch(new URL("/api/settings", server.url), { headers: { [LOCAL_ACCESS_HEADER]: token! } });
      expect(withToken.status).toBe(200);
      const stale = await fetch(new URL("/api/settings", server.url), { headers: { [LOCAL_ACCESS_HEADER]: `${token}x` } });
      expect(stale.status).toBe(401);
    } finally {
      await server.stop(true);
    }
  });

  test("a disabled relay writes no token and keeps loopback requests unauthenticated", async () => {
    saveConfig(baseConfig());
    const server = startServer(0);
    try {
      expect(readLocalAccessToken()).toBeNull();
      expect((await fetch(new URL("/api/settings", server.url))).status).toBe(200);
    } finally {
      await server.stop(true);
    }
  });

  test("refuses to bind a non-loopback hostname without any key", () => {
    saveConfig(baseConfig({ hostname: "0.0.0.0" }));
    expect(() => startServer(0)).toThrow(/Refusing to bind 0\.0\.0\.0 without request authentication/);
  });

  test("refuses to start when an enabled key list cannot authenticate anything", () => {
    saveConfig(baseConfig({ localAccess: { enabled: true, keys: [key({ secretHash: "nope" })] } }));
    expect(() => startServer(0)).toThrow(/Invalid localAccess/);
  });
});

import { afterEach, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { detectKiroCliCredential, loginKiro, refreshKiroCredential } from "../src/oauth/kiro";
import { resolveProviderAuth } from "../src/provider-auth";
import type { FrogProviderConfig } from "../src/types";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function createKiroDatabase(
  expiresAt: string,
  options: { authType?: "social" | "oidc"; registration?: boolean } = {},
): string {
  const root = mkdtempSync(join(tmpdir(), "frogprogsy-kiro-auth-"));
  roots.push(root);
  const path = join(root, "data.sqlite3");
  const db = new Database(path, { create: true });
  db.exec("CREATE TABLE auth_kv (key TEXT PRIMARY KEY, value TEXT NOT NULL)");
  db.exec("CREATE TABLE state (key TEXT PRIMARY KEY, value TEXT NOT NULL)");
  const authType = options.authType ?? "social";
  db.query("INSERT INTO auth_kv (key, value) VALUES (?1, ?2)").run(
    authType === "social" ? "kirocli:social:token" : "kirocli:odic:token",
    JSON.stringify({
      access_token: "test-kiro-access",
      refresh_token: "test-kiro-refresh",
      expires_at: expiresAt,
      ...(authType === "oidc" ? { region: "us-west-2" } : {}),
    }),
  );
  if (options.registration) {
    db.query("INSERT INTO auth_kv (key, value) VALUES (?1, ?2)").run(
      "kirocli:odic:device-registration",
      JSON.stringify({ client_id: "test-client-id", client_secret: "test-client-secret", region: "us-west-2" }),
    );
  }
  db.query("INSERT INTO state (key, value) VALUES (?1, ?2)").run("api.codewhisperer.profile", JSON.stringify({
    arn: "arn:aws:codewhisperer:eu-central-1:000000000000:profile/test",
  }));
  db.close();
  return path;
}

function setTokenExpiry(path: string, expiresAt: string): void {
  const db = new Database(path);
  const row = db.query("SELECT key, value FROM auth_kv WHERE key LIKE '%:token'").get() as { key: string; value: string };
  const token = JSON.parse(row.value) as Record<string, unknown>;
  token.expires_at = expiresAt;
  token.access_token = "test-kiro-login-access";
  db.query("UPDATE auth_kv SET value = ?1 WHERE key = ?2").run(JSON.stringify(token), row.key);
  db.close();
}

function storedToken(path: string): string {
  const db = new Database(path, { readonly: true });
  const row = db.query("SELECT value FROM auth_kv WHERE key LIKE '%:token'").get() as { value: string };
  db.close();
  return row.value;
}

describe("Kiro CLI credential boundary", () => {
  test("imports the current social CLI session read-only with runtime metadata", () => {
    const path = createKiroDatabase(new Date(Date.now() + 3_600_000).toISOString());
    const before = storedToken(path);

    const credential = detectKiroCliCredential(path);

    expect(credential).toEqual({
      access: "test-kiro-access",
      refresh: "test-kiro-refresh",
      expires: expect.any(Number),
      providerMetadata: {
        kiro: {
          source: "kiro-cli",
          authType: "social",
          region: "eu-central-1",
          profileArn: "arn:aws:codewhisperer:eu-central-1:000000000000:profile/test",
        },
      },
    });
    expect(storedToken(path)).toBe(before);
  });

  test("imports an already-current CLI session without starting another login", async () => {
    const path = createKiroDatabase(new Date(Date.now() + 3_600_000).toISOString());
    const calls: string[][] = [];

    const credential = await loginKiro({}, {
      databasePath: path,
      runCli: async args => {
        calls.push(args);
        return 0;
      },
    });

    expect(calls).toEqual([]);
    expect(credential.access).toBe("test-kiro-access");
  });

  test("delegates an expired session to the official interactive login command", async () => {
    const path = createKiroDatabase(new Date(Date.now() - 60_000).toISOString());
    const calls: string[][] = [];

    const credential = await loginKiro({}, {
      databasePath: path,
      runCli: async (args, options) => {
        calls.push(args);
        expect(options.interactive).toBe(true);
        setTokenExpiry(path, new Date(Date.now() + 3_600_000).toISOString());
        return 0;
      },
    });

    expect(calls).toEqual([["login"]]);
    expect(credential.access).toBe("test-kiro-login-access");
  });

  test("refreshes a social copy without writing the native CLI database", async () => {
    const path = createKiroDatabase(new Date(Date.now() - 60_000).toISOString());
    const credential = detectKiroCliCredential(path)!;
    const before = storedToken(path);
    const requests: Array<{ url: string; init?: RequestInit }> = [];

    const fresh = await refreshKiroCredential(credential, undefined, {
      databasePath: path,
      fetchFn: async (input, init) => {
        requests.push({ url: String(input), init });
        return Response.json({ accessToken: "test-refreshed-access", refreshToken: "test-refreshed-refresh", expiresIn: 3600 });
      },
    });

    expect(requests).toHaveLength(1);
    expect(requests[0]!.url).toBe("https://prod.eu-central-1.auth.desktop.kiro.dev/refreshToken");
    expect(JSON.parse(String(requests[0]!.init?.body))).toEqual({ refreshToken: "test-kiro-refresh" });
    expect(fresh.access).toBe("test-refreshed-access");
    expect(fresh.refresh).toBe("test-refreshed-refresh");
    expect(storedToken(path)).toBe(before);
  });

  test("refreshes OIDC with the native registration and distinct SSO region", async () => {
    const path = createKiroDatabase(new Date(Date.now() - 60_000).toISOString(), { authType: "oidc", registration: true });
    const credential = detectKiroCliCredential(path)!;
    let capturedUrl = "";
    let capturedBody: Record<string, unknown> = {};

    const fresh = await refreshKiroCredential(credential, undefined, {
      databasePath: path,
      fetchFn: async (input, init) => {
        capturedUrl = String(input);
        capturedBody = JSON.parse(String(init?.body));
        return Response.json({ accessToken: "test-oidc-access", refreshToken: "test-oidc-refresh", expiresIn: 1800 });
      },
    });

    expect(capturedUrl).toBe("https://oidc.us-west-2.amazonaws.com/token");
    expect(capturedBody).toEqual({
      grantType: "refresh_token",
      clientId: "test-client-id",
      clientSecret: "test-client-secret",
      refreshToken: "test-kiro-refresh",
    });
    expect(fresh.access).toBe("test-oidc-access");
    expect(fresh.providerMetadata?.kiro?.region).toBe("eu-central-1");
    expect(fresh.providerMetadata?.kiro?.ssoRegion).toBe("us-west-2");
  });

  test("fails closed when OIDC registration is unavailable", async () => {
    const path = createKiroDatabase(new Date(Date.now() - 60_000).toISOString(), { authType: "oidc" });
    const credential = detectKiroCliCredential(path)!;

    await expect(refreshKiroCredential(credential, undefined, {
      databasePath: path,
      fetchFn: async () => { throw new Error("must not fetch"); },
    })).rejects.toThrow("Kiro OIDC registration is unavailable");
  });
});

describe("Kiro request-scoped auth resolution", () => {
  test("adds trusted runtime metadata only to the returned provider copy", async () => {
    const provider: FrogProviderConfig = {
      adapter: "kiro",
      baseUrl: "https://runtime.us-east-1.kiro.dev",
      authMode: "oauth",
    };

    const resolved = await resolveProviderAuth(undefined, "kiro", provider, {
      getOAuthAccessToken: async () => "unused",
      getOAuthCredential: async () => ({
        access: "request-access",
        refresh: "request-refresh",
        expires: Date.now() + 3_600_000,
        providerMetadata: {
          kiro: {
            source: "kiro-cli",
            authType: "social",
            region: "us-east-1",
            profileArn: "arn:aws:codewhisperer:us-east-1:000000000000:profile/test",
          },
        },
      }),
      getClaudeGrantAccessToken: async () => "unused",
      resolveEnvValue: value => value,
    });

    expect(resolved.apiKey).toBe("request-access");
    expect(resolved.runtimeAuth).toEqual({
      kind: "kiro",
      region: "us-east-1",
      profileArn: "arn:aws:codewhisperer:us-east-1:000000000000:profile/test",
    });
    expect(provider.apiKey).toBeUndefined();
    expect(provider.runtimeAuth).toBeUndefined();
  });
});

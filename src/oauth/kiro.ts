import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { Database } from "bun:sqlite";
import type { KiroOAuthMetadata, OAuthController, OAuthCredentials } from "./types";

const KIRO_TOKEN_KEYS = [
  { key: "kirocli:social:token", authType: "social" },
  { key: "kirocli:odic:token", authType: "oidc" },
  { key: "codewhisperer:odic:token", authType: "oidc" },
] as const;
const KIRO_REGISTRATION_KEYS = [
  "kirocli:odic:device-registration",
  "codewhisperer:odic:device-registration",
] as const;
const REGION_PATTERN = /^[a-z]+(?:-[a-z0-9]+)+-\d+$/;
const REFRESH_SKEW_MS = 60_000;
const REFRESH_TIMEOUT_MS = 30_000;

export interface KiroCliRunOptions {
  interactive: boolean;
  signal?: AbortSignal;
}

export type KiroCliRunner = (args: string[], options: KiroCliRunOptions) => Promise<number>;

export interface KiroCredentialImportOptions {
  databasePath?: string;
  runCli?: KiroCliRunner;
  fetchFn?: typeof fetch;
}

interface KiroRegistration {
  clientId: string;
  clientSecret: string;
  region?: string;
}

function defaultDatabasePaths(): string[] {
  const override = process.env.FROGPROGSY_KIRO_CLI_DB_FILE?.trim();
  if (override) return [override];
  if (process.platform === "darwin") {
    return [join(homedir(), "Library", "Application Support", "kiro-cli", "data.sqlite3")];
  }
  if (process.platform === "win32") {
    const appData = process.env.APPDATA?.trim() || join(homedir(), "AppData", "Roaming");
    return [join(appData, "kiro-cli", "data.sqlite3")];
  }
  return [join(homedir(), ".local", "share", "kiro-cli", "data.sqlite3")];
}

function candidateDatabasePaths(explicit?: string): string[] {
  return explicit ? [explicit] : defaultDatabasePaths();
}

function parseJsonObject(value: unknown): Record<string, unknown> | undefined {
  if (typeof value !== "string") return undefined;
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : undefined;
  } catch {
    return undefined;
  }
}

function stringField(value: Record<string, unknown> | undefined, key: string): string | undefined {
  const field = value?.[key];
  return typeof field === "string" && field.trim() ? field.trim() : undefined;
}

function regionFromProfileArn(profileArn: string | undefined): string | undefined {
  if (!profileArn) return undefined;
  const region = profileArn.split(":")[3];
  return region && REGION_PATTERN.test(region) ? region : undefined;
}

function parseExpiry(value: unknown): number {
  if (typeof value !== "string") return 0;
  const normalized = value.replace(/(\.\d{3})\d+(?=Z|[+-]\d\d:\d\d$)/, "$1");
  const millis = Date.parse(normalized);
  return Number.isFinite(millis) ? millis : 0;
}

function profileArnFromState(db: Database): string | undefined {
  try {
    const row = db.query("SELECT value FROM state WHERE key = 'api.codewhisperer.profile'").get() as { value?: unknown } | null;
    return stringField(parseJsonObject(row?.value), "arn");
  } catch {
    return undefined;
  }
}

function detectCredentialAtPath(databasePath: string): OAuthCredentials | null {
  if (!existsSync(databasePath)) return null;
  let db: Database | undefined;
  try {
    db = new Database(databasePath, { readonly: true, strict: true });
    for (const tokenKey of KIRO_TOKEN_KEYS) {
      const row = db.query("SELECT value FROM auth_kv WHERE key = ?1").get(tokenKey.key) as { value?: unknown } | null;
      const token = parseJsonObject(row?.value);
      if (!token) continue;

      const access = stringField(token, "access_token");
      const refresh = stringField(token, "refresh_token");
      const profileArn = stringField(token, "profile_arn") ?? profileArnFromState(db);
      const region = regionFromProfileArn(profileArn);
      const ssoRegion = stringField(token, "region");
      if (!access || !refresh || !profileArn || !region) return null;
      if (ssoRegion && !REGION_PATTERN.test(ssoRegion)) return null;

      const metadata: KiroOAuthMetadata = {
        source: "kiro-cli",
        authType: tokenKey.authType,
        region,
        ...(tokenKey.authType === "oidc" && ssoRegion ? { ssoRegion } : {}),
        profileArn,
      };
      return {
        access,
        refresh,
        expires: parseExpiry(token.expires_at),
        providerMetadata: { kiro: metadata },
      };
    }
    return null;
  } catch {
    return null;
  } finally {
    db?.close(false);
  }
}

/**
 * Import the current Kiro CLI session from its platform-native SQLite database. Every candidate is
 * opened read-only; FrogProgsy never refreshes, writes, or deletes the native Kiro store.
 */
export function detectKiroCliCredential(databasePath?: string): OAuthCredentials | null {
  for (const path of candidateDatabasePaths(databasePath)) {
    const credential = detectCredentialAtPath(path);
    if (credential) return credential;
  }
  return null;
}

function readKiroRegistration(databasePath?: string): KiroRegistration | null {
  for (const path of candidateDatabasePaths(databasePath)) {
    if (!existsSync(path)) continue;
    let db: Database | undefined;
    try {
      db = new Database(path, { readonly: true, strict: true });
      for (const key of KIRO_REGISTRATION_KEYS) {
        const row = db.query("SELECT value FROM auth_kv WHERE key = ?1").get(key) as { value?: unknown } | null;
        const registration = parseJsonObject(row?.value);
        const clientId = stringField(registration, "client_id");
        const clientSecret = stringField(registration, "client_secret");
        const region = stringField(registration, "region");
        if (!clientId || !clientSecret) continue;
        if (region && !REGION_PATTERN.test(region)) return null;
        return { clientId, clientSecret, ...(region ? { region } : {}) };
      }
    } catch {
      // Try no other schema at this path. The native database remains untouched.
    } finally {
      db?.close(false);
    }
  }
  return null;
}

const defaultRunKiroCli: KiroCliRunner = async (args, options) => {
  try {
    const child = Bun.spawn(["kiro-cli", ...args], {
      stdin: options.interactive ? "inherit" : "ignore",
      stdout: options.interactive ? "inherit" : "ignore",
      stderr: options.interactive ? "inherit" : "ignore",
    });
    const abort = () => child.kill();
    if (options.signal?.aborted) abort();
    options.signal?.addEventListener("abort", abort, { once: true });
    try {
      return await child.exited;
    } finally {
      options.signal?.removeEventListener("abort", abort);
    }
  } catch {
    return -1;
  }
};

/**
 * Kiro owns the interactive browser/device flow. FrogProgsy invokes the official CLI, then copies
 * the resulting access/refresh session into its own mode-restricted credential store.
 */
export async function loginKiro(
  ctrl: OAuthController,
  options: KiroCredentialImportOptions = {},
): Promise<OAuthCredentials> {
  const current = detectKiroCliCredential(options.databasePath);
  if (current && current.expires > Date.now() + REFRESH_SKEW_MS) {
    ctrl.onProgress?.("Imported the active Kiro CLI session");
    return current;
  }

  ctrl.onProgress?.("Starting the official Kiro CLI login flow");
  const runCli = options.runCli ?? defaultRunKiroCli;
  const code = await runCli(["login"], { interactive: true, signal: ctrl.signal });
  if (ctrl.signal?.aborted) throw new Error("Kiro login was cancelled");
  if (code === -1) {
    throw new Error("Kiro CLI is not installed or is not available on PATH. Install it from https://kiro.dev/cli/ and retry.");
  }
  if (code !== 0) {
    throw new Error("Kiro CLI login did not complete. Check `kiro-cli whoami`, then retry `frogp login kiro`.");
  }

  const credential = detectKiroCliCredential(options.databasePath);
  if (!credential || credential.expires <= Date.now() + REFRESH_SKEW_MS) {
    throw new Error("Kiro CLI did not expose a current runtime session. Check `kiro-cli whoami`, then retry.");
  }
  return credential;
}

function expiresInMillis(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value * 1000 : 3_600_000;
}

async function responseObject(response: Response): Promise<Record<string, unknown> | null> {
  try {
    const value = await response.json();
    return value && typeof value === "object" && !Array.isArray(value)
      ? value as Record<string, unknown>
      : null;
  } catch {
    return null;
  }
}

/**
 * Refresh FrogProgsy's copied Kiro credential without modifying the native CLI database. Social
 * sessions use Kiro Desktop refresh; OIDC sessions use the source-verified AWS CreateToken contract
 * and read the native device registration only for that refresh. There is no cross-auth fallback.
 */
export async function refreshKiroCredential(
  credential: OAuthCredentials,
  signal?: AbortSignal,
  options: KiroCredentialImportOptions = {},
): Promise<OAuthCredentials> {
  const native = detectKiroCliCredential(options.databasePath);
  if (native && native.expires > Date.now() + REFRESH_SKEW_MS && native.expires > credential.expires) {
    return native;
  }

  const metadata = credential.providerMetadata?.kiro;
  if (!metadata || !REGION_PATTERN.test(metadata.region) || !credential.refresh) {
    throw new Error("Kiro session refresh failed. Run `frogp login kiro` again.");
  }

  const fetchFn = options.fetchFn ?? fetch;
  let url: string;
  let body: Record<string, unknown>;
  if (metadata.authType === "social") {
    url = `https://prod.${metadata.region}.auth.desktop.kiro.dev/refreshToken`;
    body = { refreshToken: credential.refresh };
  } else {
    const registration = readKiroRegistration(options.databasePath);
    const ssoRegion = metadata.ssoRegion ?? registration?.region;
    if (!registration || !ssoRegion || !REGION_PATTERN.test(ssoRegion)) {
      throw new Error("Kiro OIDC registration is unavailable. Run `kiro-cli login`, then `frogp login kiro` again.");
    }
    url = `https://oidc.${ssoRegion}.amazonaws.com/token`;
    body = {
      grantType: "refresh_token",
      clientId: registration.clientId,
      clientSecret: registration.clientSecret,
      refreshToken: credential.refresh,
    };
  }

  let response: Response;
  try {
    response = await fetchFn(url, {
      method: "POST",
      headers: { "Content-Type": "application/json", "User-Agent": "frogprogsy" },
      body: JSON.stringify(body),
      signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(REFRESH_TIMEOUT_MS)]) : AbortSignal.timeout(REFRESH_TIMEOUT_MS),
    });
  } catch {
    throw new Error("Kiro session refresh failed. Run `frogp login kiro` again.");
  }
  if (!response.ok) {
    throw new Error(`Kiro session refresh failed (HTTP ${response.status}). Run \`frogp login kiro\` again.`);
  }

  const result = await responseObject(response);
  const access = stringField(result ?? undefined, "accessToken");
  const refresh = stringField(result ?? undefined, "refreshToken") ?? credential.refresh;
  if (!access) throw new Error("Kiro session refresh returned an invalid response. Run `frogp login kiro` again.");

  let nextMetadata = metadata;
  if (metadata.authType === "social") {
    const profileArn = stringField(result ?? undefined, "profileArn") ?? metadata.profileArn;
    const region = regionFromProfileArn(profileArn);
    if (!region) throw new Error("Kiro session refresh returned invalid profile metadata. Run `frogp login kiro` again.");
    nextMetadata = { ...metadata, profileArn, region };
  }
  return {
    ...credential,
    access,
    refresh,
    expires: Date.now() + expiresInMillis(result?.expiresIn),
    providerMetadata: { ...credential.providerMetadata, kiro: nextMetadata },
  };
}

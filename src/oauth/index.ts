import type { OAuthController, OAuthCredentials } from "./types";
import type { FrogConfig, FrogProviderConfig } from "../types";
import { loadConfig, saveConfig } from "../config";
import { getCredential, saveCredential } from "./store";
import { loginXai, refreshXaiToken } from "./xai";
import { ANTHROPIC_OAUTH_BETA } from "./anthropic";
import { loginKimi, refreshKimiToken } from "./kimi";
import { loginCodex, refreshCodexToken, isCodexBackendBaseUrl, codexBackendHeaders } from "./codex";
import { loginKiro, refreshKiroCredential } from "./kiro";
import { deriveOAuthDefaultModel } from "../providers/derive";
import { providerUserSeedFromRegistry } from "../providers/registry";

const REFRESH_SKEW_MS = 60_000;

export type OAuthLoginMode = "browser" | "cli";

interface OAuthProviderDef {
  login(ctrl: OAuthController): Promise<OAuthCredentials>;
  refresh(credential: OAuthCredentials, signal?: AbortSignal): Promise<OAuthCredentials>;
  loginMode: OAuthLoginMode;
  /** provider entry written into config.json on first login. */
  providerConfig: FrogProviderConfig;
  defaultModel: string;
}

function oauthConfig(id: string): FrogProviderConfig {
  const config = providerUserSeedFromRegistry(id);
  if (config.authMode !== "oauth") throw new Error(`OAuth provider missing from registry: ${id}`);
  return config;
}

function oauthDefaultModel(id: string): string {
  const model = deriveOAuthDefaultModel(id);
  if (!model) throw new Error(`OAuth provider missing default model in registry: ${id}`);
  return model;
}

export const OAUTH_PROVIDERS: Record<string, OAuthProviderDef> = {
  codex: {
    login: (ctrl) => loginCodex(ctrl),
    refresh: (credential, signal) => refreshCodexToken(credential.refresh, signal),
    loginMode: "browser",
    providerConfig: oauthConfig("codex"),
    defaultModel: oauthDefaultModel("codex"),
  },
  xai: {
    login: (ctrl) => loginXai(ctrl, { importLocal: "fallback" }),
    refresh: (credential, signal) => refreshXaiToken(credential.refresh, signal),
    loginMode: "browser",
    providerConfig: oauthConfig("xai"),
    defaultModel: oauthDefaultModel("xai"),
  },
  kimi: {
    login: (ctrl) => loginKimi(ctrl),
    refresh: (credential) => refreshKimiToken(credential.refresh),
    loginMode: "browser",
    providerConfig: oauthConfig("kimi"),
    defaultModel: oauthDefaultModel("kimi"),
  },
  kiro: {
    login: loginKiro,
    refresh: refreshKiroCredential,
    loginMode: "cli",
    providerConfig: oauthConfig("kiro"),
    defaultModel: oauthDefaultModel("kiro"),
  },
};

export function isOAuthProvider(name: string): boolean {
  return name in OAUTH_PROVIDERS;
}

/** Provider ids managed by the account status/logout surfaces. */
export function listOAuthProviders(): string[] {
  return Object.keys(OAUTH_PROVIDERS);
}

export function oauthProviderLoginModes(): Record<string, OAuthLoginMode> {
  return Object.fromEntries(Object.entries(OAUTH_PROVIDERS).map(([id, provider]) => [id, provider.loginMode]));
}

export async function refreshOAuthCredential(
  provider: string,
  credential: OAuthCredentials,
): Promise<OAuthCredentials> {
  const def = OAUTH_PROVIDERS[provider];
  if (!def) throw new Error(`Unknown OAuth provider: ${provider}`);
  return def.refresh(credential);
}

/** Return the current complete credential, refreshing and persisting it when needed. */
export async function getValidOAuthCredential(provider: string): Promise<OAuthCredentials> {
  const def = OAUTH_PROVIDERS[provider];
  if (!def) throw new Error(`Unknown OAuth provider: ${provider}`);
  const credential = getCredential(provider);
  if (!credential) throw new Error(`Not logged in to ${provider}. Run: frogp login ${provider}`);
  if (credential.expires > Date.now() + REFRESH_SKEW_MS) return credential;
  const fresh = await refreshOAuthCredential(provider, credential);
  saveCredential(provider, fresh);
  return fresh;
}

/** Return a valid access token. Throws if the provider is not logged in. */
export async function getValidAccessToken(provider: string): Promise<string> {
  return (await getValidOAuthCredential(provider)).access;
}

/**
 * Provider-correct `GET /models` request (URL + headers), so both model-listing paths fetch the
 * LIVE catalog correctly per adapter. Anthropic is the special case: its endpoint is `/v1/models`
 * (not `/models`), it needs `anthropic-version`, and it authenticates with `x-api-key` (key) or
 * `Authorization: Bearer` + the OAuth beta (oauth / claude-grant — both resolve a Claude subscription
 * Bearer token) — not a bare Bearer. Everyone else uses the OpenAI-style `/models` + Bearer. Response
 * shape is `{ data: [{ id, owned_by? }] }` for both.
 */
export function buildModelsRequest(prov: FrogProviderConfig, apiKey: string | undefined): { url: string; headers: Record<string, string> } {
  const headers: Record<string, string> = { ...(prov.headers ?? {}) };
  if (isCodexBackendBaseUrl(prov.baseUrl)) {
    if (apiKey) {
      headers["Authorization"] = `Bearer ${apiKey}`;
      Object.assign(headers, codexBackendHeaders(apiKey));
    }
    return { url: `${prov.baseUrl.replace(/\/$/, "")}/models?client_version=1.0.0`, headers };
  }
  if (prov.adapter === "anthropic") {
    headers["anthropic-version"] = "2023-06-01";
    if (prov.authMode === "oauth" || prov.authMode === "claude-grant") {
      headers["anthropic-beta"] = ANTHROPIC_OAUTH_BETA;
      if (apiKey) headers["Authorization"] = `Bearer ${apiKey}`;
    } else if (apiKey) {
      headers["x-api-key"] = apiKey;
    }
    return { url: `${prov.baseUrl}/v1/models?limit=1000`, headers };
  }
  if (apiKey) headers["Authorization"] = `Bearer ${apiKey}`;
  return { url: `${prov.baseUrl}/models`, headers };
}


function hasStoredCredential(provider: string): boolean {
  return !!getCredential(provider);
}

export function restoreCredentialedOAuthProviderConfigs(
  config: FrogConfig,
  hasCredential: (provider: string) => boolean = hasStoredCredential,
): boolean {
  let changed = false;
  for (const [name, def] of Object.entries(OAUTH_PROVIDERS)) {
    if (config.providers[name]) continue;
    if (!hasCredential(name)) continue;
    config.providers[name] = { ...def.providerConfig };
    changed = true;
  }
  return changed;
}


/** Add/refresh an OAuth provider's config entry on a config object (does not persist). */
export function upsertOAuthProvider(config: FrogConfig, provider: string): boolean {
  const def = OAUTH_PROVIDERS[provider];
  if (!def) return false;
  const current = config.providers[provider];
  const next = current ? {
    ...def.providerConfig,
    ...current,
    adapter: def.providerConfig.adapter,
    baseUrl: def.providerConfig.baseUrl,
    authMode: def.providerConfig.authMode,
    catalogProviderId: def.providerConfig.catalogProviderId,
    defaultModel: current.defaultModel ?? def.providerConfig.defaultModel,
  } : { ...def.providerConfig };
  const changed = JSON.stringify(current) !== JSON.stringify(next);
  config.providers[provider] = next;
  return changed;
}

/**
 * List OAuth-managed provider rows that currently lack stored credentials.
 * Missing credentials should make the route report "not logged in"; they must not
 * erase provider/default settings on start, status polling, or logout.
 */
export function loggedOutOAuthProviders(
  config: FrogConfig,
  hasCredential: (provider: string) => boolean = provider => !!getCredential(provider),
): string[] {
  return Object.entries(config.providers)
    .filter(([provider, prov]) => prov.authMode === "oauth" && !!OAUTH_PROVIDERS[provider] && !hasCredential(provider))
    .map(([provider]) => provider);
}

/** Run the login flow, persist the credential + upsert the provider entry to disk, return cred. */
export async function runLogin(provider: string, ctrl: OAuthController): Promise<OAuthCredentials> {
  const def = OAUTH_PROVIDERS[provider];
  if (!def) throw new Error(`Unknown OAuth provider: ${provider}`);
  const cred = await def.login(ctrl);
  saveCredential(provider, cred);
  const config = loadConfig();
  upsertOAuthProvider(config, provider);
  saveConfig(config);
  return cred;
}

/**
 * GUI async login: start the flow, return the auth URL EARLY (the flow keeps running in the
 * background until the callback server captures the redirect), with a concurrency guard and an
 * error surfaced via getLoginStatus().
 */
type LoginAuthInfo = { url: string; instructions?: string; code?: string };
interface LoginFlowState {
  attemptId: string;
  startedAt: number;
  controller: AbortController;
  error?: string;
  done: boolean;
  auth?: LoginAuthInfo;
  authPromise: Promise<LoginAuthInfo>;
}
const LOGIN_FLOW_STALE_MS = 5 * 60 * 1000;
const loginState = new Map<string, LoginFlowState>();

export function getLoginStatus(provider: string): { loggedIn: boolean; email?: string; error?: string } {
  const cred = getCredential(provider);
  const st = loginState.get(provider);
  return { loggedIn: !!cred, email: cred?.email, error: st?.error };
}

export function clearLoginState(provider: string): void {
  const state = loginState.get(provider);
  if (state && !state.done) state.controller.abort("login_state_cleared");
  loginState.delete(provider);
}

export async function startLoginFlow(
  provider: string,
  opts: { onComplete?: () => void | Promise<void>; restart?: boolean; now?: () => number } = {},
): Promise<LoginAuthInfo> {
  const def = OAUTH_PROVIDERS[provider];
  if (!def) throw new Error(`Unknown OAuth provider: ${provider}`);
  if (def.loginMode === "cli") {
    throw new Error(`Provider ${provider} requires terminal login. Run: frogp login ${provider}`);
  }

  const now = opts.now ?? Date.now;
  const existing = loginState.get(provider);
  if (existing && !existing.done) {
    const stale = now() - existing.startedAt >= LOGIN_FLOW_STALE_MS;
    if (!opts.restart && !stale) {
      if (existing.auth) return existing.auth;
      return existing.authPromise;
    }
    existing.controller.abort(opts.restart ? "login_restarted" : "login_timed_out");
    loginState.delete(provider);
  }

  let resolveAuth!: (info: LoginAuthInfo) => void;
  let rejectAuth!: (err: unknown) => void;
  const authPromise = new Promise<LoginAuthInfo>((resolve, reject) => {
    resolveAuth = resolve;
    rejectAuth = reject;
  });
  const controller = new AbortController();
  const state: LoginFlowState = {
    attemptId: crypto.randomUUID(),
    startedAt: now(),
    controller,
    done: false,
    authPromise,
  };
  loginState.set(provider, state);

  let urlResolved = false;
  const ctrl: OAuthController = {
    onAuth: ({ url, instructions, code }) => {
      if (loginState.get(provider)?.attemptId !== state.attemptId) return;
      urlResolved = true;
      const auth = { url, instructions, ...(code ? { code } : {}) };
      state.auth = auth;
      resolveAuth(auth);
    },
    onProgress: () => {},
    signal: controller.signal,
  };

  // Background: runLogin persists the credential + upserts the provider entry to disk config.
  runLogin(provider, ctrl)
    .then(async () => {
      if (loginState.get(provider)?.attemptId !== state.attemptId) return;
      await opts.onComplete?.();
      state.done = true;
      // Local-token import for providers that support it completes WITHOUT firing onAuth —
      // resolve so the GUI call returns instead of hanging.
      if (!urlResolved) resolveAuth({ url: "", instructions: "Logged in via an existing local CLI token — no browser needed." });
    })
    .catch((e: unknown) => {
      if (!urlResolved) rejectAuth(e);
      if (loginState.get(provider)?.attemptId !== state.attemptId) return;
      const msg = e instanceof Error ? e.message : String(e);
      // Raw provider error bodies stay on stderr only; management responses get an enum code.
      console.error(`[oauth] ${provider} login failed: ${msg}`);
      state.done = true;
      state.error = "oauth_login_failed";
    });
  return authPromise;
}

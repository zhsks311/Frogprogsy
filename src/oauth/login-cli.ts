import * as readline from "node:readline";
import { openUrl } from "../open-url";
import { loadConfig, readPid, saveConfig } from "../config";
import { OAUTH_PROVIDERS, runLogin } from "./index";
import { KEY_LOGIN_PROVIDERS, isKeyLoginProvider, validateApiKey, type KeyLoginProvider } from "./key-providers";
import { suggestClosest } from "../cli-suggest";
import { sameMachineAccessHeaders } from "../local-access";
import type { FrogProviderConfig } from "../types";
import { providerUserSeedFromRegistry } from "../providers/registry";
import { removeCredential } from "./store";

/** Push the new provider into a running proxy's live config so it routes without a restart. */
async function notifyRunningProxy(name: string, provider: unknown): Promise<void> {
  if (!readPid()) return;
  const cfg = loadConfig();
  try {
    const res = await fetch(`http://localhost:${cfg.port}/api/providers`, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...sameMachineAccessHeaders() },
      body: JSON.stringify({ name, provider }),
    });
    if (!res.ok) {
      console.error(`⚠️  The running proxy rejected the live update (HTTP ${res.status}). Restart it to route ${name}: frogp refresh`);
    }
  } catch {
    /* proxy unreachable; disk config loads on next start */
  }
}

/** Remove FrogProgsy's stored account copy and refresh a running proxy's readiness-filtered catalog. */
export async function logoutProvider(name: string): Promise<void> {
  if (readPid()) {
    const cfg = loadConfig();
    try {
      const res = await fetch(`http://localhost:${cfg.port}/api/oauth/logout?provider=${encodeURIComponent(name)}`, {
        method: "POST",
        headers: sameMachineAccessHeaders(),
      });
      if (res.ok) return;
    } catch {
      // The credential store remains authoritative when the recorded process is unreachable.
    }
  }
  removeCredential(name);
}
const KEY_LOGIN_ALIASES: Record<string, string> = {
  // Users type "frogp login openai" naturally. Keep that as API-key OpenAI;
  // ChatGPT/Codex account login is explicit as "frogp login codex".
  openai: "openai-apikey",
};

export function resolveKeyLoginRequest(name: string): { lookupName: string; saveName: string; alias: boolean } | null {
  if (isKeyLoginProvider(name)) return { lookupName: name, saveName: name, alias: false };
  const lookupName = KEY_LOGIN_ALIASES[name];
  if (lookupName && isKeyLoginProvider(lookupName)) return { lookupName, saveName: name, alias: true };
  return null;
}

export function loginProviderGroups(): { oauth: string[]; key: string[]; suggestions: string[]; openaiAlias: string } {
  const oauth = Object.keys(OAUTH_PROVIDERS);
  const key = Object.keys(KEY_LOGIN_PROVIDERS);
  return {
    oauth,
    key,
    suggestions: [...oauth, ...key, "openai"],
    openaiAlias: "openai is an alias for openai-apikey.",
  };
}

export function formatLoginProviderGroups(): string {
  const groups = loginProviderGroups();
  return (
    `  Account login: ${groups.oauth.join(", ")}\n` +
    `  API-key login: ${groups.key.join(", ")}\n` +
    `  Alias:         ${groups.openaiAlias}`
  );
}

export function formatLoginUsage(): string {
  return `Usage: frogp login [--list|<provider>]\n${formatLoginProviderGroups()}`;
}

export function formatLoginFailure(provider: string, err: unknown): string {
  const message = err instanceof Error ? err.message : String(err);
  return `Login failed for ${provider}: ${message}\nTry again: frogp login ${provider}`;
}

export async function handleLogin(provider?: string): Promise<void> {
  const name = (provider ?? "").trim().toLowerCase();
  if (name === "--list") {
    console.log(formatLoginProviderGroups());
    return;
  }
  if (name === "anthropic") {
    console.error("Anthropic Claude subscription OAuth login is not supported. Use `claude login` and `frogp claude` homes for Claude Code pass-through, or add an Anthropic Console API key as a custom provider.");
    process.exit(1);
  }
  if (!name) {
    console.error(formatLoginUsage());
    process.exit(1);
  }
  if (OAUTH_PROVIDERS[name]) return handleOAuthLogin(name);
  const keyLogin = resolveKeyLoginRequest(name);
  if (keyLogin) return handleKeyLogin(keyLogin);
  const suggestion = suggestClosest(name, loginProviderGroups().suggestions);
  console.error(formatLoginUsage() + (suggestion ? `\nDid you mean: frogp login ${suggestion}?` : ""));
  process.exit(1);
}

async function handleOAuthLogin(name: string): Promise<void> {
  const browserOwned = OAUTH_PROVIDERS[name]?.loginMode === "browser";
  const rl = browserOwned ? readline.createInterface({ input: process.stdin, output: process.stdout }) : undefined;
  let loginError: unknown;
  try {
    await runLogin(name, {
      onAuth: ({ url, instructions }) => {
        console.log(`\n🔐 Opening browser for ${name} login...\n${url}\n`);
        if (instructions) console.log(instructions);
        openUrl(url);
      },
      onProgress: (m) => console.log(`   ${m}`),
      ...(rl ? {
        onManualCodeInput: () =>
          new Promise<string>((res) => rl.question("Paste redirect URL or code (or wait for browser): ", res)),
      } : {}),
    });
  } catch (err) {
    loginError = err;
  } finally {
    rl?.close();
  }
  if (loginError) {
    console.error(formatLoginFailure(name, loginError));
    process.exit(1);
  }
  const savedProvider = loadConfig().providers[name] ?? OAUTH_PROVIDERS[name].providerConfig;
  await notifyRunningProxy(name, savedProvider);
  console.log(`\n✅ Logged in to ${name}. Try: frogp refresh`);
}

export function providerConfigFromKeyLoginProvider(
  catalogProviderId: string,
  key: string,
  current?: FrogProviderConfig,
): FrogProviderConfig {
  const seed = providerUserSeedFromRegistry(catalogProviderId);
  if (seed.authMode !== "key") {
    throw new Error(`Registry provider does not use API-key login: ${catalogProviderId}`);
  }
  return current ? {
    ...seed,
    ...current,
    adapter: seed.adapter,
    baseUrl: seed.baseUrl,
    authMode: seed.authMode,
    catalogProviderId: seed.catalogProviderId,
    defaultModel: current.defaultModel ?? seed.defaultModel,
    apiKey: key,
  } : { ...seed, apiKey: key };
}

async function handleKeyLogin(request: { lookupName: string; saveName: string; alias: boolean }): Promise<void> {
  const def = KEY_LOGIN_PROVIDERS[request.lookupName];
  console.log(`\n🔑 ${def.label} — opening ${def.dashboardUrl} so you can create/copy an API key...`);
  openUrl(def.dashboardUrl);
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  const key = (await new Promise<string>((res) => rl.question(`Paste your ${def.label} API key: `, res))).trim();
  rl.close();
  if (!key) {
    console.error("No key entered.");
    process.exit(1);
  }
  process.stdout.write("   validating… ");
  const valid = await validateApiKey(def, key);
  console.log(valid === true ? "valid ✅" : valid === false ? "INVALID ❌" : "couldn't validate (may still work)");
  if (valid === false) {
    console.error("Provider rejected the key. Not saved.");
    process.exit(1);
  }
  const config = loadConfig();
  const provider = providerConfigFromKeyLoginProvider(request.lookupName, key, config.providers[request.saveName]);
  config.providers[request.saveName] = provider;
  if (request.alias && (config.defaultProvider === request.saveName || !config.providers[config.defaultProvider])) {
    config.defaultProvider = request.saveName;
  }
  saveConfig(config);
  await notifyRunningProxy(request.saveName, provider);
  const aliasNote = request.alias ? ` (${request.lookupName})` : "";
  console.log(`✅ ${def.label}${aliasNote} added as "${request.saveName}". Try: frogp refresh`);
}

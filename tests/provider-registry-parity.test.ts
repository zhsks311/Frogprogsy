import { describe, expect, test } from "bun:test";
import { buildCatalogEntries } from "../src/claude-catalog";
import { getJawcodeModelMetadata, resolveJawcodeProvider } from "../src/generated/jawcode-model-metadata";
import { buildInitProviders } from "../src/init";
import { OAUTH_PROVIDERS, loggedOutOAuthProviders, restoreCredentialedOAuthProviderConfigs, upsertOAuthProvider } from "../src/oauth";
import { KEY_LOGIN_PROVIDERS } from "../src/oauth/key-providers";
import {
  deriveFeaturedProviderIds,
  deriveInitProviders,
  deriveJawcodeAliases,
  deriveKeyLoginMap,
  deriveProviderPresets,
} from "../src/providers/derive";
import { PROVIDER_REGISTRY, providerUserSeedFromRegistry } from "../src/providers/registry";
import { configuredReasoningEfforts, mapReasoningEffort } from "../src/reasoning-effort";
import type { FrogConfig } from "../src/types";
import { resolveAdapter } from "../src/server";

function nativeTemplate(): Record<string, unknown> {
  return {
    slug: "gpt-5.5",
    display_name: "gpt-5.5",
    priority: 1,
    visibility: "list",
    supports_websockets: true,
  };
}

const EXPECTED_KEY_PROVIDER_IDS = [
  "anthropic", "openai-apikey", "umans", "opencode-go", "neuralwatt", "openrouter", "groq", "google", "azure-openai",
  "deepseek", "cerebras", "together", "fireworks", "firepass", "moonshot",
  "huggingface", "nvidia", "venice", "zai", "nanogpt", "synthetic", "qwen-portal",
  "qianfan", "alibaba", "parallel", "zenmux", "litellm", "ollama-cloud", "mistral",
  "minimax", "minimax-cn", "kimi-code", "opencode-zen", "vercel-ai-gateway",
  "xiaomi", "kilo", "cloudflare-ai-gateway", "github-copilot", "gitlab-duo",
];

describe("provider registry parity", () => {
  test("registry ids are unique", () => {
    const ids = PROVIDER_REGISTRY.map(entry => entry.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  test("key-login export is derived from the registry", () => {
    expect(KEY_LOGIN_PROVIDERS).toEqual(deriveKeyLoginMap());
    expect(Object.keys(KEY_LOGIN_PROVIDERS)).toEqual(EXPECTED_KEY_PROVIDER_IDS);
    expect(Object.keys(deriveKeyLoginMap())).toEqual(EXPECTED_KEY_PROVIDER_IDS);
    expect(KEY_LOGIN_PROVIDERS.minimax.defaultModel).toBe("MiniMax-M2.5");
    expect(KEY_LOGIN_PROVIDERS.umans).toMatchObject({
      label: "Umans AI Coding Plan",
      adapter: "anthropic",
      baseUrl: "https://api.code.umans.ai",
      defaultModel: "umans-coder",
      escapeBuiltinToolNames: true,
    });
    expect(KEY_LOGIN_PROVIDERS.umans.modelCapabilities?.["umans-glm-5.2"]?.input).toEqual(["text"]);
    expect(KEY_LOGIN_PROVIDERS.umans.modelContextWindows?.["umans-coder"]).toBe(262_144);
    expect(KEY_LOGIN_PROVIDERS.umans.modelContextWindows?.["umans-glm-5.2"]).toBe(405_504);
    expect(KEY_LOGIN_PROVIDERS.umans.modelCapabilities?.["umans-coder"]?.input).toEqual(["text", "image"]);
    expect(KEY_LOGIN_PROVIDERS.umans.modelCapabilities?.["umans-glm-5.2"]?.input).toEqual(["text"]);
  });

  test("curated provider fallbacks match current provider catalogs", () => {
    const xai = PROVIDER_REGISTRY.find(entry => entry.id === "xai");
    expect(xai).toMatchObject({
      defaultModel: "grok-4.5",
      modelContextWindows: { "grok-4.5": 500_000 },
    });
    expect(xai?.models).toContain("grok-4.5");

    expect(KEY_LOGIN_PROVIDERS.anthropic).toMatchObject({
      defaultModel: "claude-sonnet-5",
      models: [
        "claude-fable-5",
        "claude-opus-5",
        "claude-sonnet-5",
        "claude-opus-4-8",
        "claude-opus-4-7",
        "claude-opus-4-6",
        "claude-sonnet-4-6",
        "claude-sonnet-4-5",
        "claude-opus-4-5",
        "claude-haiku-4-5",
      ],
    });
    expect(KEY_LOGIN_PROVIDERS.anthropic.modelCapabilities?.["claude-opus-5"]?.input).toEqual(["text", "image"]);

    const moonshot = KEY_LOGIN_PROVIDERS.moonshot;
    expect(moonshot.models).toEqual([
      "kimi-k3",
      "kimi-k2.7-code",
      "kimi-k2.7-code-highspeed",
      "kimi-k2.6",
      "kimi-k2.5",
      "kimi-k2-0905-preview",
    ]);
    expect(moonshot.modelContextWindows?.["kimi-k3"]).toBe(1_000_000);
    expect(moonshot.modelReasoningEfforts?.["kimi-k3"]).toEqual(["low", "high", "xhigh"]);
    expect(configuredReasoningEfforts(moonshot, "kimi-k3")).toEqual(["low", "high", "xhigh"]);
    expect(mapReasoningEffort(moonshot, "kimi-k3", "xhigh")).toBe("max");
    expect(moonshot.noTemperatureModels).toContain("kimi-k3");
    expect(moonshot.noTopPModels).toContain("kimi-k3");
    expect(moonshot.noPenaltyModels).toContain("kimi-k3");

    expect(KEY_LOGIN_PROVIDERS.umans.models).toEqual([
      "umans-kimi-k3",
      "umans-coder",
      "umans-kimi-k2.7",
      "umans-glm-5.2",
      "umans-deepseek-v4-flash-0731",
      "umans-flash",
    ]);
    expect(KEY_LOGIN_PROVIDERS.umans.modelContextWindows?.["umans-kimi-k3"]).toBe(1_000_000);
    expect(KEY_LOGIN_PROVIDERS.umans.modelContextWindows?.["umans-deepseek-v4-flash-0731"]).toBe(1_000_000);
    expect(KEY_LOGIN_PROVIDERS.umans.modelCapabilities?.["umans-kimi-k3"]?.input).toEqual(["text", "image"]);
    expect(KEY_LOGIN_PROVIDERS.umans.modelCapabilities?.["umans-deepseek-v4-flash-0731"]?.input).toEqual(["text"]);
    expect(KEY_LOGIN_PROVIDERS.umans.modelReasoningEfforts?.["umans-kimi-k3"]).toEqual(["low", "high", "xhigh"]);
    expect(KEY_LOGIN_PROVIDERS.umans.modelReasoningEfforts?.["umans-deepseek-v4-flash-0731"]).toEqual(["low", "high", "xhigh"]);

    expect(KEY_LOGIN_PROVIDERS.deepseek).toMatchObject({
      defaultModel: "deepseek-v4-pro",
      models: ["deepseek-v4-flash", "deepseek-v4-pro"],
      modelContextWindows: {
        "deepseek-v4-flash": 1_000_000,
        "deepseek-v4-pro": 1_000_000,
      },
    });

    expect(KEY_LOGIN_PROVIDERS.neuralwatt.models).toEqual([
      "deepseek-v4-flash",
      "glm-5.2",
      "glm-5.2-fast",
      "glm-5.2-short",
      "glm-5.2-short-fast",
      "gemma-4-31b",
      "kimi-k2.7-code",
      "kimi-k2.7-code-fast",
      "kimi-k3",
      "kimi-k3-fast",
      "qwen3.6-35b",
      "qwen3.6-35b-fast",
    ]);
    expect(KEY_LOGIN_PROVIDERS.neuralwatt.modelContextWindows?.["kimi-k3"]).toBe(1_048_560);
    expect(KEY_LOGIN_PROVIDERS.neuralwatt.modelCapabilities?.["gemma-4-31b"]?.input).toEqual(["text", "image"]);
    expect(KEY_LOGIN_PROVIDERS.neuralwatt.modelCapabilities?.["deepseek-v4-flash"]?.input).toEqual(["text"]);
    expect(KEY_LOGIN_PROVIDERS.neuralwatt.modelReasoningEfforts?.["gemma-4-31b"]).toEqual(["xhigh"]);
    expect(KEY_LOGIN_PROVIDERS.neuralwatt.modelReasoningEfforts?.["deepseek-v4-flash"]).toEqual(["high", "xhigh"]);
    expect(KEY_LOGIN_PROVIDERS.neuralwatt.modelReasoningEfforts?.["kimi-k3"]).toEqual(["low", "high", "xhigh"]);
    expect(KEY_LOGIN_PROVIDERS.neuralwatt.modelReasoningEfforts?.["kimi-k3-fast"]).toEqual([]);
    expect(mapReasoningEffort(KEY_LOGIN_PROVIDERS.neuralwatt, "gemma-4-31b", "xhigh")).toBe("max");
    expect(mapReasoningEffort(KEY_LOGIN_PROVIDERS.neuralwatt, "deepseek-v4-flash", "xhigh")).toBe("max");
    expect(mapReasoningEffort(KEY_LOGIN_PROVIDERS.neuralwatt, "kimi-k3", "xhigh")).toBe("max");

    expect(KEY_LOGIN_PROVIDERS.zai.models).toContain("glm-4.7");
    expect(KEY_LOGIN_PROVIDERS.zai.modelContextWindows?.["glm-5.2[1m]"]).toBe(1_000_000);
  });

  test("CLI init providers are derived from the registry", () => {
    expect(buildInitProviders()).toEqual(deriveInitProviders());
    expect(buildInitProviders().find(p => p.id === "azure-openai")?.adapter).toBe("azure-openai");
  });

  test("OAuth provider configs persist only registry identity, auth, and selected default", () => {
    const codex = OAUTH_PROVIDERS.codex.providerConfig;

    expect(codex).toEqual({
      adapter: "openai-responses",
      baseUrl: "https://chatgpt.com/backend-api/codex",
      authMode: "oauth",
      catalogProviderId: "codex",
      defaultModel: "gpt-5.5",
    });
    expect(OAUTH_PROVIDERS.kimi.providerConfig.catalogProviderId).toBe("kimi");
    expect(OAUTH_PROVIDERS.anthropic).toBeUndefined();
    expect(OAUTH_PROVIDERS.xai.providerConfig.defaultModel).toBe("grok-4.5");
    expect(OAUTH_PROVIDERS.xai.providerConfig.models).toBeUndefined();
    expect(OAUTH_PROVIDERS.xai.providerConfig.modelCapabilities).toBeUndefined();
  });

  test("logged-out OAuth providers are reported without deleting provider settings", () => {
    const config: FrogConfig = {
      port: 10100,
      defaultProvider: "xai",
      providers: {
        xai: { adapter: "openai-chat", baseUrl: "https://api.x.ai/v1", authMode: "oauth" },
        codex: { adapter: "openai-responses", baseUrl: "https://chatgpt.com/backend-api/codex", authMode: "oauth" },
        local: { adapter: "openai-chat", baseUrl: "http://127.0.0.1:11434/v1" },
      },
    };

    const loggedOut = loggedOutOAuthProviders(config, provider => provider === "codex");

    expect(loggedOut).toEqual(["xai"]);
    expect(config.providers.xai).toBeDefined();
    expect(config.providers.codex).toBeDefined();
    expect(config.providers.local).toBeDefined();
    expect(config.defaultProvider).toBe("xai");
  });

  test("stored OAuth credentials restore a missing provider with a user-owned seed", () => {
    const config: FrogConfig = {
      port: 10100,
      defaultProvider: "codex",
      providers: {
        codex: { adapter: "openai-responses", baseUrl: "https://chatgpt.com/backend-api/codex", authMode: "oauth" },
      },
    };

    const changed = restoreCredentialedOAuthProviderConfigs(config, provider => provider === "xai");

    expect(changed).toBe(true);
    expect(config.providers.xai).toEqual({
      adapter: "openai-chat",
      baseUrl: "https://api.x.ai/v1",
      authMode: "oauth",
      catalogProviderId: "xai",
      defaultModel: "grok-4.5",
    });
  });

  test("OAuth re-login preserves user-selected settings while refreshing registry identity", () => {
    const config: FrogConfig = {
      port: 10100,
      defaultProvider: "xai",
      providers: {
        xai: {
          adapter: "legacy-adapter",
          baseUrl: "https://legacy.invalid",
          authMode: "oauth",
          defaultModel: "user-selected",
          userModels: ["private-model"],
          headers: { "x-user-header": "keep" },
        },
      },
    };

    expect(upsertOAuthProvider(config, "xai")).toBe(true);
    expect(config.providers.xai).toEqual({
      adapter: "openai-chat",
      baseUrl: "https://api.x.ai/v1",
      authMode: "oauth",
      catalogProviderId: "xai",
      defaultModel: "user-selected",
      userModels: ["private-model"],
      headers: { "x-user-header": "keep" },
    });
  });

  test("registry user seeds never persist managed model metadata", () => {
    const seed = providerUserSeedFromRegistry("umans");

    expect(seed).toEqual({
      adapter: "anthropic",
      baseUrl: "https://api.code.umans.ai",
      authMode: "key",
      catalogProviderId: "umans",
      defaultModel: "umans-coder",
    });
    expect(seed.models).toBeUndefined();
    expect(seed.modelContextWindows).toBeUndefined();
    expect(seed.modelCapabilities).toBeUndefined();
    expect(seed.noReasoningModels).toBeUndefined();
  });

  test("a logged-out default OAuth provider does not reset to the native fallback", () => {
    const config: FrogConfig = {
      port: 10100,
      defaultProvider: "xai",
      providers: {
        xai: { adapter: "openai-chat", baseUrl: "https://api.x.ai/v1", authMode: "oauth" },
      },
    };

    const loggedOut = loggedOutOAuthProviders(config, () => false);

    expect(loggedOut).toEqual(["xai"]);
    expect(config.defaultProvider).toBe("xai");
    expect(config.providers.xai).toBeDefined();
    expect(config.providers.anthropic).toBeUndefined();
  });

  test("GUI preset projection preserves current featured set plus key catalog and custom", () => {
    const featured = deriveFeaturedProviderIds();
    expect(featured).toEqual([
      "codex", "xai", "anthropic", "kimi", "openai-apikey", "umans", "opencode-go", "openrouter",
      "groq", "google", "azure-openai", "ollama", "vllm", "lm-studio",
    ]);

    const presets = deriveProviderPresets();
    expect(presets.some(p => p.id === "openai-forward")).toBe(false);
    expect(presets.at(-1)?.id).toBe("custom");
    expect(presets.find(p => p.id === "kimi")?.baseUrl).toBe("https://api.kimi.com/coding/v1");
    expect(presets.find(p => p.id === "anthropic")?.defaultModel).toBe("claude-sonnet-5");
    expect(presets.find(p => p.id === "umans")).toMatchObject({
      adapter: "anthropic",
      baseUrl: "https://api.code.umans.ai",
      auth: "key",
      defaultModel: "umans-coder",
    });
    expect(presets.find(p => p.id === "azure-openai")?.adapter).toBe("azure-openai");
  });

  test("Umans registry metadata reaches routed Claude Code catalog entries", () => {
    const entries = buildCatalogEntries(nativeTemplate(), [], [
      {
        provider: "umans",
        id: "umans-coder",
        contextWindow: KEY_LOGIN_PROVIDERS.umans.modelContextWindows?.["umans-coder"],
        inputModalities: KEY_LOGIN_PROVIDERS.umans.modelCapabilities?.["umans-coder"]?.input,
        reasoningEfforts: KEY_LOGIN_PROVIDERS.umans.modelReasoningEfforts?.["umans-coder"],
      },
      {
        provider: "umans",
        id: "umans-glm-5.2",
        contextWindow: KEY_LOGIN_PROVIDERS.umans.modelContextWindows?.["umans-glm-5.2"],
        inputModalities: KEY_LOGIN_PROVIDERS.umans.modelCapabilities?.["umans-glm-5.2"]?.input,
        reasoningEfforts: KEY_LOGIN_PROVIDERS.umans.modelReasoningEfforts?.["umans-glm-5.2"],
      },
    ]);
    const coder = entries.find(e => e.slug === "umans/umans-coder");
    const glm = entries.find(e => e.slug === "umans/umans-glm-5.2");

    expect(coder?.context_window).toBe(262_144);
    expect(coder?.input_modalities).toEqual(["text", "image"]);
    expect(glm?.context_window).toBe(405_504);
    expect(glm?.input_modalities).toEqual(["text"]);
    expect(glm?.default_reasoning_level).toBe("high");
  });

  test("jawcode metadata aliases are derived from the registry", () => {
    expect(deriveJawcodeAliases()).toEqual({
      xai: "xai",
      anthropic: "anthropic",
      kimi: "moonshot",
      "opencode-go": "opencode-go",
      openrouter: "openrouter",
      google: "google",
      gemini: "google",
      moonshot: "moonshot",
      minimax: "minimax",
      "minimax-cn": "minimax",
    });
    expect(resolveJawcodeProvider("gemini")).toBe("google");
    expect(resolveJawcodeProvider("minimax-cn")).toBe("minimax");
  });

  test("legacy azure adapter spelling remains accepted", () => {
    const adapter = resolveAdapter({
      adapter: "azure",
      baseUrl: "https://example.openai.azure.com/openai/deployments/demo",
      apiKey: "key",
      defaultModel: "deployment",
    });
    expect("nativeRelay" in adapter && adapter.nativeRelay).toBe(true);
  });

  test("MiniMax metadata lookup tolerates routed lowercase ids", () => {
    expect(getJawcodeModelMetadata("minimax", "MiniMax-M2.5")?.contextWindow).toBe(204_800);
    expect(getJawcodeModelMetadata("minimax", "minimax-m2.5")).toBeUndefined();

    const entries = buildCatalogEntries(nativeTemplate(), [], [
      { provider: "minimax", id: "minimax-m2.5" },
    ]);
    const routed = entries.find(e => e.slug === "minimax/minimax-m2.5");
    expect(routed?.context_window).toBe(204_800);
    expect(routed?.max_context_window).toBe(204_800);
  });
});

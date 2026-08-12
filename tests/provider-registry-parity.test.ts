import { describe, expect, test } from "bun:test";
import { buildCatalogEntries } from "../src/claude-catalog";
import { getJawcodeModelMetadata, resolveJawcodeProvider } from "../src/generated/jawcode-model-metadata";
import { buildInitProviders } from "../src/init";
import { OAUTH_PROVIDERS, loggedOutOAuthProviders, reconcileOAuthProviderConfig } from "../src/oauth";
import { KEY_LOGIN_PROVIDERS, reconcileKeyProviderConfigs } from "../src/oauth/key-providers";
import {
  deriveFeaturedProviderIds,
  deriveInitProviders,
  deriveJawcodeAliases,
  deriveKeyLoginMap,
  deriveProviderPresets,
} from "../src/providers/derive";
import { PROVIDER_REGISTRY } from "../src/providers/registry";
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

  test("OAuth provider configs use canonical registry values", () => {
    const codex = OAUTH_PROVIDERS.codex.providerConfig;
    const supportedCodexFallbacks = [
      "gpt-5.6-sol",
      "gpt-5.6-terra",
      "gpt-5.6-luna",
      "gpt-5.5",
      "gpt-5.4",
      "gpt-5.4-mini",
      "gpt-5.3-codex-spark",
    ];

    expect(codex.baseUrl).toBe("https://chatgpt.com/backend-api/codex");
    expect(codex.defaultModel).toBe("gpt-5.5");
    expect(codex.models).toEqual(supportedCodexFallbacks);
    expect(codex.noTemperatureModels).toEqual(supportedCodexFallbacks);
    expect(codex.noTopPModels).toEqual(supportedCodexFallbacks);
    expect(codex.modelContextWindows?.["gpt-5.3-codex"]).toBeUndefined();
    expect(codex.modelContextWindows?.["gpt-5.3-codex-spark"]).toBe(128_000);
    expect(codex.modelContextWindows?.["gpt-5.6-luna"]).toBe(272_000);
    expect(OAUTH_PROVIDERS.kimi.providerConfig.baseUrl).toBe("https://api.kimi.com/coding/v1");
    expect(OAUTH_PROVIDERS.anthropic).toBeUndefined();
    expect(OAUTH_PROVIDERS.xai.providerConfig.defaultModel).toBe("grok-4.5");
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

  test("logged-in OAuth credentials restore a missing non-Anthropic provider config", () => {
    const config: FrogConfig = {
      port: 10100,
      defaultProvider: "codex",
      providers: {
        codex: { adapter: "openai-responses", baseUrl: "https://chatgpt.com/backend-api/codex", authMode: "oauth" },
      },
    };

    const changed = reconcileOAuthProviderConfig(config, provider => provider === "xai");

    expect(changed).toBe(true);
    expect(config.providers.xai).toMatchObject({
      adapter: "openai-chat",
      baseUrl: "https://api.x.ai/v1",
      authMode: "oauth",
      defaultModel: "grok-4.5",
    });
    expect(config.providers.xai?.models).toContain("grok-4.5");
  });

  test("stored canonical key providers receive refreshed catalog fields without losing credentials", () => {
    const config: FrogConfig = {
      port: 10100,
      defaultProvider: "umans",
      providers: {
        umans: {
          adapter: "anthropic",
          baseUrl: "https://api.code.umans.ai",
          apiKey: "sk-existing",
          defaultModel: "umans-glm-5.1",
          models: ["umans-coder", "umans-glm-5.1", "umans-private-preview"],
          modelContextWindows: { "umans-glm-5.1": 202_752 },
        },
      },
    };

    expect(reconcileKeyProviderConfigs(config)).toBe(true);
    expect(config.providers.umans.apiKey).toBe("sk-existing");
    expect(config.providers.umans.defaultModel).toBe("umans-coder");
    expect(config.providers.umans.models).toEqual([
      ...KEY_LOGIN_PROVIDERS.umans.models!,
      "umans-private-preview",
    ]);
    expect(config.providers.umans.modelContextWindows?.["umans-glm-5.1"]).toBeUndefined();
    expect(config.providers.umans.modelContextWindows?.["umans-kimi-k3"]).toBe(1_000_000);
  });

  test("stored Anthropic catalog adds current Claude models without changing a valid legacy default", () => {
    const config: FrogConfig = {
      port: 10100,
      defaultProvider: "anthropic",
      providers: {
        anthropic: {
          adapter: "anthropic",
          baseUrl: "https://api.anthropic.com",
          apiKey: "sk-existing",
          defaultModel: "claude-sonnet-4-6",
          models: ["claude-opus-4-8", "claude-sonnet-4-6", "claude-private-preview"],
        },
      },
    };

    expect(reconcileKeyProviderConfigs(config)).toBe(true);
    expect(config.providers.anthropic.apiKey).toBe("sk-existing");
    expect(config.providers.anthropic.defaultModel).toBe("claude-sonnet-4-6");
    expect(config.providers.anthropic.models).toEqual([
      ...KEY_LOGIN_PROVIDERS.anthropic.models!,
      "claude-private-preview",
    ]);
  });

  test("stored key provider catalog refresh respects explicit model allowlists", () => {
    const config: FrogConfig = {
      port: 10100,
      defaultProvider: "umans",
      providers: {
        umans: {
          adapter: "anthropic",
          baseUrl: "https://api.code.umans.ai",
          apiKey: "sk-existing",
          liveModels: false,
          defaultModel: "umans-glm-5.1",
          models: ["umans-glm-5.1"],
        },
      },
    };

    expect(reconcileKeyProviderConfigs(config)).toBe(false);
    expect(config.providers.umans.models).toEqual(["umans-glm-5.1"]);
    expect(config.providers.umans.defaultModel).toBe("umans-glm-5.1");
  });

  test("key catalog refresh preserves live-only defaults and explicit model additions", () => {
    const config: FrogConfig = {
      port: 10100,
      defaultProvider: "neuralwatt",
      providers: {
        neuralwatt: {
          adapter: "openai-chat",
          baseUrl: "https://api.neuralwatt.com/v1",
          apiKey: "nw-existing",
          defaultModel: "kimi-k3-flex",
          models: ["qwen3.5-397b", "kimi-k3-flex"],
          modelContextWindows: { "qwen3.5-397b": 100_000, "kimi-k3-flex": 900_000 },
          modelCapabilities: {
            "qwen3.5-397b": { input: ["text"] },
            "kimi-k3-flex": { input: ["text", "image"] },
          },
          modelReasoningEfforts: {
            "qwen3.5-397b": ["high"],
            "kimi-k3-flex": ["xhigh"],
          },
          modelReasoningEffortMap: {
            "qwen3.5-397b": { xhigh: "high" },
            "kimi-k3-flex": { xhigh: "max" },
          },
          preserveReasoningContentModels: ["qwen3.5-397b", "kimi-k3-flex"],
          noReasoningModels: ["glm-5.2-fast", "kimi-k3-flex"],
        },
        openrouter: {
          adapter: "openai-chat",
          baseUrl: "https://openrouter.ai/api/v1",
          apiKey: "or-existing",
          defaultModel: "private/model",
          models: ["private/model"],
        },
      },
    };

    expect(reconcileKeyProviderConfigs(config)).toBe(true);
    expect(config.providers.neuralwatt.defaultModel).toBe("kimi-k3-flex");
    expect(config.providers.neuralwatt.models).toContain("kimi-k3-flex");
    expect(config.providers.neuralwatt.models).not.toContain("qwen3.5-397b");
    expect(config.providers.neuralwatt.modelContextWindows?.["kimi-k3-flex"]).toBe(900_000);
    expect(config.providers.neuralwatt.modelCapabilities?.["kimi-k3-flex"]?.input).toEqual(["text", "image"]);
    expect(config.providers.neuralwatt.modelReasoningEfforts?.["kimi-k3-flex"]).toEqual(["xhigh"]);
    expect(config.providers.neuralwatt.modelReasoningEffortMap?.["kimi-k3-flex"]?.xhigh).toBe("max");
    expect(config.providers.neuralwatt.preserveReasoningContentModels).toContain("kimi-k3-flex");
    expect(config.providers.neuralwatt.modelContextWindows?.["qwen3.5-397b"]).toBeUndefined();
    expect(config.providers.neuralwatt.modelReasoningEffortMap?.["qwen3.5-397b"]).toBeUndefined();
    expect(config.providers.neuralwatt.noReasoningModels).not.toContain("glm-5.2-fast");
    expect(config.providers.neuralwatt.noReasoningModels).toContain("kimi-k3-flex");
    expect(config.providers.openrouter).toMatchObject({
      defaultModel: "private/model",
      models: ["private/model"],
    });
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

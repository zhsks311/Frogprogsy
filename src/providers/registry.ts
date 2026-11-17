import type { FrogModelCapabilities, FrogProviderConfig } from "../types";

export type ProviderAuthKind = "forward" | "oauth" | "key" | "local";
export type MetadataModelIdNormalize = "case-insensitive";

export interface ProviderRegistryEntry {
  id: string;
  label: string;
  adapter: string;
  baseUrl: string;
  authKind: ProviderAuthKind;
  featured?: boolean;
  note?: string;
  dashboardUrl?: string;
  minFrogprogsyVersion?: string;
  defaultModel?: string;
  models?: string[];
  retiredModels?: string[];
  /** Models intentionally removed from maintained metadata without claiming provider retirement. */
  unmanagedModels?: string[];
  modelMinFrogprogsyVersions?: Record<string, string>;
  /** Audited provider limits retained in source; Frogprogsy does not currently apply output caps. */
  modelMaxOutputTokens?: Record<string, number>;
  contextWindow?: number;
  modelContextWindows?: Record<string, number>;
  modelCapabilities?: Record<string, FrogModelCapabilities>;
  reasoningEfforts?: string[];
  modelReasoningEfforts?: Record<string, string[]>;
  reasoningEffortMap?: Record<string, string>;
  modelReasoningEffortMap?: Record<string, Record<string, string>>;
  noReasoningModels?: string[];
  noTemperatureModels?: string[];
  noTopPModels?: string[];
  noPenaltyModels?: string[];
  autoToolChoiceOnlyModels?: string[];
  preserveReasoningContentModels?: string[];
  escapeBuiltinToolNames?: boolean;
  oauthId?: string;
  jawcodeBundle?: string;
  /** Provider-owned sources used to verify maintained model metadata. */
  officialModelSources?: string[];
  /** Jawcode rows verified against the provider-owned sources. OpenRouter remains unfiltered. */
  verifiedJawcodeModels?: string[];
  extraMetadataAliases?: string[];
  metadataModelIdNormalize?: MetadataModelIdNormalize;
}

export type ProviderConfigSeed = Pick<
  FrogProviderConfig,
  "adapter" | "baseUrl" | "authMode" | "defaultModel" | "models"
  | "contextWindow" | "modelContextWindows" | "modelCapabilities"
  | "reasoningEfforts" | "modelReasoningEfforts" | "reasoningEffortMap" | "modelReasoningEffortMap"
  | "noReasoningModels" | "noTemperatureModels" | "noTopPModels" | "noPenaltyModels"
  | "autoToolChoiceOnlyModels" | "preserveReasoningContentModels" | "escapeBuiltinToolNames"
>;

// Verified wire-dialect support is bundled with the adapter, not inferred from effort tiers.
// Keep catalog v1's strict schema readable by older clients; new dialects require a client update.
const CLAUDE_20261117_MODELS = ["claude-fable-5-2", "claude-opus-5-5", "claude-sonnet-5-5", "claude-haiku-5-5"];
const OPENAI_GPT6_ADDITIONS = ["gpt-6.1-sol", "gpt-6.1-terra", "gpt-6-sol", "gpt-6-luna"];
const GOOGLE_20261117_MODELS = ["gemini-4-carbon", "gemini-4-argon", "gemini-4-hydrogen", "gemini-3.8-flash"];
export const ANTHROPIC_ADAPTIVE_THINKING_MODELS = ["claude-fable-5", "claude-fable-5-1", ...CLAUDE_20261117_MODELS];

function textOnlyCapabilities(ids: readonly string[]): Record<string, FrogModelCapabilities> {
  return Object.fromEntries(ids.map(id => [id, { input: ["text"] } satisfies FrogModelCapabilities]));
}



const XHIGH_TO_MAX_REASONING_MAP: Record<string, string> = { xhigh: "max", max: "max" };
const ZAI_GLM_52_MODELS = ["glm-5.2"];
const ZAI_GLM_53_MODELS = ["glm-5.3-flash", "glm-5.3", "glm-5.3[1m]"];
const ZAI_GLM_52_REASONING_EFFORTS = ["low", "medium", "high", "xhigh"];
const ZAI_GLM_53_REASONING_EFFORTS = ["low", "high", "xhigh"];
const ZAI_GLM_52_REASONING_MAP: Record<string, string> = {
  none: "none",
  minimal: "none",
  low: "high",
  medium: "high",
  high: "high",
  xhigh: "max",
  max: "max",
};
const KIMI_CODE_MODELS = ["k3.1-pro", "k3.1-pro-highspeed", "k3", "k3-256k", "kimi-for-coding", "kimi-for-coding-highspeed"];
const KIMI_CODE_REASONING_EFFORT_MODELS = ["k3.1-pro", "k3.1-pro-highspeed", "k3", "k3-256k", "kimi-for-coding"];
const KIMI_CODE_NO_EFFORT_MODELS = ["kimi-for-coding-highspeed"];
const MOONSHOT_THINKING_MODELS = ["kimi-k2.7-code", "kimi-k2.7-code-highspeed", "kimi-k2.6"];
const MOONSHOT_LOCKED_PARAMETER_MODELS = ["kimi-k3", ...MOONSHOT_THINKING_MODELS];
const KIMI_K3_REASONING_EFFORTS = ["low", "high", "xhigh"];
const UMANS_MODELS = ["umans-coder", "umans-flash", "umans-deepseek-v4.1-flash", "umans-deepseek-v4.1-flash-1017", "umans-glm-5.3", "umans-kimi-k3.1-pro"];
const UMANS_TEXT_ONLY_MODELS = ["umans-glm-5.3"];
const UMANS_MODEL_CONTEXT_WINDOWS = {"umans-coder": 1048576, "umans-flash": 262144, "umans-deepseek-v4.1-flash": 1048576, "umans-deepseek-v4.1-flash-1017": 1048576, "umans-glm-5.3": 1048576, "umans-kimi-k3.1-pro": 1048576};
const UMANS_MODEL_CAPABILITIES: Record<string, FrogModelCapabilities> = Object.fromEntries(
  UMANS_MODELS.map(id => [id, { input: UMANS_TEXT_ONLY_MODELS.includes(id) ? ["text"] : ["text", "image"] } satisfies FrogModelCapabilities]),
);

export const PROVIDER_REGISTRY: readonly ProviderRegistryEntry[] = [
  {
    id: "codex",
    label: "OpenAI Codex (ChatGPT login)",
    adapter: "openai-responses",
    baseUrl: "https://chatgpt.com/backend-api/codex",
    authKind: "oauth",
    featured: true,
    oauthId: "codex",
    note: "Log in with your ChatGPT/Codex account — no API key",
    models: [
      ...OPENAI_GPT6_ADDITIONS,
      "gpt-6-astra",
      "gpt-5.6-sol",
      "gpt-5.6-terra",
      "gpt-5.6-luna",
      "gpt-5.5",
      "gpt-5.3-codex-spark",
    ],
    defaultModel: "gpt-5.6-sol",
    retiredModels: ["gpt-5.4", "gpt-5.4-mini"],
    modelContextWindows: {
      ...Object.fromEntries(OPENAI_GPT6_ADDITIONS.map(id => [id, 872_000])),
      "gpt-6-astra": 872_000,
      "gpt-5.6-sol": 872_000,
      "gpt-5.6-terra": 872_000,
      "gpt-5.6-luna": 872_000,
      "gpt-5.5": 272_000,
      "gpt-5.3-codex-spark": 128_000,
    },
    modelCapabilities: {
      ...Object.fromEntries(
        [...OPENAI_GPT6_ADDITIONS, "gpt-6-astra", "gpt-5.6-sol", "gpt-5.6-terra", "gpt-5.6-luna", "gpt-5.5"]
          .map(id => [id, { input: ["text", "image"] } satisfies FrogModelCapabilities]),
      ),
      "gpt-5.3-codex-spark": { input: ["text"] },
    },
    reasoningEfforts: ["low", "medium", "high", "xhigh"],
    officialModelSources: [
      "https://learn.chatgpt.com/docs/models",
      "https://chatgpt.com/backend-api/codex/models?client_version=1.0.0",
    ],
  },
  {
    id: "xai",
    label: "xAI Grok",
    adapter: "openai-chat",
    baseUrl: "https://api.x.ai/v1",
    authKind: "oauth",
    featured: true,
    oauthId: "xai",
    jawcodeBundle: "xai",
    note: "Log in with your Grok account",
    minFrogprogsyVersion: "0.0.5",
    models: [
      "grok-4.5",
      "grok-4.3",
      "grok-4.20-0309-reasoning",
      "grok-4.20-0309-non-reasoning",
      "grok-4.20-beta-latest-reasoning",
      "grok-4.20-beta-latest-non-reasoning",
      "grok-4.20-multi-agent-beta-latest",
      "grok-build-0.1",
    ],
    defaultModel: "grok-4.5",
    retiredModels: ["grok-3", "grok-4-1-fast-non-reasoning", "grok-4-fast-non-reasoning", "grok-code-fast-1"],
    unmanagedModels: [
      "grok-2", "grok-2-1212", "grok-2-latest", "grok-2-vision", "grok-2-vision-1212", "grok-2-vision-latest",
      "grok-3-fast", "grok-3-fast-latest", "grok-3-latest", "grok-3-mini", "grok-3-mini-fast",
      "grok-3-mini-fast-latest", "grok-3-mini-latest", "grok-4", "grok-4-1-fast", "grok-4-fast",
      "grok-beta", "grok-vision-beta", "grok-composer-2.5-fast",
    ],
    modelContextWindows: {
      "grok-4.5": 500_000,
      "grok-4.3": 1_000_000,
      "grok-4.20-0309-reasoning": 1_000_000,
      "grok-4.20-0309-non-reasoning": 1_000_000,
      "grok-4.20-beta-latest-reasoning": 1_000_000,
      "grok-4.20-beta-latest-non-reasoning": 1_000_000,
      "grok-4.20-multi-agent-beta-latest": 1_000_000,
      "grok-build-0.1": 256_000,
    },
    modelCapabilities: Object.fromEntries(
      [
        "grok-4.5", "grok-4.3", "grok-4.20-0309-reasoning", "grok-4.20-0309-non-reasoning",
        "grok-4.20-beta-latest-reasoning", "grok-4.20-beta-latest-non-reasoning",
        "grok-4.20-multi-agent-beta-latest", "grok-build-0.1",
      ].map(id => [id, { input: ["text", "image"] } satisfies FrogModelCapabilities]),
    ),
    modelReasoningEfforts: {
      "grok-4.5": ["low", "medium", "high"],
      "grok-4.3": ["low", "medium", "high"],
      "grok-4.20-0309-reasoning": [],
      "grok-4.20-beta-latest-reasoning": [],
      "grok-4.20-multi-agent-beta-latest": ["low", "medium", "high", "xhigh"],
      "grok-build-0.1": [],
    },
    noReasoningModels: ["grok-4.20-0309-non-reasoning", "grok-4.20-beta-latest-non-reasoning"],
    noPenaltyModels: [
      "grok-4.5", "grok-4.3", "grok-4.20-0309-reasoning",
      "grok-4.20-beta-latest-reasoning", "grok-4.20-multi-agent-beta-latest", "grok-build-0.1",
    ],
    officialModelSources: [
      "https://docs.x.ai/developers/models",
      "https://docs.x.ai/developers/migration/may-15-retirement",
    ],
    verifiedJawcodeModels: [
      "grok-4.5", "grok-4.3", "grok-4.20-0309-reasoning", "grok-4.20-0309-non-reasoning",
      "grok-4.20-beta-latest-reasoning", "grok-4.20-beta-latest-non-reasoning",
      "grok-4.20-multi-agent-beta-latest", "grok-build-0.1",
    ],
  },
  {
    id: "anthropic",
    label: "Anthropic Claude",
    adapter: "anthropic",
    baseUrl: "https://api.anthropic.com",
    authKind: "key",
    featured: true,
    dashboardUrl: "https://console.anthropic.com/settings/keys",
    jawcodeBundle: "anthropic",
    note: "Use Claude Code login from a config directory such as ~/.claude; add another Anthropic row with another Claude Code home for multiple Claude accounts.",
    minFrogprogsyVersion: "0.0.5",
    models: [
      ...CLAUDE_20261117_MODELS,
      "claude-fable-5-1",
      "claude-fable-5",
      "claude-opus-5",
      "claude-sonnet-5",
      "claude-opus-4-8",
      "claude-opus-4-7",
      "claude-opus-4-6",
      "claude-sonnet-4-6",
      "claude-sonnet-4-5",
      "claude-sonnet-4-5-20250929",
      "claude-opus-4-5",
      "claude-opus-4-5-20251101",
      "claude-haiku-4-5",
      "claude-haiku-4-5-20251001",
    ],
    defaultModel: "claude-sonnet-5",
    retiredModels: [
      "claude-3-5-sonnet-20240620",
      "claude-3-5-sonnet-20241022",
      "claude-3-haiku-20240307",
      "claude-opus-4-1-20250805",
      "claude-opus-4-20250514",
      "claude-sonnet-4-20250514",
    ],
    unmanagedModels: [
      "claude-opus-4-0",
      "claude-opus-4-1",
      "claude-sonnet-4-0",
      "claude-opus-4-6[1m]",
      "claude-opus-4-7[1m]",
      "claude-opus-4-8[1m]",
      "claude-sonnet-4-6[1m]",
    ],
    modelContextWindows: Object.fromEntries([
      ...[...CLAUDE_20261117_MODELS, "claude-fable-5-1", "claude-fable-5", "claude-opus-5", "claude-sonnet-5", "claude-opus-4-8", "claude-opus-4-7", "claude-opus-4-6", "claude-sonnet-4-6"]
        .map(id => [id, 1_000_000]),
      ...["claude-sonnet-4-5", "claude-sonnet-4-5-20250929", "claude-opus-4-5", "claude-opus-4-5-20251101", "claude-haiku-4-5", "claude-haiku-4-5-20251001"]
        .map(id => [id, 200_000]),
    ]),
    modelMaxOutputTokens: Object.fromEntries([
      ...[...CLAUDE_20261117_MODELS, "claude-fable-5-1", "claude-fable-5", "claude-opus-5", "claude-sonnet-5", "claude-opus-4-8", "claude-opus-4-7", "claude-opus-4-6", "claude-sonnet-4-6"]
        .map(id => [id, 128_000]),
      ...["claude-sonnet-4-5", "claude-sonnet-4-5-20250929", "claude-opus-4-5", "claude-opus-4-5-20251101", "claude-haiku-4-5", "claude-haiku-4-5-20251001"]
        .map(id => [id, 64_000]),
    ]),
    modelCapabilities: Object.fromEntries(
      [
        ...CLAUDE_20261117_MODELS,
        "claude-fable-5-1", "claude-fable-5", "claude-opus-5", "claude-sonnet-5", "claude-opus-4-8", "claude-opus-4-7",
        "claude-opus-4-6", "claude-sonnet-4-6", "claude-sonnet-4-5", "claude-sonnet-4-5-20250929",
        "claude-opus-4-5", "claude-opus-4-5-20251101", "claude-haiku-4-5", "claude-haiku-4-5-20251001",
      ].map(id => [id, { input: ["text", "image"] } satisfies FrogModelCapabilities]),
    ),
    modelReasoningEfforts: Object.fromEntries(
      [...CLAUDE_20261117_MODELS, "claude-fable-5-1"].map(id => [id, ["low", "medium", "high", "xhigh"]]),
    ),
    modelMinFrogprogsyVersions: {
      "claude-fable-5-1": "0.0.7",
      ...Object.fromEntries(CLAUDE_20261117_MODELS.map(id => [id, "0.0.9"])),
    },
    noTemperatureModels: [...CLAUDE_20261117_MODELS, "claude-fable-5-1", "claude-fable-5", "claude-opus-5", "claude-sonnet-5", "claude-opus-4-8", "claude-opus-4-7"],
    noTopPModels: [...CLAUDE_20261117_MODELS, "claude-fable-5-1", "claude-fable-5", "claude-opus-5", "claude-sonnet-5", "claude-opus-4-8", "claude-opus-4-7"],
    autoToolChoiceOnlyModels: ["claude-fable-5-1", "claude-fable-5-2", "claude-opus-5-5", "claude-sonnet-5-5"],
    officialModelSources: [
      "https://platform.claude.com/docs/en/about-claude/models/overview",
      "https://platform.claude.com/docs/en/about-claude/model-deprecations",
      "https://platform.claude.com/docs/en/models/fable-5-1/overview",
      "https://platform.claude.com/docs/en/models/fable-5-1/migration-guide",
      "https://platform.claude.com/docs/en/build-with-claude/effort",
      "https://platform.claude.com/docs/en/models/fable-5-2/migration-guide",
      "https://platform.claude.com/docs/en/models/opus-5-5/migration-guide",
      "https://platform.claude.com/docs/en/models/sonnet-5-5/migration-guide",
      "https://platform.claude.com/docs/en/models/haiku-5-5/migration-guide",
    ],
    verifiedJawcodeModels: [
      "claude-fable-5-1", "claude-fable-5", "claude-opus-5", "claude-sonnet-5", "claude-opus-4-8", "claude-opus-4-7",
      "claude-opus-4-6", "claude-sonnet-4-6", "claude-sonnet-4-5", "claude-sonnet-4-5-20250929",
      "claude-opus-4-5", "claude-opus-4-5-20251101", "claude-haiku-4-5", "claude-haiku-4-5-20251001",
    ],
  },
  {
    id: "kimi",
    label: "Kimi",
    adapter: "openai-chat",
    baseUrl: "https://api.kimi.com/coding/v1",
    authKind: "oauth",
    featured: true,
    oauthId: "kimi",
    note: "Kimi Code model access and 1M context depend on the account plan.",
    models: KIMI_CODE_MODELS,
    defaultModel: "k3",
    modelContextWindows: Object.fromEntries(KIMI_CODE_MODELS.map(id => [id, id === "k3-256k" || id === "kimi-for-coding-highspeed" ? 262_144 : 1_048_576])),
    modelCapabilities: Object.fromEntries(
      KIMI_CODE_MODELS.map(id => [id, { input: ["text", "image"] } satisfies FrogModelCapabilities]),
    ),
    modelReasoningEfforts: {
      ...Object.fromEntries(KIMI_CODE_REASONING_EFFORT_MODELS.map(id => [id, KIMI_K3_REASONING_EFFORTS])),
      ...Object.fromEntries(KIMI_CODE_NO_EFFORT_MODELS.map(id => [id, []])),
    },
    modelReasoningEffortMap: Object.fromEntries(
      KIMI_CODE_REASONING_EFFORT_MODELS.map(id => [id, XHIGH_TO_MAX_REASONING_MAP]),
    ),
    noReasoningModels: KIMI_CODE_NO_EFFORT_MODELS,
    preserveReasoningContentModels: KIMI_CODE_MODELS,
    officialModelSources: ["https://www.kimi.com/code/docs/en/kimi-code/models.html"],
  },
  {
    id: "openai-apikey",
    label: "OpenAI (API key)",
    adapter: "openai-responses",
    baseUrl: "https://api.openai.com/v1",
    authKind: "key",
    featured: true,
    dashboardUrl: "https://platform.openai.com/api-keys",
    models: [...OPENAI_GPT6_ADDITIONS, "gpt-6-astra", "gpt-5.6-sol", "gpt-5.6-terra", "gpt-5.6-luna", "gpt-5.5"],
    defaultModel: "gpt-5.5",
    modelMinFrogprogsyVersions: { "gpt-6-astra": "0.0.7" },
    modelContextWindows: Object.fromEntries(
      [...OPENAI_GPT6_ADDITIONS, "gpt-6-astra", "gpt-5.6-sol", "gpt-5.6-terra", "gpt-5.6-luna", "gpt-5.5"].map(id => [id, 1_050_000]),
    ),
    modelMaxOutputTokens: Object.fromEntries(
      [...OPENAI_GPT6_ADDITIONS, "gpt-6-astra", "gpt-5.6-sol", "gpt-5.6-terra", "gpt-5.6-luna", "gpt-5.5"].map(id => [id, 128_000]),
    ),
    modelCapabilities: Object.fromEntries(
      [...OPENAI_GPT6_ADDITIONS, "gpt-6-astra", "gpt-5.6-sol", "gpt-5.6-terra", "gpt-5.6-luna", "gpt-5.5"]
        .map(id => [id, { input: ["text", "image"] } satisfies FrogModelCapabilities]),
    ),
    modelReasoningEfforts: Object.fromEntries(
      [...OPENAI_GPT6_ADDITIONS, "gpt-6-astra", "gpt-5.6-sol", "gpt-5.6-terra", "gpt-5.6-luna", "gpt-5.5"]
        .map(id => [id, ["low", "medium", "high", "xhigh"]]),
    ),
    noTemperatureModels: ["gpt-6-astra", ...OPENAI_GPT6_ADDITIONS],
    noTopPModels: ["gpt-6-astra", ...OPENAI_GPT6_ADDITIONS],
    officialModelSources: [
      "https://developers.openai.com/api/docs/models/gpt-6.1-sol",
      "https://developers.openai.com/api/docs/models/gpt-6.1-terra",
      "https://developers.openai.com/api/docs/models/gpt-6-sol",
      "https://developers.openai.com/api/docs/models/gpt-6-luna",
      "https://developers.openai.com/api/docs/models/gpt-6-astra",
      "https://developers.openai.com/api/docs/guides/latest-model?model=gpt-6-astra",
      "https://developers.openai.com/api/docs/models/gpt-5.6-sol",
      "https://developers.openai.com/api/docs/models/gpt-5.6-terra",
      "https://developers.openai.com/api/docs/models/gpt-5.6-luna",
      "https://developers.openai.com/api/docs/models/gpt-5.5",
    ],
  },
  {
    id: "umans",
    label: "Umans AI Coding Plan",
    adapter: "anthropic",
    baseUrl: "https://api.code.umans.ai",
    authKind: "key",
    featured: true,
    dashboardUrl: "https://app.umans.ai/billing",
    defaultModel: "umans-coder",
    minFrogprogsyVersion: "0.0.5",
    models: UMANS_MODELS,
    retiredModels: ["umans-kimi-k2.7", "umans-kimi-k3", "umans-glm-5.2", "umans-deepseek-v4-pro-0813", "umans-glm-5.3-flash", "umans-deepseek-v4-flash-0731", "umans-qwen3.6-35b-a3b"],
    unmanagedModels: ["umans-kimi-k2.6", "umans-glm-5.1"],
    modelContextWindows: UMANS_MODEL_CONTEXT_WINDOWS,
    modelMaxOutputTokens: {
      "umans-coder": 393216,
      "umans-flash": 262144,
      "umans-deepseek-v4.1-flash": 393216,
      "umans-deepseek-v4.1-flash-1017": 393216,
      "umans-glm-5.3": 131072,
      "umans-kimi-k3.1-pro": 131072
    },
    modelCapabilities: UMANS_MODEL_CAPABILITIES,
    note: "Coding plan via Anthropic Messages",
    modelReasoningEfforts: {
      "umans-coder": [
        "low",
        "high",
        "xhigh"
      ],
      "umans-flash": [
        "low",
        "high",
        "xhigh"
      ],
      "umans-deepseek-v4.1-flash": [
        "low",
        "high",
        "xhigh"
      ],
      "umans-deepseek-v4.1-flash-1017": [
        "low",
        "high",
        "xhigh"
      ],
      "umans-glm-5.3": [
        "low",
        "high",
        "xhigh"
      ],
      "umans-kimi-k3.1-pro": [
        "low",
        "high",
        "xhigh"
      ]
    },
    modelReasoningEffortMap: {
      "umans-coder": {
        "xhigh": "max",
        "max": "max"
      },
      "umans-flash": {
        "xhigh": "max",
        "max": "max"
      },
      "umans-deepseek-v4.1-flash": {
        "xhigh": "max",
        "max": "max"
      },
      "umans-deepseek-v4.1-flash-1017": {
        "xhigh": "max",
        "max": "max"
      },
      "umans-glm-5.3": {
        "xhigh": "max",
        "max": "max"
      },
      "umans-kimi-k3.1-pro": {
        "xhigh": "max",
        "max": "max"
      }
    },
    noTemperatureModels: ["umans-kimi-k3.1-pro"],
    noTopPModels: ["umans-kimi-k3.1-pro"],
    escapeBuiltinToolNames: true,
    officialModelSources: [
      "https://api.code.umans.ai/v1/models",
      "https://api.code.umans.ai/v1/models/info",
      "https://app.umans.ai/offers/code/docs",
    ],
  },
  {
    id: "opencode-go",
    label: "opencode go",
    adapter: "openai-chat",
    baseUrl: "https://opencode.ai/zen/go/v1",
    authKind: "key",
    featured: true,
    dashboardUrl: "https://opencode.ai/auth",
    defaultModel: "kimi-k2.7-code",
    jawcodeBundle: "opencode-go",
    note: "GLM, DeepSeek, Kimi, Qwen, MiMo…",
    models: [
      "deepseek-v4-flash", "deepseek-v4-pro", "glm-5", "glm-5.1", "glm-5.2", "glm-5.3",
      "gpt-5.6-luna", "grok-4.5", "hy3", "hy3-preview", "kimi-k2.5", "kimi-k2.6", "kimi-k2.7-code",
      "kimi-k3", "mimo-v2-omni", "mimo-v2-pro", "mimo-v2.5", "mimo-v2.5-pro", "minimax-m2.5",
      "minimax-m2.7", "minimax-m3", "muse-spark-1.2-contributor", "qwen3.5-plus", "qwen3.6-plus",
      "qwen3.7-max", "qwen3.7-plus", "qwen3.8-max",
    ],
    officialModelSources: [
      "https://opencode.ai/docs/go/",
      "https://opencode.ai/zen/go/v1/models",
    ],
    verifiedJawcodeModels: [],
  },
  {
    id: "neuralwatt",
    label: "Neuralwatt Cloud",
    adapter: "openai-chat",
    baseUrl: "https://api.neuralwatt.com/v1",
    authKind: "key",
    dashboardUrl: "https://portal.neuralwatt.com",
    defaultModel: "glm-5.2",
    models: ["glm-5.2", "qwen-3.8-27b", "qwen-3.8-27b-flex", "nw-small", "nw-small-flex", "mimo-v2.6-pro", "mimo-v2.6-pro-flex", "deepseek-v4.1-flash", "deepseek-v4.1-flash-flex", "nw-flash", "nw-flash-flex", "glm-5.3", "glm-5.3-flex", "glm-5.3-flash", "glm-5.3-flash-flex", "kimi-k3.1-pro", "kimi-k3.1-pro-flex", "nw-large", "nw-large-flex", "kimi-k3", "kimi-k3-fast", "qwen3.6-35b", "qwen3.6-35b-fast", "gemma-4-31b"],
    minFrogprogsyVersion: "0.0.5",
    unmanagedModels: ["deepseek-v4-flash", "glm-5.2-fast", "glm-5.2-short", "glm-5.2-short-fast", "kimi-k2.5-fast", "kimi-k2.6", "kimi-k2.6-fast", "kimi-k2.7-code", "kimi-k2.7-code-fast", "moonshotai/Kimi-K2.5", "qwen3.5-397b", "qwen3.5-397b-fast"],
    // Neuralwatt's /v1/models metadata is authoritative; these static hints are the offline fallback.
    modelContextWindows: {
      "qwen-3.8-27b": 262128,
      "qwen-3.8-27b-flex": 262128,
      "nw-small": 262128,
      "nw-small-flex": 262128,
      "mimo-v2.6-pro": 1048560,
      "mimo-v2.6-pro-flex": 1048560,
      "deepseek-v4.1-flash": 1048560,
      "deepseek-v4.1-flash-flex": 1048560,
      "nw-flash": 1048560,
      "nw-flash-flex": 1048560,
      "glm-5.3": 1048560,
      "glm-5.3-flex": 1048560,
      "glm-5.3-flash": 1048560,
      "glm-5.3-flash-flex": 1048560,
      "kimi-k3.1-pro": 1048560,
      "kimi-k3.1-pro-flex": 1048560,
      "nw-large": 1048560,
      "nw-large-flex": 1048560,
      "qwen3.6-35b": 262128,
      "qwen3.6-35b-fast": 262128,
      "gemma-4-31b": 262128
    },
    modelMaxOutputTokens: {
      "qwen-3.8-27b": 131072,
      "qwen-3.8-27b-flex": 131072,
      "nw-small": 131072,
      "nw-small-flex": 131072,
      "mimo-v2.6-pro": 393216,
      "mimo-v2.6-pro-flex": 393216,
      "deepseek-v4.1-flash": 393216,
      "deepseek-v4.1-flash-flex": 393216,
      "nw-flash": 393216,
      "nw-flash-flex": 393216
    },
    modelReasoningEfforts: {
      "qwen-3.8-27b": [
        "low",
        "medium",
        "xhigh"
      ],
      "qwen-3.8-27b-flex": [
        "low",
        "medium",
        "xhigh"
      ],
      "nw-small": [
        "low",
        "medium",
        "xhigh"
      ],
      "nw-small-flex": [
        "low",
        "medium",
        "xhigh"
      ],
      "mimo-v2.6-pro": [],
      "mimo-v2.6-pro-flex": [],
      "deepseek-v4.1-flash": [
        "low",
        "high",
        "xhigh"
      ],
      "deepseek-v4.1-flash-flex": [
        "low",
        "high",
        "xhigh"
      ],
      "nw-flash": [
        "low",
        "high",
        "xhigh"
      ],
      "nw-flash-flex": [
        "low",
        "high",
        "xhigh"
      ],
      "glm-5.3": [
        "low",
        "high",
        "xhigh"
      ],
      "glm-5.3-flex": [
        "low",
        "high",
        "xhigh"
      ],
      "glm-5.3-flash": [
        "low",
        "high",
        "xhigh"
      ],
      "glm-5.3-flash-flex": [
        "low",
        "high",
        "xhigh"
      ],
      "kimi-k3.1-pro": [
        "low",
        "medium",
        "high",
        "xhigh"
      ],
      "kimi-k3.1-pro-flex": [
        "low",
        "medium",
        "high",
        "xhigh"
      ],
      "nw-large": [
        "low",
        "medium",
        "high",
        "xhigh"
      ],
      "nw-large-flex": [
        "low",
        "medium",
        "high",
        "xhigh"
      ],
      "kimi-k3": [
        "low",
        "high",
        "xhigh"
      ],
      "kimi-k3-fast": [],
      "qwen3.6-35b": [],
      "qwen3.6-35b-fast": [],
      "gemma-4-31b": [
        "xhigh"
      ]
    },
    modelReasoningEffortMap: {
      "qwen-3.8-27b": {
        "high": "xhigh"
      },
      "qwen-3.8-27b-flex": {
        "high": "xhigh"
      },
      "nw-small": {
        "high": "xhigh"
      },
      "nw-small-flex": {
        "high": "xhigh"
      },
      "glm-5.3": {
        "xhigh": "max",
        "max": "max",
        "medium": "high"
      },
      "glm-5.3-flex": {
        "xhigh": "max",
        "max": "max",
        "medium": "high"
      },
      "glm-5.3-flash": {
        "xhigh": "max",
        "max": "max",
        "medium": "high"
      },
      "glm-5.3-flash-flex": {
        "xhigh": "max",
        "max": "max",
        "medium": "high"
      },
      "kimi-k3.1-pro": {
        "xhigh": "max",
        "max": "max"
      },
      "kimi-k3.1-pro-flex": {
        "xhigh": "max",
        "max": "max"
      },
      "nw-large": {
        "xhigh": "max",
        "max": "max"
      },
      "nw-large-flex": {
        "xhigh": "max",
        "max": "max"
      },
      "kimi-k3": {
        "xhigh": "max",
        "max": "max"
      },
      "gemma-4-31b": {
        "xhigh": "max",
        "max": "max"
      }
    },
    noReasoningModels: ["mimo-v2.6-pro", "mimo-v2.6-pro-flex", "kimi-k3-fast", "qwen3.6-35b", "qwen3.6-35b-fast"],
    modelCapabilities: {
      "qwen-3.8-27b": {
        "input": [
          "text",
          "image"
        ]
      },
      "qwen-3.8-27b-flex": {
        "input": [
          "text",
          "image"
        ]
      },
      "nw-small": {
        "input": [
          "text",
          "image"
        ]
      },
      "nw-small-flex": {
        "input": [
          "text",
          "image"
        ]
      },
      "mimo-v2.6-pro": {
        "input": [
          "text",
          "image"
        ]
      },
      "mimo-v2.6-pro-flex": {
        "input": [
          "text",
          "image"
        ]
      },
      "deepseek-v4.1-flash": {
        "input": [
          "text",
          "image"
        ]
      },
      "deepseek-v4.1-flash-flex": {
        "input": [
          "text",
          "image"
        ]
      },
      "nw-flash": {
        "input": [
          "text",
          "image"
        ]
      },
      "nw-flash-flex": {
        "input": [
          "text",
          "image"
        ]
      },
      "glm-5.3": {
        "input": [
          "text"
        ]
      },
      "glm-5.3-flex": {
        "input": [
          "text"
        ]
      },
      "glm-5.3-flash": {
        "input": [
          "text",
          "image"
        ]
      },
      "glm-5.3-flash-flex": {
        "input": [
          "text",
          "image"
        ]
      },
      "kimi-k3.1-pro": {
        "input": [
          "text",
          "image"
        ]
      },
      "kimi-k3.1-pro-flex": {
        "input": [
          "text",
          "image"
        ]
      },
      "nw-large": {
        "input": [
          "text",
          "image"
        ]
      },
      "nw-large-flex": {
        "input": [
          "text",
          "image"
        ]
      },
      "qwen3.6-35b": {
        "input": [
          "text",
          "image"
        ]
      },
      "qwen3.6-35b-fast": {
        "input": [
          "text",
          "image"
        ]
      },
      "gemma-4-31b": {
        "input": [
          "text",
          "image"
        ]
      }
    },
    preserveReasoningContentModels: ["qwen-3.8-27b", "qwen-3.8-27b-flex", "nw-small", "nw-small-flex", "deepseek-v4.1-flash", "deepseek-v4.1-flash-flex", "nw-flash", "nw-flash-flex", "glm-5.3", "glm-5.3-flex", "glm-5.3-flash", "glm-5.3-flash-flex", "kimi-k3.1-pro", "kimi-k3.1-pro-flex", "nw-large", "nw-large-flex", "kimi-k3", "qwen3.6-35b", "gemma-4-31b"],
    officialModelSources: [
      "https://api.neuralwatt.com/v1/models",
      "https://portal.neuralwatt.com/docs/api/models",
    ],
    note: "Public inventory; customer availability differs. Flex requests may wait for capacity.",
  },
  {
    id: "openrouter", label: "OpenRouter", adapter: "openai-chat", baseUrl: "https://openrouter.ai/api/v1",
    authKind: "key", featured: true, dashboardUrl: "https://openrouter.ai/keys", jawcodeBundle: "openrouter",
    minFrogprogsyVersion: "0.0.5",
    officialModelSources: ["https://openrouter.ai/api/v1/models"],
    unmanagedModels: [
      "ai21/jamba-large-1.7",
      "alibaba/tongyi-deepresearch-30b-a3b",
      "allenai/olmo-3.1-32b-instruct",
      "anthropic/claude-3-haiku",
      "anthropic/claude-3.5-haiku",
      "anthropic/claude-3.5-sonnet",
      "anthropic/claude-3.7-sonnet",
      "anthropic/claude-3.7-sonnet:thinking",
      "anthropic/claude-opus-4",
      "anthropic/claude-opus-4.6-fast",
      "anthropic/claude-opus-4.7-fast",
      "anthropic/claude-opus-4.8-fast",
      "anthropic/claude-sonnet-4",
      "arcee-ai/trinity-large-preview",
      "arcee-ai/trinity-large-preview:free",
      "arcee-ai/trinity-large-thinking",
      "arcee-ai/trinity-large-thinking:free",
      "arcee-ai/trinity-mini",
      "arcee-ai/trinity-mini:free",
      "arcee-ai/virtuoso-large",
      "auto",
      "baidu/cobuddy:free",
      "baidu/ernie-4.5-21b-a3b",
      "baidu/ernie-4.5-vl-28b-a3b",
      "bytedance-seed/seed-1.6",
      "bytedance-seed/seed-1.6-flash",
      "deepseek/deepseek-r1",
      "deepseek/deepseek-v3.1-terminus:exacto",
      "deepseek/deepseek-v4-flash:free",
      "essentialai/rnj-1-instruct",
      "google/gemini-2.0-flash-001",
      "google/gemini-2.0-flash-lite-001",
      "google/gemini-2.5-flash-lite-preview-09-2025",
      "google/gemini-2.5-flash-preview-09-2025",
      "google/gemini-2.5-pro-preview-05-06",
      "google/gemini-3-pro-preview",
      "google/gemma-3-27b-it:free",
      "ibm-granite/granite-4.1-8b",
      "inception/mercury",
      "inception/mercury-2",
      "inception/mercury-coder",
      "inclusionai/ling-2.6-1t",
      "inclusionai/ling-2.6-1t:free",
      "inclusionai/ling-2.6-flash",
      "inclusionai/ling-2.6-flash:free",
      "inclusionai/ring-2.6-1t",
      "inclusionai/ring-2.6-1t:free",
      "kwaipilot/kat-coder-pro",
      "kwaipilot/kat-coder-pro-v2",
      "liquid/lfm-2.5-1.2b-thinking:free",
      "meituan/longcat-flash-chat",
      "meta-llama/llama-3-8b-instruct",
      "meta-llama/llama-3.1-405b-instruct",
      "meta-llama/llama-3.3-70b-instruct:free",
      "minimax/minimax-m1",
      "minimax/minimax-m2",
      "minimax/minimax-m2.1",
      "minimax/minimax-m2.5:free",
      "mistralai/devstral-medium",
      "mistralai/devstral-small",
      "mistralai/mistral-large-2411",
      "mistralai/mistral-small-3.1-24b-instruct:free",
      "mistralai/mistral-small-creative",
      "mistralai/mixtral-8x7b-instruct",
      "mistralai/pixtral-large-2411",
      "moonshotai/kimi-k2-0905:exacto",
      "moonshotai/kimi-k2.6:free",
      "nex-agi/deepseek-v3.1-nex-n1",
      "nex-agi/nex-n2-pro:free",
      "nousresearch/deephermes-3-mistral-24b-preview",
      "nousresearch/hermes-4-70b",
      "nvidia/llama-3.1-nemotron-70b-instruct",
      "nvidia/llama-3.3-nemotron-super-49b-v1.5",
      "nvidia/nemotron-3-nano-30b-a3b:free",
      "nvidia/nemotron-3-super-120b-a12b:free",
      "nvidia/nemotron-nano-12b-v2-vl:free",
      "nvidia/nemotron-nano-9b-v2",
      "nvidia/nemotron-nano-9b-v2:free",
      "openai/gpt-3.5-turbo",
      "openai/gpt-4-0314",
      "openai/gpt-4-1106-preview",
      "openai/gpt-4-turbo",
      "openai/gpt-4-turbo-preview",
      "openai/gpt-4o-audio-preview",
      "openai/gpt-4o:extended",
      "openai/gpt-5-claude",
      "openai/gpt-5.1-chat",
      "openai/gpt-5.1-claude",
      "openai/gpt-5.1-claude-max",
      "openai/gpt-5.1-claude-mini",
      "openai/gpt-5.2-claude",
      "openai/gpt-5.3-chat",
      "openai/gpt-5.3-claude",
      "openai/gpt-oss-120b:exacto",
      "openai/gpt-oss-120b:free",
      "openai/gpt-oss-20b:free",
      "openai/o1",
      "openai/o3-deep-research",
      "openai/o3-mini",
      "openai/o3-mini-high",
      "openai/o4-mini",
      "openai/o4-mini-deep-research",
      "openai/o4-mini-high",
      "openrouter/aurora-alpha",
      "openrouter/elephant-alpha",
      "openrouter/healer-alpha",
      "openrouter/hunter-alpha",
      "openrouter/owl-alpha",
      "poolside/laguna-m.1",
      "poolside/laguna-m.1:free",
      "poolside/laguna-xs.2",
      "poolside/laguna-xs.2:free",
      "prime-intellect/intellect-3",
      "qwen/qwen-2.5-7b-instruct",
      "qwen/qwen-max",
      "qwen/qwen-plus-2025-07-28",
      "qwen/qwen-plus-2025-07-28:thinking",
      "qwen/qwen-turbo",
      "qwen/qwen-vl-max",
      "qwen/qwen3-235b-a22b",
      "qwen/qwen3-30b-a3b-thinking-2507",
      "qwen/qwen3-4b",
      "qwen/qwen3-4b:free",
      "qwen/qwen3-8b",
      "qwen/qwen3-coder-plus",
      "qwen/qwen3-coder:exacto",
      "qwen/qwen3-coder:free",
      "qwen/qwen3-max",
      "qwen/qwen3-max-thinking",
      "qwen/qwen3-next-80b-a3b-instruct:free",
      "qwen/qwen3-next-80b-a3b-thinking",
      "qwen/qwen3-vl-235b-a22b-thinking",
      "qwen/qwen3-vl-30b-a3b-thinking",
      "qwen/qwen3-vl-32b-instruct",
      "qwen/qwen3-vl-8b-thinking",
      "qwen/qwen3.6-max-preview",
      "qwen/qwen3.6-plus-preview:free",
      "qwen/qwen3.6-plus:free",
      "qwen/qwq-32b",
      "reka/reka-edge",
      "sao10k/l3-euryale-70b",
      "stepfun/step-3.5-flash",
      "stepfun/step-3.5-flash:free",
      "tencent/hy3-preview:free",
      "thedrummer/rocinante-12b",
      "tngtech/deepseek-r1t2-chimera",
      "tngtech/tng-r1t-chimera",
      "upstage/solar-pro-3",
      "upstage/solar-pro-3:free",
      "x-ai/grok-3",
      "x-ai/grok-3-beta",
      "x-ai/grok-3-mini",
      "x-ai/grok-3-mini-beta",
      "x-ai/grok-4",
      "x-ai/grok-4-fast",
      "x-ai/grok-4.1-fast",
      "x-ai/grok-4.20-beta",
      "x-ai/grok-code-fast-1",
      "xiaomi/mimo-v2-flash",
      "xiaomi/mimo-v2-omni",
      "xiaomi/mimo-v2-pro",
      "z-ai/glm-4-32b",
      "z-ai/glm-4.5-air:free",
      "z-ai/glm-4.6:exacto",
      "~openai/gpt-latest",
    ],
  },
  { id: "groq", label: "Groq", adapter: "openai-chat", baseUrl: "https://api.groq.com/openai/v1", authKind: "key", featured: true, dashboardUrl: "https://console.groq.com/keys" },
  {
    id: "google",
    label: "Google Gemini",
    adapter: "google",
    baseUrl: "https://generativelanguage.googleapis.com",
    authKind: "key",
    featured: true,
    dashboardUrl: "https://aistudio.google.com/apikey",
    jawcodeBundle: "google",
    extraMetadataAliases: ["gemini"],
    minFrogprogsyVersion: "0.0.5",
    models: [
      ...GOOGLE_20261117_MODELS,
      "gemini-2.5-flash", "gemini-2.5-flash-lite", "gemini-2.5-pro", "gemini-3-flash-preview",
      "gemini-3.1-flash-lite", "gemini-3.1-pro-preview", "gemini-3.1-pro-preview-customtools",
      "gemini-3.5-flash", "gemini-3.5-flash-lite", "gemini-3.6-flash", "gemini-3.7-flash",
      "gemini-flash-latest", "gemma-4-26b-a4b-it", "gemma-4-31b-it",
    ],
    defaultModel: "gemini-3.7-flash",
    retiredModels: [
      "gemini-1.5-flash", "gemini-1.5-flash-8b", "gemini-1.5-pro", "gemini-2.0-flash",
      "gemini-2.0-flash-lite", "gemini-2.5-flash-lite-preview-06-17",
      "gemini-2.5-flash-lite-preview-09-2025", "gemini-2.5-flash-preview-04-17",
      "gemini-2.5-flash-preview-05-20", "gemini-2.5-flash-preview-09-2025",
      "gemini-2.5-pro-preview-05-06", "gemini-2.5-pro-preview-06-05",
      "gemini-3-pro-preview", "gemini-3.1-flash-lite-preview",
    ],
    unmanagedModels: [
      "gemini-3-pro", "gemini-flash-lite-latest", "gemini-live-2.5-flash",
      "gemini-live-2.5-flash-preview-native-audio", "gemma-3-27b-it", "gemma-4-26b",
      "gemma-4-26b-it", "gemma-4-31b", "gemma-4-E2B-it", "gemma-4-E4B-it",
    ],
    modelContextWindows: {
      ...Object.fromEntries(GOOGLE_20261117_MODELS.map(id => [id, 1_048_576])),
      "gemini-2.5-flash": 1_048_576,
      "gemini-2.5-flash-lite": 1_048_576,
      "gemini-2.5-pro": 1_048_576,
      "gemini-3-flash-preview": 1_048_576,
      "gemini-3.1-flash-lite": 1_048_576,
      "gemini-3.1-pro-preview": 1_048_576,
      "gemini-3.1-pro-preview-customtools": 1_048_576,
      "gemini-3.5-flash": 1_048_576,
      "gemini-3.5-flash-lite": 1_048_576,
      "gemini-3.6-flash": 1_048_576,
      "gemini-3.7-flash": 1_048_576,
      "gemini-flash-latest": 1_048_576,
      "gemma-4-26b-a4b-it": 262_144,
      "gemma-4-31b-it": 262_144,
    },
    modelMaxOutputTokens: Object.fromEntries(
      [
        ...GOOGLE_20261117_MODELS,
        "gemini-2.5-flash", "gemini-2.5-flash-lite", "gemini-2.5-pro", "gemini-3-flash-preview",
        "gemini-3.1-flash-lite", "gemini-3.1-pro-preview", "gemini-3.1-pro-preview-customtools",
        "gemini-3.5-flash", "gemini-3.5-flash-lite", "gemini-3.6-flash", "gemini-3.7-flash", "gemini-flash-latest",
      ].map(id => [id, 65_536]),
    ),
    modelCapabilities: Object.fromEntries(
      [
        ...GOOGLE_20261117_MODELS,
        "gemini-2.5-flash", "gemini-2.5-flash-lite", "gemini-2.5-pro", "gemini-3-flash-preview",
        "gemini-3.1-flash-lite", "gemini-3.1-pro-preview", "gemini-3.1-pro-preview-customtools",
        "gemini-3.5-flash", "gemini-3.5-flash-lite", "gemini-3.6-flash", "gemini-3.7-flash", "gemini-flash-latest",
        "gemma-4-26b-a4b-it", "gemma-4-31b-it",
      ].map(id => [id, { input: ["text", "image"] } satisfies FrogModelCapabilities]),
    ),
    modelReasoningEfforts: {
      ...Object.fromEntries(
        [
          "gemini-2.5-flash", "gemini-2.5-flash-lite", "gemini-2.5-pro", "gemini-3-flash-preview",
          "gemini-3.1-pro-preview", "gemini-3.1-pro-preview-customtools", "gemini-3.5-flash",
          "gemini-3.5-flash-lite", "gemini-3.6-flash", "gemini-3.7-flash", "gemini-flash-latest",
        ].map(id => [id, ["low", "medium", "high"]]),
      ),
      "gemini-3.1-flash-lite": ["high"],
      "gemma-4-26b-a4b-it": ["high"],
      "gemma-4-31b-it": ["high"],
    },
    officialModelSources: [
      "https://ai.google.dev/gemini-api/docs/models",
      "https://ai.google.dev/gemini-api/docs/deprecations",
      "https://aistudio.google.com/docs/models/gemini-4-carbon",
      "https://aistudio.google.com/docs/models/gemini-4-argon",
      "https://aistudio.google.com/docs/models/gemini-4-hydrogen",
      "https://aistudio.google.com/docs/models/gemini-3.8-flash",
    ],
    verifiedJawcodeModels: [
      "gemini-2.5-flash", "gemini-2.5-flash-lite", "gemini-2.5-pro", "gemini-3-flash-preview",
      "gemini-3.1-flash-lite", "gemini-3.1-pro-preview", "gemini-3.1-pro-preview-customtools",
      "gemini-3.5-flash", "gemini-3.5-flash-lite", "gemini-3.6-flash", "gemini-3.7-flash", "gemini-flash-latest",
    ],
  },
  { id: "azure-openai", label: "Azure OpenAI", adapter: "azure-openai", baseUrl: "https://{resource}.openai.azure.com/openai", authKind: "key", featured: true, dashboardUrl: "https://portal.azure.com" },
  { id: "ollama", label: "Ollama (local)", adapter: "openai-chat", baseUrl: "http://localhost:11434/v1", authKind: "local", featured: true, note: "Local — key usually blank" },
  { id: "vllm", label: "vLLM (local)", adapter: "openai-chat", baseUrl: "http://localhost:8000/v1", authKind: "local", featured: true, note: "Local — key usually blank" },
  { id: "lm-studio", label: "LM Studio (local)", adapter: "openai-chat", baseUrl: "http://localhost:1234/v1", authKind: "local", featured: true, note: "Local — no key needed" },
  {
    id: "deepseek",
    label: "DeepSeek",
    baseUrl: "https://api.deepseek.com",
    adapter: "openai-chat",
    authKind: "key",
    dashboardUrl: "https://platform.deepseek.com/api_keys",
    models: ["deepseek-flash", "deepseek-v4-pro"],
    defaultModel: "deepseek-v4-pro",
    retiredModels: ["deepseek-chat", "deepseek-reasoner", "deepseek-v4-flash", "deepseek-v4-flash-vision-exp"],
    modelContextWindows: {
      "deepseek-v4-pro": 1_000_000,
    },
    modelMaxOutputTokens: {"deepseek-flash": 393216, "deepseek-v4-pro": 393216},
    modelCapabilities: {"deepseek-flash": {"input": ["text", "image"]}, "deepseek-v4-pro": {"input": ["text"]}},
    modelReasoningEfforts: {
      "deepseek-flash": ["low", "high", "xhigh"],
      "deepseek-v4-pro": ["low", "high", "xhigh"],
    },
    modelReasoningEffortMap: {
      "deepseek-flash": XHIGH_TO_MAX_REASONING_MAP,
      "deepseek-v4-pro": XHIGH_TO_MAX_REASONING_MAP,
    },
    noPenaltyModels: ["deepseek-flash", "deepseek-v4-pro"],
    preserveReasoningContentModels: ["deepseek-flash", "deepseek-v4-pro"],
    officialModelSources: [
      "https://api-docs.deepseek.com/quick_start/pricing/",
      "https://api-docs.deepseek.com/api/create-chat-completion/",
    ],
  },
  {
    id: "cerebras",
    label: "Cerebras",
    baseUrl: "https://api.cerebras.ai/v1",
    adapter: "openai-chat",
    authKind: "key",
    dashboardUrl: "https://cloud.cerebras.ai/platform/apikeys",
    models: ["gpt-oss-120b"],
    defaultModel: "gpt-oss-120b",
    retiredModels: ["llama-3.3-70b", "gemma-4-31b"],
    officialModelSources: [
      "https://inference-docs.cerebras.ai/models/overview.md",
      "https://inference-docs.cerebras.ai/support/deprecation",
    ],
    modelCapabilities: {"gpt-oss-120b": {"input": ["text"]}},
    modelReasoningEfforts: {"gpt-oss-120b": ["low", "medium", "high"]},
  },
  { id: "together", label: "Together", baseUrl: "https://api.together.xyz/v1", adapter: "openai-chat", authKind: "key", dashboardUrl: "https://api.together.xyz/settings/api-keys" },
  { id: "fireworks", label: "Fireworks", baseUrl: "https://api.fireworks.ai/inference/v1", adapter: "openai-chat", authKind: "key", dashboardUrl: "https://fireworks.ai/account/api-keys" },
  { id: "firepass", label: "Fire Pass (Fireworks Kimi)", baseUrl: "https://api.fireworks.ai/inference/v1", adapter: "openai-chat", authKind: "key", dashboardUrl: "https://fireworks.ai/account/api-keys" },
  {
    id: "moonshot",
    label: "Moonshot (Kimi API)",
    baseUrl: "https://api.moonshot.ai/v1",
    adapter: "openai-chat",
    authKind: "key",
    dashboardUrl: "https://platform.moonshot.ai/console/api-keys",
    defaultModel: "kimi-k2.7-code",
    jawcodeBundle: "moonshot",
    models: ["kimi-k3.1-pro", "kimi-k3.1-pro-highspeed", "kimi-k3", ...MOONSHOT_THINKING_MODELS],
    retiredModels: ["kimi-k2-0905-preview", "kimi-k2.5"],
    modelContextWindows: {
      "kimi-k3": 1_048_576,
      "kimi-k2.7-code": 262_144,
      "kimi-k2.7-code-highspeed": 262_144,
      "kimi-k2.6": 262_144,
      "kimi-k2.5": 262_144,
    },
    modelMaxOutputTokens: {
      "kimi-k3": 1_048_576,
      "kimi-k2.6": 262_144,
      "kimi-k2.5": 262_144,
    },
    modelCapabilities: Object.fromEntries(["kimi-k3.1-pro", "kimi-k3.1-pro-highspeed", "kimi-k3", ...MOONSHOT_THINKING_MODELS].map(id => [id, { input: ["text", "image"] } satisfies FrogModelCapabilities])),
    noReasoningModels: MOONSHOT_THINKING_MODELS,
    modelReasoningEfforts: { ...Object.fromEntries(["kimi-k3.1-pro", "kimi-k3.1-pro-highspeed", "kimi-k3"].map(id => [id, KIMI_K3_REASONING_EFFORTS])), ...Object.fromEntries(MOONSHOT_THINKING_MODELS.map(id => [id, []])) },
    modelReasoningEffortMap: Object.fromEntries(["kimi-k3.1-pro", "kimi-k3.1-pro-highspeed", "kimi-k3"].map(id => [id, XHIGH_TO_MAX_REASONING_MAP])),
    noTemperatureModels: ["kimi-k3.1-pro", "kimi-k3.1-pro-highspeed", ...MOONSHOT_LOCKED_PARAMETER_MODELS],
    noTopPModels: ["kimi-k3.1-pro", "kimi-k3.1-pro-highspeed", ...MOONSHOT_LOCKED_PARAMETER_MODELS],
    noPenaltyModels: ["kimi-k3.1-pro", "kimi-k3.1-pro-highspeed", ...MOONSHOT_LOCKED_PARAMETER_MODELS],
    autoToolChoiceOnlyModels: ["kimi-k2.6", "kimi-k2.7-code", "kimi-k2.7-code-highspeed"],
    preserveReasoningContentModels: ["kimi-k3.1-pro", "kimi-k3.1-pro-highspeed", "kimi-k3", ...MOONSHOT_THINKING_MODELS],
    officialModelSources: [
      "https://platform.kimi.ai/docs/models",
      "https://platform.kimi.ai/docs/guide/kimi-k3-quickstart",
    ],
    verifiedJawcodeModels: [],
  },
  { id: "huggingface", label: "Hugging Face", baseUrl: "https://router.huggingface.co/v1", adapter: "openai-chat", authKind: "key", dashboardUrl: "https://huggingface.co/settings/tokens" },
  { id: "nvidia", label: "NVIDIA NIM", baseUrl: "https://integrate.api.nvidia.com/v1", adapter: "openai-chat", authKind: "key", dashboardUrl: "https://build.nvidia.com" },
  { id: "venice", label: "Venice", baseUrl: "https://api.venice.ai/api/v1", adapter: "openai-chat", authKind: "key", dashboardUrl: "https://venice.ai/settings/api" },
  {
    id: "zai",
    label: "Z.AI — GLM Coding Plan",
    baseUrl: "https://api.z.ai/api/coding/paas/v4",
    adapter: "openai-chat",
    authKind: "key",
    dashboardUrl: "https://z.ai/manage-apikey/apikey-list",
    defaultModel: "glm-5.3",
    note: "GLM Coding Plan",
    minFrogprogsyVersion: "0.0.5",
    models: ["glm-5.3-flash", "glm-5.3", "glm-5.3[1m]", "glm-5.2", "glm-5.1", "glm-5", "glm-4.7", "glm-4.6"],
    unmanagedModels: ["glm-5.2[1m]"],
    modelContextWindows: { "glm-5.3-flash": 1_000_000, "glm-5.3": 1_000_000, "glm-5.3[1m]": 1_000_000, "glm-5.1": 204_800, "glm-5": 204_800, "glm-4.7": 204_800, "glm-4.6": 200_000 },
    modelMaxOutputTokens: Object.fromEntries(
      ["glm-5.3", "glm-5.3[1m]", "glm-5.2", "glm-5.1", "glm-5", "glm-4.7", "glm-4.6"]
        .map(id => [id, 131_072]),
    ),
    modelCapabilities: { ...textOnlyCapabilities(["glm-5.3", "glm-5.3[1m]", "glm-5.2", "glm-5.1", "glm-5", "glm-4.7", "glm-4.6"]), "glm-5.3-flash": { input: ["text", "image"] } },
    modelReasoningEfforts: {
      ...Object.fromEntries(ZAI_GLM_53_MODELS.map(id => [id, ZAI_GLM_53_REASONING_EFFORTS])),
      ...Object.fromEntries(ZAI_GLM_52_MODELS.map(id => [id, ZAI_GLM_52_REASONING_EFFORTS])),
    },
    modelReasoningEffortMap: {
      ...Object.fromEntries(ZAI_GLM_53_MODELS.map(id => [id, XHIGH_TO_MAX_REASONING_MAP])),
      ...Object.fromEntries(ZAI_GLM_52_MODELS.map(id => [id, ZAI_GLM_52_REASONING_MAP])),
    },
    preserveReasoningContentModels: ["glm-5.3-flash", "glm-5.3", "glm-5.3[1m]", "glm-5.2", "glm-5.1", "glm-5", "glm-4.7", "glm-4.6"],
    officialModelSources: [
      "https://docs.z.ai/devpack/latest-model",
      "https://docs.z.ai/devpack/using5.1",
    ],
  },
  { id: "nanogpt", label: "NanoGPT", baseUrl: "https://nano-gpt.com/api/v1", adapter: "openai-chat", authKind: "key", dashboardUrl: "https://nano-gpt.com/api" },
  { id: "synthetic", label: "Synthetic", baseUrl: "https://api.synthetic.new/openai/v1", adapter: "openai-chat", authKind: "key", dashboardUrl: "https://synthetic.new" },
  { id: "qwen-portal", label: "Qwen Portal", baseUrl: "https://portal.qwen.ai/v1", adapter: "openai-chat", authKind: "key", dashboardUrl: "https://portal.qwen.ai" },
  { id: "qianfan", label: "Qianfan (Baidu)", baseUrl: "https://qianfan.baidubce.com/v2", adapter: "openai-chat", authKind: "key", dashboardUrl: "https://console.bce.baidu.com/iam/#/iam/apikey/list" },
  { id: "alibaba", label: "Alibaba Coding Plan", baseUrl: "https://coding-intl.dashscope.aliyuncs.com/v1", adapter: "openai-chat", authKind: "key", dashboardUrl: "https://dashscope.console.aliyun.com/apiKey" },
  { id: "parallel", label: "Parallel", baseUrl: "https://platform.parallel.ai", adapter: "openai-chat", authKind: "key", dashboardUrl: "https://platform.parallel.ai" },
  { id: "zenmux", label: "ZenMux", baseUrl: "https://zenmux.ai/api/v1", adapter: "openai-chat", authKind: "key", dashboardUrl: "https://zenmux.ai" },
  { id: "litellm", label: "LiteLLM (self-hosted)", baseUrl: "http://localhost:4000/v1", adapter: "openai-chat", authKind: "key", dashboardUrl: "https://docs.litellm.ai/docs/proxy/quick_start" },
  {
    id: "ollama-cloud",
    label: "Ollama Cloud",
    baseUrl: "https://ollama.com/v1",
    adapter: "openai-chat",
    authKind: "key",
    dashboardUrl: "https://ollama.com/settings/keys",
    minFrogprogsyVersion: "0.0.5",
    models: ["beam", "deepseek-v4-pro:0813", "deepseek-v4.1-flash", "deepseek-v4.1-flash:1017", "gemma4:31b", "glm-5.2", "glm-5.3", "glm-5.3-flash", "gpt-oss:120b", "gpt-oss:20b", "inkling-2-small", "kimi-k2.6", "kimi-k2.7-code", "kimi-k3", "kimi-k3.1-pro", "mimo-v2.6-flash", "mimo-v2.6-pro", "minimax-m3", "minimax-m3.1-flash", "mistral-large-4", "muse-spark-open", "nemotron-3-super", "nemotron-3-ultra"],
    defaultModel: "glm-5.2",
    unmanagedModels: ["deepseek-v4-flash:0731", "deepseek-v4-flash:preview", "deepseek-v4-pro", "deepseek-v4-pro:preview", "gemma4", "glm-5.1", "minimax-m2.7", "mistral-large-3:675b", "nemotron-3-nano:30b", "qwen3-coder", "qwen3.5", "qwen3.5:397b"],
    modelCapabilities: {
      "beam": {
        "input": [
          "text"
        ]
      },
      "deepseek-v4-pro:0813": {
        "input": [
          "text"
        ]
      },
      "deepseek-v4.1-flash": {
        "input": [
          "text",
          "image"
        ]
      },
      "deepseek-v4.1-flash:1017": {
        "input": [
          "text",
          "image"
        ]
      },
      "gemma4:31b": {
        "input": [
          "text",
          "image"
        ]
      },
      "glm-5.2": {
        "input": [
          "text"
        ]
      },
      "glm-5.3": {
        "input": [
          "text"
        ]
      },
      "glm-5.3-flash": {
        "input": [
          "text",
          "image"
        ]
      },
      "gpt-oss:120b": {
        "input": [
          "text"
        ]
      },
      "gpt-oss:20b": {
        "input": [
          "text"
        ]
      },
      "inkling-2-small": {
        "input": [
          "text",
          "image"
        ]
      },
      "kimi-k2.6": {
        "input": [
          "text",
          "image"
        ]
      },
      "kimi-k2.7-code": {
        "input": [
          "text",
          "image"
        ]
      },
      "kimi-k3": {
        "input": [
          "text",
          "image"
        ]
      },
      "kimi-k3.1-pro": {
        "input": [
          "text",
          "image"
        ]
      },
      "mimo-v2.6-flash": {
        "input": [
          "text",
          "image"
        ]
      },
      "mimo-v2.6-pro": {
        "input": [
          "text",
          "image"
        ]
      },
      "minimax-m3": {
        "input": [
          "text",
          "image"
        ]
      },
      "minimax-m3.1-flash": {
        "input": [
          "text",
          "image"
        ]
      },
      "mistral-large-4": {
        "input": [
          "text",
          "image"
        ]
      },
      "muse-spark-open": {
        "input": [
          "text",
          "image"
        ]
      },
      "nemotron-3-super": {
        "input": [
          "text"
        ]
      },
      "nemotron-3-ultra": {
        "input": [
          "text"
        ]
      }
    },
    officialModelSources: [
      "https://ollama.com/v1/models",
      "https://ollama.com/api/tags",
    ],
    modelContextWindows: {
      "beam": 1048576,
      "deepseek-v4-pro:0813": 1048576,
      "deepseek-v4.1-flash": 1048576,
      "deepseek-v4.1-flash:1017": 1048576,
      "gemma4:31b": 262144,
      "glm-5.2": 1048576,
      "glm-5.3": 1048576,
      "glm-5.3-flash": 1048576,
      "gpt-oss:120b": 131072,
      "gpt-oss:20b": 131072,
      "inkling-2-small": 1048576,
      "kimi-k2.6": 262144,
      "kimi-k2.7-code": 262144,
      "kimi-k3": 1048576,
      "kimi-k3.1-pro": 1048576,
      "mimo-v2.6-flash": 1048576,
      "mimo-v2.6-pro": 1048576,
      "minimax-m3": 512000,
      "minimax-m3.1-flash": 1000000,
      "mistral-large-4": 1048576,
      "muse-spark-open": 1048576,
      "nemotron-3-super": 262144,
      "nemotron-3-ultra": 262144
    },
  },
  {
    id: "mistral",
    label: "Mistral",
    baseUrl: "https://api.mistral.ai/v1",
    adapter: "openai-chat",
    authKind: "key",
    dashboardUrl: "https://console.mistral.ai/api-keys",
    models: ["codestral-latest", "codestral-2508", "mistral-large-4", "zai-glm-5-3", "zai-glm-5-3-flash", "deepseek-v4-1-flash-1017"],
    defaultModel: "codestral-latest",
    modelContextWindows: { "codestral-latest": 128_000, "codestral-2508": 128_000 },
    officialModelSources: ["https://docs.mistral.ai/models/codestral-25-08", "https://docs.mistral.ai/models/mistral-large-4-0", "https://docs.mistral.ai/models/zai-glm-5-3", "https://docs.mistral.ai/models/zai-glm-5-3-flash", "https://docs.mistral.ai/models/deepseek-v4-flash-1017"],
    modelCapabilities: {
      "mistral-large-4": {
        "input": [
          "text",
          "image"
        ]
      },
      "zai-glm-5-3": {
        "input": [
          "text"
        ]
      },
      "zai-glm-5-3-flash": {
        "input": [
          "text",
          "image"
        ]
      },
      "deepseek-v4-1-flash-1017": {
        "input": [
          "text",
          "image"
        ]
      }
    },
    note: "DeepSeek V4.1 Flash 1017 is a public preview.",
  },
  {
    id: "minimax",
    label: "MiniMax — Coding Plan",
    baseUrl: "https://api.minimax.io/v1",
    adapter: "openai-chat",
    authKind: "key",
    dashboardUrl: "https://platform.minimax.io",
    defaultModel: "MiniMax-M3",
    jawcodeBundle: "minimax",
    minFrogprogsyVersion: "0.0.5",
    models: ["MiniMax-M3.1-Flash", "MiniMax-M3", "MiniMax-M2.7", "MiniMax-M2.7-highspeed"],
    retiredModels: ["MiniMax-M2", "MiniMax-M2.1", "MiniMax-M2.1-highspeed"],
    unmanagedModels: ["MiniMax-M2.5", "MiniMax-M2.5-highspeed", "MiniMax-M2.5-lightning", "minimax-m3"],
    modelContextWindows: {"MiniMax-M3.1-Flash": 1000000, "MiniMax-M3": 1000000, "MiniMax-M2.7": 204800, "MiniMax-M2.7-highspeed": 204800},
    modelMaxOutputTokens: { "MiniMax-M3": 524_288, "MiniMax-M2.7": 204_800, "MiniMax-M2.7-highspeed": 204_800 },
    modelCapabilities: {
      "MiniMax-M3.1-Flash": {
        "input": [
          "text",
          "image"
        ]
      },
      "MiniMax-M3": {
        "input": [
          "text",
          "image"
        ]
      },
      "MiniMax-M2.7": {
        "input": [
          "text"
        ]
      },
      "MiniMax-M2.7-highspeed": {
        "input": [
          "text"
        ]
      }
    },
    noReasoningModels: ["MiniMax-M3", "MiniMax-M2.7", "MiniMax-M2.7-highspeed"],
    modelReasoningEfforts: {"MiniMax-M3.1-Flash": ["low", "medium", "high", "xhigh"], "MiniMax-M3": [], "MiniMax-M2.7": [], "MiniMax-M2.7-highspeed": []},
    noPenaltyModels: ["MiniMax-M3.1-Flash", "MiniMax-M3", "MiniMax-M2.7", "MiniMax-M2.7-highspeed"],
    metadataModelIdNormalize: "case-insensitive",
    note: "Subscription Key or API Key",
    officialModelSources: [
      "https://platform.minimax.io/docs/guides/models-intro",
      "https://platform.minimax.io/docs/api-reference/text-openai-api",
    ],
    verifiedJawcodeModels: ["MiniMax-M3", "MiniMax-M2.7", "MiniMax-M2.7-highspeed"],
    noTemperatureModels: ["MiniMax-M3.1-Flash", "MiniMax-M3"],
    noTopPModels: ["MiniMax-M3.1-Flash", "MiniMax-M3"],
    preserveReasoningContentModels: ["MiniMax-M3.1-Flash", "MiniMax-M3", "MiniMax-M2.7", "MiniMax-M2.7-highspeed"],
  },
  {
    id: "minimax-cn",
    label: "MiniMax — Coding Plan (CN)",
    baseUrl: "https://api.minimaxi.com/v1",
    adapter: "openai-chat",
    authKind: "key",
    dashboardUrl: "https://platform.minimaxi.com",
    defaultModel: "MiniMax-M3",
    jawcodeBundle: "minimax",
    minFrogprogsyVersion: "0.0.5",
    models: ["MiniMax-M3", "MiniMax-M2.7", "MiniMax-M2.7-highspeed"],
    retiredModels: ["MiniMax-M2", "MiniMax-M2.1", "MiniMax-M2.1-highspeed", "MiniMax-M2.5", "MiniMax-M2.5-highspeed"],
    unmanagedModels: ["MiniMax-M2.5-lightning", "minimax-m3"],
    modelContextWindows: { "MiniMax-M3": 1_000_000, "MiniMax-M2.7": 204_800, "MiniMax-M2.7-highspeed": 204_800 },
    modelMaxOutputTokens: { "MiniMax-M3": 524_288, "MiniMax-M2.7": 204_800, "MiniMax-M2.7-highspeed": 204_800 },
    modelCapabilities: {
      "MiniMax-M3": { input: ["text", "image"] },
      "MiniMax-M2.7": { input: ["text"] },
      "MiniMax-M2.7-highspeed": { input: ["text"] },
    },
    noReasoningModels: ["MiniMax-M3", "MiniMax-M2.7", "MiniMax-M2.7-highspeed"],
    modelReasoningEfforts: { "MiniMax-M3": [], "MiniMax-M2.7": [], "MiniMax-M2.7-highspeed": [] },
    noPenaltyModels: ["MiniMax-M3", "MiniMax-M2.7", "MiniMax-M2.7-highspeed"],
    metadataModelIdNormalize: "case-insensitive",
    note: "中国区 Subscription Key",
    officialModelSources: [
      "https://platform.minimaxi.com/docs/guides/models-intro",
      "https://platform.minimaxi.com/docs/api-reference/text-openai-api",
    ],
    verifiedJawcodeModels: ["MiniMax-M3", "MiniMax-M2.7", "MiniMax-M2.7-highspeed"],
  },
  {
    id: "kimi-code",
    label: "Kimi (coding)",
    baseUrl: "https://api.kimi.com/coding/v1",
    adapter: "openai-chat",
    authKind: "key",
    dashboardUrl: "https://platform.kimi.ai",
    defaultModel: "k3",
    models: KIMI_CODE_MODELS,
    modelContextWindows: Object.fromEntries(KIMI_CODE_MODELS.map(id => [id, id === "k3-256k" || id === "kimi-for-coding-highspeed" ? 262_144 : 1_048_576])),
    modelCapabilities: Object.fromEntries(
      KIMI_CODE_MODELS.map(id => [id, { input: ["text", "image"] } satisfies FrogModelCapabilities]),
    ),
    modelReasoningEfforts: {
      ...Object.fromEntries(KIMI_CODE_REASONING_EFFORT_MODELS.map(id => [id, KIMI_K3_REASONING_EFFORTS])),
      ...Object.fromEntries(KIMI_CODE_NO_EFFORT_MODELS.map(id => [id, []])),
    },
    modelReasoningEffortMap: Object.fromEntries(
      KIMI_CODE_REASONING_EFFORT_MODELS.map(id => [id, XHIGH_TO_MAX_REASONING_MAP]),
    ),
    noReasoningModels: KIMI_CODE_NO_EFFORT_MODELS,
    preserveReasoningContentModels: KIMI_CODE_MODELS,
    officialModelSources: ["https://www.kimi.com/code/docs/en/kimi-code/models.html"],
    note: "Kimi Code model access and 1M context depend on the account plan.",
  },
  { id: "opencode-zen", label: "opencode zen", baseUrl: "https://opencode.ai/zen/v1", adapter: "openai-chat", authKind: "key", dashboardUrl: "https://opencode.ai/auth" },
  { id: "vercel-ai-gateway", label: "Vercel AI Gateway", baseUrl: "https://ai-gateway.vercel.sh/v1", adapter: "openai-chat", authKind: "key", dashboardUrl: "https://vercel.com/dashboard" },
  {
    id: "xiaomi",
    label: "Xiaomi MiMo",
    baseUrl: "https://api.xiaomimimo.com/anthropic",
    adapter: "anthropic",
    authKind: "key",
    dashboardUrl: "https://xiaomimimo.com",
    models: ["mimo-v2.6-pro", "mimo-v2.6-flash"],
    defaultModel: "mimo-v2.6-pro",
    modelContextWindows: {},
    modelCapabilities: {"mimo-v2.6-pro": {"input": ["text", "image"]}, "mimo-v2.6-flash": {"input": ["text", "image"]}},
    officialModelSources: ["https://mimo.mi.com/docs/en-US/api/chat/anthropic-api-post", "https://mimo.mi.com/docs/en-US/quick-start/summary/model", "https://mimo.mi.com/docs/en-US/updates/deprecate"],
    retiredModels: ["mimo-v2.5-pro", "mimo-v2.5"],
    autoToolChoiceOnlyModels: ["mimo-v2.6-pro", "mimo-v2.6-flash"],
  },
  { id: "kilo", label: "Kilo", baseUrl: "https://api.kilo.ai/api/gateway", adapter: "openai-chat", authKind: "key", dashboardUrl: "https://kilo.ai" },
  { id: "cloudflare-ai-gateway", label: "Cloudflare AI Gateway", baseUrl: "https://gateway.ai.cloudflare.com/v1/{account-id}/{gateway}/anthropic", adapter: "anthropic", authKind: "key", dashboardUrl: "https://dash.cloudflare.com/?to=/:account/ai/ai-gateway" },
  { id: "github-copilot", label: "GitHub Copilot", baseUrl: "https://api.githubcopilot.com", adapter: "openai-chat", authKind: "key", dashboardUrl: "https://github.com/settings/copilot" },
  { id: "gitlab-duo", label: "GitLab Duo", baseUrl: "https://cloud.gitlab.com/ai/v1/proxy/openai/v1", adapter: "openai-chat", authKind: "key", dashboardUrl: "https://gitlab.com/-/user_settings/personal_access_tokens" },
];

export function getProviderRegistryEntry(id: string): ProviderRegistryEntry | undefined {
  return PROVIDER_REGISTRY.find(entry => entry.id === id);
}

export function providerUserSeedFromRegistry(catalogProviderId: string): FrogProviderConfig {
  const entry = getProviderRegistryEntry(catalogProviderId);
  if (!entry) {
    throw new Error(`Unknown provider registry entry: ${catalogProviderId}`);
  }
  return {
    adapter: entry.adapter,
    baseUrl: entry.baseUrl,
    ...(entry.authKind !== "local" ? { authMode: entry.authKind } : {}),
    catalogProviderId: entry.id,
    ...(entry.defaultModel ? { defaultModel: entry.defaultModel } : {}),
  };
}

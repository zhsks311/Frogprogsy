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

function textOnlyCapabilities(ids: readonly string[]): Record<string, FrogModelCapabilities> {
  return Object.fromEntries(ids.map(id => [id, { input: ["text"] } satisfies FrogModelCapabilities]));
}



const XHIGH_TO_MAX_REASONING_MAP: Record<string, string> = { xhigh: "max", max: "max" };
const ZAI_GLM_52_MODELS = ["glm-5.2"];
const ZAI_GLM_53_MODELS = ["glm-5.3", "glm-5.3[1m]"];
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
const KIMI_CODE_MODELS = ["k3", "k3-256k", "kimi-for-coding", "kimi-for-coding-highspeed"];
const KIMI_CODE_REASONING_EFFORT_MODELS = ["k3", "k3-256k"];
const KIMI_CODE_NO_EFFORT_MODELS = ["kimi-for-coding", "kimi-for-coding-highspeed"];
const MOONSHOT_THINKING_MODELS = ["kimi-k2.7-code", "kimi-k2.7-code-highspeed", "kimi-k2.6", "kimi-k2.5"];
const MOONSHOT_LOCKED_PARAMETER_MODELS = ["kimi-k3", ...MOONSHOT_THINKING_MODELS];
const KIMI_K3_REASONING_EFFORTS = ["low", "high", "xhigh"];
const NEURALWATT_REASONING_HISTORY_MODELS = [
  "deepseek-v4-flash",
  "glm-5.2", "glm-5.2-fast", "glm-5.2-short", "glm-5.2-short-fast",
  "gemma-4-31b",
  "kimi-k2.7-code", "kimi-k2.7-code-fast", "kimi-k3",
  "qwen3.6-35b",
];
const UMANS_MODELS = [
  "umans-kimi-k3",
  "umans-coder",
  "umans-glm-5.2",
  "umans-deepseek-v4-flash-0731",
  "umans-deepseek-v4-pro-0813",
  "umans-flash",
  "umans-qwen3.6-35b-a3b",
];
const UMANS_REASONING_EFFORTS = ["low", "medium", "high", "xhigh"];
const UMANS_GLM_REASONING_EFFORTS = ["high", "xhigh"];
const UMANS_GLM_REASONING_MAP: Record<string, string> = {
  none: "high",
  minimal: "high",
  low: "high",
  medium: "high",
  high: "high",
  xhigh: "max",
  max: "max",
};
const UMANS_TEXT_ONLY_MODELS = ["umans-deepseek-v4-flash-0731", "umans-deepseek-v4-pro-0813"];
const UMANS_MODEL_CONTEXT_WINDOWS: Record<string, number> = {
  "umans-kimi-k3": 1_048_576,
  "umans-coder": 262_144,
  "umans-glm-5.2": 405_504,
  "umans-deepseek-v4-flash-0731": 1_048_576,
  "umans-deepseek-v4-pro-0813": 1_048_576,
  "umans-flash": 262_144,
  "umans-qwen3.6-35b-a3b": 262_144,
};
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
      "gpt-5.6-sol",
      "gpt-5.6-terra",
      "gpt-5.6-luna",
      "gpt-5.5",
      "gpt-5.4",
      "gpt-5.4-mini",
      "gpt-5.3-codex-spark",
    ],
    defaultModel: "gpt-5.6-sol",
    modelContextWindows: {
      "gpt-5.6-sol": 872_000,
      "gpt-5.6-terra": 872_000,
      "gpt-5.6-luna": 872_000,
      "gpt-5.5": 272_000,
      "gpt-5.4": 1_000_000,
      "gpt-5.4-mini": 272_000,
      "gpt-5.3-codex-spark": 128_000,
    },
    modelCapabilities: {
      ...Object.fromEntries(
        ["gpt-5.6-sol", "gpt-5.6-terra", "gpt-5.6-luna", "gpt-5.5", "gpt-5.4", "gpt-5.4-mini"]
          .map(id => [id, { input: ["text", "image"] } satisfies FrogModelCapabilities]),
      ),
      "gpt-5.3-codex-spark": { input: ["text"] },
    },
    reasoningEfforts: ["low", "medium", "high", "xhigh"],
    officialModelSources: [
      "https://developers.openai.com/codex/models",
      "https://developers.openai.com/api/docs/models",
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
      ...["claude-fable-5", "claude-opus-5", "claude-sonnet-5", "claude-opus-4-8", "claude-opus-4-7", "claude-opus-4-6", "claude-sonnet-4-6"]
        .map(id => [id, 1_000_000]),
      ...["claude-sonnet-4-5", "claude-sonnet-4-5-20250929", "claude-opus-4-5", "claude-opus-4-5-20251101", "claude-haiku-4-5", "claude-haiku-4-5-20251001"]
        .map(id => [id, 200_000]),
    ]),
    modelMaxOutputTokens: Object.fromEntries([
      ...["claude-fable-5", "claude-opus-5", "claude-sonnet-5", "claude-opus-4-8", "claude-opus-4-7", "claude-opus-4-6", "claude-sonnet-4-6"]
        .map(id => [id, 128_000]),
      ...["claude-sonnet-4-5", "claude-sonnet-4-5-20250929", "claude-opus-4-5", "claude-opus-4-5-20251101", "claude-haiku-4-5", "claude-haiku-4-5-20251001"]
        .map(id => [id, 64_000]),
    ]),
    modelCapabilities: Object.fromEntries(
      [
        "claude-fable-5", "claude-opus-5", "claude-sonnet-5", "claude-opus-4-8", "claude-opus-4-7",
        "claude-opus-4-6", "claude-sonnet-4-6", "claude-sonnet-4-5", "claude-sonnet-4-5-20250929",
        "claude-opus-4-5", "claude-opus-4-5-20251101", "claude-haiku-4-5", "claude-haiku-4-5-20251001",
      ].map(id => [id, { input: ["text", "image"] } satisfies FrogModelCapabilities]),
    ),
    noTemperatureModels: ["claude-fable-5", "claude-opus-5", "claude-sonnet-5", "claude-opus-4-8", "claude-opus-4-7"],
    noTopPModels: ["claude-fable-5", "claude-opus-5", "claude-sonnet-5", "claude-opus-4-8", "claude-opus-4-7"],
    officialModelSources: [
      "https://platform.claude.com/docs/en/about-claude/models/overview",
      "https://platform.claude.com/docs/en/about-claude/model-deprecations",
    ],
    verifiedJawcodeModels: [
      "claude-fable-5", "claude-opus-5", "claude-sonnet-5", "claude-opus-4-8", "claude-opus-4-7",
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
    note: "Log in with your Kimi account",
    models: KIMI_CODE_MODELS,
    defaultModel: "k3",
    modelContextWindows: Object.fromEntries(KIMI_CODE_MODELS.map(id => [id, 262_144])),
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
    models: ["gpt-5.5"],
    defaultModel: "gpt-5.5",
    modelContextWindows: { "gpt-5.5": 1_050_000 },
    modelMaxOutputTokens: { "gpt-5.5": 128_000 },
    modelCapabilities: { "gpt-5.5": { input: ["text", "image"] } },
    modelReasoningEfforts: { "gpt-5.5": ["low", "medium", "high", "xhigh"] },
    officialModelSources: ["https://developers.openai.com/api/docs/models/gpt-5.5"],
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
    retiredModels: ["umans-kimi-k2.7"],
    unmanagedModels: ["umans-kimi-k2.6", "umans-glm-5.1"],
    modelContextWindows: UMANS_MODEL_CONTEXT_WINDOWS,
    modelMaxOutputTokens: {
      "umans-kimi-k3": 131_072,
      "umans-coder": 262_144,
      "umans-glm-5.2": 131_072,
      "umans-deepseek-v4-flash-0731": 393_216,
      "umans-deepseek-v4-pro-0813": 393_216,
      "umans-flash": 262_144,
      "umans-qwen3.6-35b-a3b": 262_144,
    },
    modelCapabilities: UMANS_MODEL_CAPABILITIES,
    note: "Coding plan via Anthropic Messages",
    modelReasoningEfforts: {
      "umans-kimi-k3": ["low", "high", "xhigh"],
      "umans-coder": UMANS_REASONING_EFFORTS,
      "umans-glm-5.2": UMANS_GLM_REASONING_EFFORTS,
      "umans-deepseek-v4-flash-0731": ["low", "high", "xhigh"],
      "umans-deepseek-v4-pro-0813": ["high", "xhigh"],
      "umans-flash": ["low", "medium", "high"],
      "umans-qwen3.6-35b-a3b": ["low", "medium", "high"],
    },
    modelReasoningEffortMap: {
      "umans-kimi-k3": XHIGH_TO_MAX_REASONING_MAP,
      "umans-glm-5.2": UMANS_GLM_REASONING_MAP,
      "umans-deepseek-v4-flash-0731": XHIGH_TO_MAX_REASONING_MAP,
      "umans-deepseek-v4-pro-0813": XHIGH_TO_MAX_REASONING_MAP,
    },
    noTemperatureModels: ["umans-kimi-k3"],
    noTopPModels: ["umans-kimi-k3"],
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
    models: [
      "deepseek-v4-flash",
      "glm-5.2", "glm-5.2-fast", "glm-5.2-short", "glm-5.2-short-fast",
      "gemma-4-31b",
      "kimi-k2.7-code", "kimi-k2.7-code-fast", "kimi-k3", "kimi-k3-fast",
      "qwen3.6-35b", "qwen3.6-35b-fast",
    ],
    minFrogprogsyVersion: "0.0.5",
    unmanagedModels: [
      "moonshotai/Kimi-K2.5",
      "kimi-k2.5-fast",
      "kimi-k2.6",
      "kimi-k2.6-fast",
      "qwen3.5-397b",
      "qwen3.5-397b-fast",
    ],
    // Neuralwatt's /v1/models metadata is authoritative; these static hints are the offline fallback.
    modelContextWindows: {
      "deepseek-v4-flash": 1_048_560,
      "glm-5.2": 1_048_560,
      "glm-5.2-fast": 1_048_560,
      "glm-5.2-short": 199_984,
      "glm-5.2-short-fast": 199_984,
      "gemma-4-31b": 262_128,
      "kimi-k2.7-code": 262_128,
      "kimi-k2.7-code-fast": 262_128,
      "kimi-k3": 1_048_560,
      "kimi-k3-fast": 1_048_560,
      "qwen3.6-35b": 131_056,
      "qwen3.6-35b-fast": 131_056,
    },
    modelMaxOutputTokens: {
      "deepseek-v4-flash": 65_536,
      "glm-5.2-short": 32_000,
      "glm-5.2-short-fast": 32_000,
      "gemma-4-31b": 16_384,
    },
    modelReasoningEfforts: {
      "deepseek-v4-flash": ["low", "high", "xhigh"],
      "glm-5.2": ZAI_GLM_52_REASONING_EFFORTS,
      "glm-5.2-fast": ZAI_GLM_52_REASONING_EFFORTS,
      "glm-5.2-short": ZAI_GLM_52_REASONING_EFFORTS,
      "glm-5.2-short-fast": ZAI_GLM_52_REASONING_EFFORTS,
      "gemma-4-31b": ["xhigh"],
      "kimi-k2.7-code": [],
      "kimi-k2.7-code-fast": [],
      "kimi-k3": KIMI_K3_REASONING_EFFORTS,
      "kimi-k3-fast": [],
      "qwen3.6-35b": ["high"],
      "qwen3.6-35b-fast": [],
    },
    modelReasoningEffortMap: {
      "deepseek-v4-flash": XHIGH_TO_MAX_REASONING_MAP,
      "glm-5.2": ZAI_GLM_52_REASONING_MAP,
      "glm-5.2-fast": ZAI_GLM_52_REASONING_MAP,
      "glm-5.2-short": ZAI_GLM_52_REASONING_MAP,
      "glm-5.2-short-fast": ZAI_GLM_52_REASONING_MAP,
      "gemma-4-31b": XHIGH_TO_MAX_REASONING_MAP,
      "kimi-k3": XHIGH_TO_MAX_REASONING_MAP,
    },
    noReasoningModels: ["kimi-k3-fast", "qwen3.6-35b-fast"],
    modelCapabilities: {
      ...textOnlyCapabilities([
        "deepseek-v4-flash",
        "glm-5.2", "glm-5.2-fast", "glm-5.2-short", "glm-5.2-short-fast",
      ]),
      ...Object.fromEntries(
        ["gemma-4-31b", "kimi-k2.7-code", "kimi-k2.7-code-fast", "kimi-k3", "kimi-k3-fast", "qwen3.6-35b", "qwen3.6-35b-fast"]
          .map(id => [id, { input: ["text", "image"] } satisfies FrogModelCapabilities]),
      ),
    },
    preserveReasoningContentModels: NEURALWATT_REASONING_HISTORY_MODELS,
    officialModelSources: [
      "https://api.neuralwatt.com/v1/models",
      "https://portal.neuralwatt.com/docs/api/models",
    ],
  },
  { id: "openrouter", label: "OpenRouter", adapter: "openai-chat", baseUrl: "https://openrouter.ai/api/v1", authKind: "key", featured: true, dashboardUrl: "https://openrouter.ai/keys", jawcodeBundle: "openrouter" },
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
        "gemini-2.5-flash", "gemini-2.5-flash-lite", "gemini-2.5-pro", "gemini-3-flash-preview",
        "gemini-3.1-flash-lite", "gemini-3.1-pro-preview", "gemini-3.1-pro-preview-customtools",
        "gemini-3.5-flash", "gemini-3.5-flash-lite", "gemini-3.6-flash", "gemini-3.7-flash", "gemini-flash-latest",
      ].map(id => [id, 65_536]),
    ),
    modelCapabilities: Object.fromEntries(
      [
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
    models: ["deepseek-v4-flash", "deepseek-v4-pro"],
    defaultModel: "deepseek-v4-pro",
    retiredModels: ["deepseek-chat", "deepseek-reasoner"],
    modelContextWindows: {
      "deepseek-v4-flash": 1_000_000,
      "deepseek-v4-pro": 1_000_000,
    },
    modelMaxOutputTokens: { "deepseek-v4-flash": 384_000, "deepseek-v4-pro": 384_000 },
    modelCapabilities: textOnlyCapabilities(["deepseek-v4-flash", "deepseek-v4-pro"]),
    modelReasoningEfforts: {
      "deepseek-v4-flash": ["low", "high", "xhigh"],
      "deepseek-v4-pro": ["low", "high", "xhigh"],
    },
    modelReasoningEffortMap: {
      "deepseek-v4-flash": XHIGH_TO_MAX_REASONING_MAP,
      "deepseek-v4-pro": XHIGH_TO_MAX_REASONING_MAP,
    },
    noPenaltyModels: ["deepseek-v4-flash", "deepseek-v4-pro"],
    preserveReasoningContentModels: ["deepseek-v4-flash", "deepseek-v4-pro"],
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
    models: ["gpt-oss-120b", "gemma-4-31b"],
    defaultModel: "gpt-oss-120b",
    retiredModels: ["llama-3.3-70b"],
    officialModelSources: [
      "https://inference-docs.cerebras.ai/models/overview.md",
      "https://inference-docs.cerebras.ai/support/deprecation",
    ],
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
    models: ["kimi-k3", ...MOONSHOT_THINKING_MODELS],
    retiredModels: ["kimi-k2-0905-preview"],
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
    modelCapabilities: Object.fromEntries(
      ["kimi-k3", ...MOONSHOT_THINKING_MODELS]
        .map(id => [id, { input: ["text", "image"] } satisfies FrogModelCapabilities]),
    ),
    noReasoningModels: MOONSHOT_THINKING_MODELS,
    modelReasoningEfforts: {
      "kimi-k3": KIMI_K3_REASONING_EFFORTS,
      ...Object.fromEntries(MOONSHOT_THINKING_MODELS.map(id => [id, []])),
    },
    modelReasoningEffortMap: { "kimi-k3": XHIGH_TO_MAX_REASONING_MAP },
    noTemperatureModels: MOONSHOT_LOCKED_PARAMETER_MODELS,
    noTopPModels: MOONSHOT_LOCKED_PARAMETER_MODELS,
    noPenaltyModels: MOONSHOT_LOCKED_PARAMETER_MODELS,
    autoToolChoiceOnlyModels: ["kimi-k2.7-code", "kimi-k2.7-code-highspeed"],
    preserveReasoningContentModels: ["kimi-k3", ...MOONSHOT_THINKING_MODELS],
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
    models: ["glm-5.3", "glm-5.3[1m]", "glm-5.2", "glm-5.1", "glm-5", "glm-4.7", "glm-4.6"],
    unmanagedModels: ["glm-5.2[1m]"],
    modelContextWindows: {
      "glm-5.3[1m]": 1_000_000,
      "glm-5.1": 204_800,
      "glm-5": 204_800,
      "glm-4.7": 204_800,
      "glm-4.6": 200_000,
    },
    modelMaxOutputTokens: Object.fromEntries(
      ["glm-5.3", "glm-5.3[1m]", "glm-5.2", "glm-5.1", "glm-5", "glm-4.7", "glm-4.6"]
        .map(id => [id, 131_072]),
    ),
    modelCapabilities: textOnlyCapabilities(["glm-5.3", "glm-5.3[1m]", "glm-5.2", "glm-5.1", "glm-5", "glm-4.7", "glm-4.6"]),
    modelReasoningEfforts: {
      ...Object.fromEntries(ZAI_GLM_53_MODELS.map(id => [id, ZAI_GLM_53_REASONING_EFFORTS])),
      ...Object.fromEntries(ZAI_GLM_52_MODELS.map(id => [id, ZAI_GLM_52_REASONING_EFFORTS])),
    },
    modelReasoningEffortMap: {
      ...Object.fromEntries(ZAI_GLM_53_MODELS.map(id => [id, XHIGH_TO_MAX_REASONING_MAP])),
      ...Object.fromEntries(ZAI_GLM_52_MODELS.map(id => [id, ZAI_GLM_52_REASONING_MAP])),
    },
    preserveReasoningContentModels: ["glm-5.3", "glm-5.3[1m]", "glm-5.2", "glm-5.1", "glm-5", "glm-4.7", "glm-4.6"],
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
    models: [
      "glm-5.2", "kimi-k2.7-code", "deepseek-v4-pro:0813", "gpt-oss:120b", "kimi-k2.6",
      "deepseek-v4-flash:0731", "gpt-oss:20b", "qwen3.5:397b", "nemotron-3-ultra",
      "deepseek-v4-pro:preview", "gemma4:31b", "minimax-m3", "nemotron-3-super", "kimi-k3",
      "minimax-m2.7", "mistral-large-3:675b", "glm-5.1", "deepseek-v4-flash:preview",
      "nemotron-3-nano:30b",
    ],
    defaultModel: "glm-5.2",
    unmanagedModels: ["deepseek-v4-pro", "qwen3-coder", "qwen3.5", "gemma4"],
    modelCapabilities: {
      "kimi-k2.6": { input: ["text", "image"] },
      "minimax-m3": { input: ["text", "image"] },
    },
    officialModelSources: [
      "https://ollama.com/v1/models",
      "https://ollama.com/api/tags",
    ],
  },
  {
    id: "mistral",
    label: "Mistral",
    baseUrl: "https://api.mistral.ai/v1",
    adapter: "openai-chat",
    authKind: "key",
    dashboardUrl: "https://console.mistral.ai/api-keys",
    models: ["codestral-latest", "codestral-2508"],
    defaultModel: "codestral-latest",
    modelContextWindows: { "codestral-latest": 128_000, "codestral-2508": 128_000 },
    officialModelSources: ["https://docs.mistral.ai/models/codestral-25-08"],
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
    note: "Subscription Key or API Key",
    officialModelSources: [
      "https://platform.minimax.io/docs/guides/models-intro",
      "https://platform.minimax.io/docs/api-reference/text-openai-api",
    ],
    verifiedJawcodeModels: ["MiniMax-M3", "MiniMax-M2.7", "MiniMax-M2.7-highspeed"],
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
    modelContextWindows: Object.fromEntries(KIMI_CODE_MODELS.map(id => [id, 262_144])),
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
  { id: "opencode-zen", label: "opencode zen", baseUrl: "https://opencode.ai/zen/v1", adapter: "openai-chat", authKind: "key", dashboardUrl: "https://opencode.ai/auth" },
  { id: "vercel-ai-gateway", label: "Vercel AI Gateway", baseUrl: "https://ai-gateway.vercel.sh/v1", adapter: "openai-chat", authKind: "key", dashboardUrl: "https://vercel.com/dashboard" },
  {
    id: "xiaomi",
    label: "Xiaomi MiMo",
    baseUrl: "https://api.xiaomimimo.com/anthropic",
    adapter: "anthropic",
    authKind: "key",
    dashboardUrl: "https://xiaomimimo.com",
    models: ["mimo-v2.5-pro"],
    defaultModel: "mimo-v2.5-pro",
    modelContextWindows: { "mimo-v2.5-pro": 1_000_000 },
    modelCapabilities: { "mimo-v2.5-pro": { input: ["text"] } },
    officialModelSources: ["https://mimo.xiaomi.com/mimo-v2-5-pro"],
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

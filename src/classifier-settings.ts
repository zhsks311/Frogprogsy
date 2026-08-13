import type { FrogConfig, FrogProviderConfig } from "./types";

/**
 * Reserved gateway model alias for the Claude Code auto-mode side-classifier. SINGLE source of truth.
 * Claude Code requests this exact id (via injected `ANTHROPIC_DEFAULT_SONNET_MODEL`) for its auto-mode
 * permission side-queries; the router matches it EXACTLY and routes to the one configured
 * `autoModeClassifier` target. There is no model-name-shape guessing and no generic provider fallback.
 */
export const AUTO_MODE_CLASSIFIER_ALIAS = "claude-frogp-auto-classifier";

export interface ClassifierProviderOption {
  name: string;
  models: string[];
}

export interface ClassifierSettingsSnapshot {
  providers: ClassifierProviderOption[];
  autoModeClassifierEnabled: boolean;
  autoModeClassifier: { provider: string; model: string };
}

/** Why the reserved auto-mode classifier alias has no usable target. Deterministic per config. */
export type AutoModeClassifierUnavailableReason =
  | "unset"
  | "incomplete"
  | "provider_missing"
  | "disabled";

export type AutoModeClassifierResolution =
  | { ok: true; provider: string; model: string }
  | { ok: false; reason: AutoModeClassifierUnavailableReason; message: string };

/** Sorted unique model list for a single provider (defaultModel + models[]). */
export function providerKnownModels(prov: FrogProviderConfig): string[] {
  const set = new Set<string>();
  if (prov.defaultModel) set.add(prov.defaultModel);
  for (const m of prov.models ?? []) set.add(m);
  return [...set].sort((a, b) => a.localeCompare(b));
}

/**
 * The disabled-model id forms that hide the auto-mode classifier target: the raw model id, the
 * `<provider>/<model>` routed id (the `disabledModels` canonical form), and the reserved alias
 * itself. Disabling any one of these disables the classifier target.
 */
function classifierTargetDisabledForms(provider: string, model: string): string[] {
  return [model, `${provider}/${model}`, AUTO_MODE_CLASSIFIER_ALIAS];
}

function isClassifierTargetDisabled(config: FrogConfig, provider: string, model: string): boolean {
  const disabled = config.disabledModels;
  if (!disabled || disabled.length === 0) return false;
  const forms = new Set(classifierTargetDisabledForms(provider, model));
  return disabled.some(id => forms.has(id));
}

/** Effective, Claude-visible model ids for a provider: configured/live models minus disabled routed ids. */
export function effectiveProviderModels(
  config: FrogConfig,
  name: string,
  effectiveModels: Array<{ provider: string; id: string }> = [],
): string[] {
  const prov = config.providers[name];
  if (!prov) return [];
  const models = new Set(providerKnownModels(prov));
  for (const candidate of effectiveModels) {
    if (candidate.provider === name) models.add(candidate.id);
  }
  const disabled = new Set(config.disabledModels ?? []);
  return [...models]
    .filter(model => !disabled.has(`${name}/${model}`) && !disabled.has(model))
    .sort((a, b) => a.localeCompare(b));
}

/**
 * Resolve the single explicit auto-mode classifier target. This is the ONLY interpreter of
 * `autoModeClassifier`; there is no per-provider `classifierModel`, no cross-provider `classifierFallback`,
 * and no Haiku-shape fallback. Deterministic: the same config always yields the same result. It returns a
 * hard error for an unset, incomplete, unknown-provider, or disabled target. Management validation rejects
 * a model absent from its configured/live catalog; startup also validates static provider catalogs.
 */
export function resolveAutoModeClassifierTarget(config: FrogConfig): AutoModeClassifierResolution {
  const target = config.autoModeClassifier;
  if (!target) {
    return {
      ok: false,
      reason: "unset",
      message: "autoModeClassifier is not configured; set { provider, model } to enable the auto-mode classifier.",
    };
  }
  const provider = typeof target.provider === "string" ? target.provider.trim() : "";
  const model = typeof target.model === "string" ? target.model.trim() : "";
  if (!provider || !model) {
    return {
      ok: false,
      reason: "incomplete",
      message: `autoModeClassifier is incomplete; both provider and model are required (got provider="${provider}", model="${model}").`,
    };
  }
  if (!config.providers[provider]) {
    return {
      ok: false,
      reason: "provider_missing",
      message: `autoModeClassifier provider "${provider}" is not a configured provider.`,
    };
  }
  if (isClassifierTargetDisabled(config, provider, model)) {
    return {
      ok: false,
      reason: "disabled",
      message: `autoModeClassifier target "${provider}/${model}" is disabled via disabledModels.`,
    };
  }
  return { ok: true, provider, model };
}

/**
 * Returns a diagnostic when a non-empty model is absent from the provider's configured/live known model
 * list. A provider with no known list accepts an explicit model id. Callers choose whether the diagnostic
 * is a hard validation error; the management API rejects it.
 */
export function validateClassifierModel(
  config: FrogConfig,
  providerName: string,
  model: string,
  effectiveModels: Array<{ provider: string; id: string }> = [],
): string | null {
  if (!model) return null;
  const prov = config.providers[providerName];
  if (!prov) return null;
  const known = new Set(providerKnownModels(prov));
  for (const candidate of effectiveModels) {
    if (candidate.provider === providerName) known.add(candidate.id);
  }
  if (known.size === 0 || known.has(model)) return null;
  const sorted = [...known].sort((a, b) => a.localeCompare(b));
  const preview = sorted.slice(0, 5).join(", ");
  const ellipsis = sorted.length > 5 ? "…" : "";
  return `classifier model "${model}" is not in the known models list for provider "${providerName}" (${preview}${ellipsis})`;
}

/** Build the classifier settings snapshot for the management API (GET/PUT /api/classifier-settings). */
export function classifierSettingsSnapshot(
  config: FrogConfig,
  effectiveModels: Array<{ provider: string; id: string }> = [],
): ClassifierSettingsSnapshot {
  const providers: ClassifierProviderOption[] = Object.keys(config.providers).map(name => ({
    name,
    models: effectiveProviderModels(config, name, effectiveModels),
  }));
  return {
    autoModeClassifierEnabled: config.autoModeClassifierEnabled === true,
    providers,
    autoModeClassifier: {
      provider: config.autoModeClassifier?.provider ?? "",
      model: config.autoModeClassifier?.model ?? "",
    },
  };
}

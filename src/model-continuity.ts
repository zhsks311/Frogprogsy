import type { SelectedModelCatalog } from "./model-catalog-runtime";
import type {
  FrogConfig,
  ModelContinuityAutomatic,
  ModelContinuityPolicy,
} from "./types";

export const MAX_CONTINUITY_FALLBACKS = 3;
export const CONTINUITY_CIRCUIT_MS = 30_000;

export interface ModelContinuityModelRow {
  namespaced: string;
  disabled?: boolean;
  authReady?: boolean;
  supportStatus?: "validated" | "discovered" | "unknown";
}

export interface ModelContinuityValidationInput {
  primaryTarget: string;
  config: FrogConfig;
  retiredTargets: ReadonlySet<string>;
  models: readonly ModelContinuityModelRow[];
  automatic: ModelContinuityAutomatic;
  fallbacks: readonly string[];
}

export type ModelContinuityValidationResult =
  | { ok: true; policy: ModelContinuityPolicy; warnings: string[] }
  | { ok: false; error: string };

export function qualifiedModelTarget(value: string): { provider: string; model: string } | null {
  const slash = value.indexOf("/");
  if (slash <= 0 || slash === value.length - 1) return null;
  return { provider: value.slice(0, slash), model: value.slice(slash + 1) };
}

export function normalizeContinuityPolicy(
  policy: ModelContinuityPolicy | undefined,
): ModelContinuityPolicy {
  return policy
    ? { fallbacks: [...policy.fallbacks], automatic: policy.automatic }
    : { fallbacks: [], automatic: "off" };
}

export function buildRetiredTargetIndex(
  config: FrogConfig,
  catalog: SelectedModelCatalog,
): ReadonlySet<string> {
  const catalogProviders = new Map(
    catalog.document.providers.map(provider => [provider.id, provider]),
  );
  const retiredTargets = new Set<string>();

  for (const [configuredName, provider] of Object.entries(config.providers)) {
    if (!provider.catalogProviderId) continue;
    const catalogProvider = catalogProviders.get(provider.catalogProviderId);
    if (!catalogProvider) continue;
    for (const retiredModel of catalogProvider.retiredModels ?? []) {
      retiredTargets.add(`${configuredName}/${retiredModel}`);
    }
  }

  return retiredTargets;
}

export function validateContinuityPolicy(
  input: ModelContinuityValidationInput,
): ModelContinuityValidationResult {
  const primary = qualifiedModelTarget(input.primaryTarget);
  if (!primary || !input.config.providers[primary.provider]) {
    return { ok: false, error: `Invalid primary target: ${input.primaryTarget}` };
  }

  if (!isContinuityAutomatic(input.automatic)) {
    return { ok: false, error: `Invalid automatic mode: ${String(input.automatic)}` };
  }

  const classifier = input.config.autoModeClassifier;
  if (
    input.automatic !== "off"
    && classifier?.provider === primary.provider
    && classifier.model === primary.model
  ) {
    return { ok: false, error: "Automatic continuity is not allowed for the auto-mode classifier target" };
  }

  if (input.fallbacks.length > MAX_CONTINUITY_FALLBACKS) {
    return { ok: false, error: `At most ${MAX_CONTINUITY_FALLBACKS} fallback targets are allowed` };
  }

  const rows = new Map(input.models.map(model => [model.namespaced, model]));
  const disabledTargets = new Set(input.config.disabledModels ?? []);
  const seen = new Set<string>();
  const warnings: string[] = [];

  for (const fallback of input.fallbacks) {
    const target = qualifiedModelTarget(fallback);
    if (!target) return { ok: false, error: `Invalid fallback target: ${fallback}` };
    if (!input.config.providers[target.provider]) {
      return { ok: false, error: `Unconfigured fallback provider: ${target.provider}` };
    }
    if (fallback === input.primaryTarget) {
      return { ok: false, error: `Fallback target matches the primary target: ${fallback}` };
    }
    if (seen.has(fallback)) {
      return { ok: false, error: `Duplicate fallback target: ${fallback}` };
    }
    seen.add(fallback);

    if (input.retiredTargets.has(fallback)) {
      return { ok: false, error: `Retired fallback target: ${fallback}` };
    }

    const row = rows.get(fallback);
    if (!row) return { ok: false, error: `Unknown fallback model: ${fallback}` };
    if (row.disabled === true || disabledTargets.has(fallback)) {
      return { ok: false, error: `Disabled fallback target: ${fallback}` };
    }
    if (row.supportStatus === "discovered") {
      warnings.push(`${fallback} has supportStatus:discovered`);
    }
    if (row.authReady === false) {
      warnings.push(`${fallback} has authReady:false`);
    }
  }

  return {
    ok: true,
    policy: { fallbacks: [...input.fallbacks], automatic: input.automatic },
    warnings,
  };
}

function isContinuityAutomatic(value: unknown): value is ModelContinuityAutomatic {
  return value === "off" || value === "retired" || value === "transient" || value === "all";
}

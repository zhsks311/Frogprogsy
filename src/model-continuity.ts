import {
  resolveAutoModeClassifierTarget,
  validateClassifierModel,
} from "./classifier-settings";
import type { ModelAliasEntry } from "./model-aliases";
import type { SelectedModelCatalog } from "./model-catalog-runtime";
import { routeModel } from "./router";
import type {
  FrogConfig,
  ModelContinuityAutomatic,
  ModelContinuityPolicy,
} from "./types";

export const MAX_CONTINUITY_FALLBACKS = 3;
export const CONTINUITY_CIRCUIT_MS = 30_000;

export type ContinuityReason =
  | "retired"
  | "connect_failure"
  | "connect_timeout"
  | "http_404"
  | "http_410"
  | "http_429"
  | "http_5xx"
  | "circuit_open";

export interface ContinuityCircuitSnapshot {
  target: string;
  reason: ContinuityReason;
  until: number;
}

export class ContinuityCircuit {
  readonly #entries = new Map<string, { until: number; reason: ContinuityReason }>();

  isOpen(target: string, now: number): boolean {
    const entry = this.#entries.get(target);
    if (!entry) return false;
    if (entry.until <= now) {
      this.#entries.delete(target);
      return false;
    }
    return true;
  }

  open(target: string, reason: ContinuityReason, now: number): void {
    this.#entries.set(target, { until: now + CONTINUITY_CIRCUIT_MS, reason });
  }

  succeed(target: string): void {
    this.#entries.delete(target);
  }

  snapshot(now: number): ContinuityCircuitSnapshot[] {
    const snapshot: ContinuityCircuitSnapshot[] = [];
    for (const [target, entry] of this.#entries) {
      if (!this.isOpen(target, now)) continue;
      snapshot.push({ target, reason: entry.reason, until: entry.until });
    }
    return snapshot;
  }
}

export function continuityCandidates(
  primary: string,
  policy: ModelContinuityPolicy,
  retiredTargets: ReadonlySet<string>,
  circuit: ContinuityCircuit,
  now: number,
): string[] {
  return [primary, ...policy.fallbacks].filter(
    target => !retiredTargets.has(target) && !circuit.isOpen(target, now),
  );
}

const STRUCTURED_CONTEXT_LIMIT_VALUES: Record<string, true> = {
  context_length_exceeded: true,
  context_window_exceeded: true,
  context_limit_exceeded: true,
};

export function isContinuityEligibleHttpFailure(
  status: number,
  details: { type: string; code?: string | null },
): ContinuityReason | null {
  if (
    STRUCTURED_CONTEXT_LIMIT_VALUES[details.type] === true
    || (details.code !== null && details.code !== undefined
      && STRUCTURED_CONTEXT_LIMIT_VALUES[details.code] === true)
  ) {
    return null;
  }
  if (status === 404) return "http_404";
  if (status === 410) return "http_410";
  if (status === 429) return "http_429";
  if (status >= 500 && status <= 599) return "http_5xx";
  return null;
}

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

export type ModelContinuityReferenceKind =
  | "provider-default"
  | "long-context"
  | "subagent"
  | "classifier"
  | "mix-coordinator"
  | "mix-agent"
  | "mix-pipeline"
  | "mix-panel"
  | "mix-judge"
  | "mix-synthesizer"
  | "mix-rule"
  | "web-search-helper"
  | "image-helper"
  | "gateway-alias";

export interface ModelContinuityReference {
  id: string;
  kind: ModelContinuityReferenceKind;
  primary: string;
  status: "ready" | "retired" | "authentication_required" | "policy_invalid";
  automaticEligible: boolean;
  policy: ModelContinuityPolicy;
  supportStatus: "validated" | "discovered" | "unknown";
  label: string;
}

export interface CollectModelContinuityReferencesInput {
  config: FrogConfig;
  retiredTargets: ReadonlySet<string>;
  models: readonly ModelContinuityModelRow[];
  aliases: readonly ModelAliasEntry[];
}

export interface ReplaceModelContinuityReferenceInput {
  config: FrogConfig;
  referenceId: string;
  expectedPrimary: string;
  replacement: string;
  models?: readonly ModelContinuityModelRow[];
  validateTarget: (target: string) => string | null;
}

export type ReplaceModelContinuityReferenceResult =
  | { ok: true }
  | { ok: false; status: 400 | 409; error: string };

interface ReferenceOwner {
  id: string;
  kind: ModelContinuityReferenceKind;
  primary: string;
  label: string;
}

interface MutableReferenceOwner {
  kind: Exclude<ModelContinuityReferenceKind, "gateway-alias">;
  primary: string;
  replace(target: { provider: string; model: string }): void;
}

const NON_AUTOMATIC_KINDS: Partial<Record<ModelContinuityReferenceKind, true>> = {
  subagent: true,
  classifier: true,
  "mix-coordinator": true,
  "mix-agent": true,
  "mix-pipeline": true,
  "mix-panel": true,
  "mix-judge": true,
  "mix-synthesizer": true,
  "mix-rule": true,
  "web-search-helper": true,
  "image-helper": true,
};

export function collectModelContinuityReferences(
  input: CollectModelContinuityReferencesInput,
): ModelContinuityReference[] {
  const owners = collectReferenceOwners(input.config);
  const rows = new Map(input.models.map(model => [model.namespaced, model]));
  const disabledTargets = new Set(input.config.disabledModels ?? []);
  const activeOrRetiredAliases = input.aliases.filter(alias => {
    if (!input.config.providers[alias.provider]) return false;
    if (input.retiredTargets.has(alias.routeKey)) return true;
    const row = rows.get(alias.routeKey);
    return row !== undefined && row.disabled !== true && !disabledTargets.has(alias.routeKey);
  });
  for (const alias of activeOrRetiredAliases) {
    owners.push({
      id: `gateway-alias:${alias.alias}`,
      kind: "gateway-alias",
      primary: alias.routeKey,
      label: alias.displayName,
    });
  }

  return owners.map(owner => {
    const row = rows.get(owner.primary);
    const policy = normalizeContinuityPolicy(input.config.modelContinuity?.[owner.primary]);
    const automaticEligible = NON_AUTOMATIC_KINDS[owner.kind] !== true;
    return {
      ...owner,
      status: referenceStatus(owner.primary, automaticEligible, input, row, policy),
      automaticEligible,
      policy,
      supportStatus: row?.supportStatus ?? "unknown",
    };
  });
}

export function replaceModelContinuityReference(
  input: ReplaceModelContinuityReferenceInput,
): ReplaceModelContinuityReferenceResult {
  if (input.referenceId.startsWith("gateway-alias:")) {
    return {
      ok: false,
      status: 400,
      error: "gateway aliases are past-session identifiers; configure a route policy instead",
    };
  }
  const owner = findMutableReferenceOwner(input.config, input.referenceId);
  if (!owner && !isModelContinuityReferenceId(input.referenceId)) {
    return { ok: false, status: 400, error: `unknown model reference: ${input.referenceId}` };
  }
  if (!owner || owner.primary !== input.expectedPrimary) {
    return {
      ok: false,
      status: 409,
      error: "model reference changed; reload and retry",
    };
  }

  const replacement = qualifiedModelTarget(input.replacement);
  if (!replacement) {
    return { ok: false, status: 400, error: `invalid replacement target: ${input.replacement}` };
  }
  if (
    owner.kind === "provider-default"
    && replacement.provider !== qualifiedModelTarget(owner.primary)?.provider
  ) {
    return {
      ok: false,
      status: 400,
      error: "provider default replacement must stay inside its configured provider",
    };
  }

  const targetError = input.validateTarget(input.replacement);
  if (targetError) return { ok: false, status: 400, error: targetError };
  if (owner.kind === "classifier") {
    const candidateConfig: FrogConfig = {
      ...input.config,
      autoModeClassifier: {
        provider: replacement.provider,
        model: replacement.model,
      },
    };
    const classifierTarget = resolveAutoModeClassifierTarget(candidateConfig);
    if (!classifierTarget.ok) {
      return { ok: false, status: 400, error: classifierTarget.message };
    }
    const effectiveModels: Array<{ provider: string; id: string }> = [];
    for (const row of input.models ?? []) {
      const target = qualifiedModelTarget(row.namespaced);
      if (target) effectiveModels.push({ provider: target.provider, id: target.model });
    }
    const classifierError = validateClassifierModel(
      candidateConfig,
      classifierTarget.provider,
      classifierTarget.model,
      effectiveModels,
    );
    if (classifierError) return { ok: false, status: 400, error: classifierError };
  }

  owner.replace(replacement);
  return { ok: true };
}

function collectReferenceOwners(config: FrogConfig): ReferenceOwner[] {
  const owners: ReferenceOwner[] = [];
  for (const [provider, providerConfig] of Object.entries(config.providers)) {
    if (!providerConfig.defaultModel) continue;
    owners.push({
      id: `provider-default:${provider}`,
      kind: "provider-default",
      primary: `${provider}/${providerConfig.defaultModel}`,
      label: `${provider} default model`,
    });
  }

  const longContext = config.longContext;
  if (
    longContext?.provider
    && longContext.model
    && typeof longContext.thresholdTokens === "number"
    && Number.isFinite(longContext.thresholdTokens)
    && longContext.thresholdTokens > 0
  ) {
    owners.push(targetOwner(
      "long-context",
      "long-context",
      longContext.provider,
      longContext.model,
      "Long-context route",
    ));
  }
  for (const [index, configuredModel] of (config.subagentModels ?? []).entries()) {
    if (typeof configuredModel !== "string") continue;
    owners.push({
      id: `subagent:${index}`,
      kind: "subagent",
      primary: resolvedSubagentPrimary(config, configuredModel),
      label: `Subagent model ${index + 1}`,
    });
  }
  if (config.autoModeClassifier?.provider && config.autoModeClassifier.model) {
    owners.push(targetOwner(
      "classifier",
      "classifier",
      config.autoModeClassifier.provider,
      config.autoModeClassifier.model,
      "Auto-mode classifier",
    ));
  }

  const mixing = config.modelMixing;
  if (mixing?.enabled === true) {
    if (mixing.coordinator?.provider && mixing.coordinator.model) {
      owners.push(targetOwner(
        "mix-coordinator",
        "mix-coordinator",
        mixing.coordinator.provider,
        mixing.coordinator.model,
        "Mixing coordinator",
      ));
    }
    for (const [index, target] of (mixing.agents ?? []).entries()) {
      owners.push(targetOwner(
        `mix-agent:${index}`,
        "mix-agent",
        target.provider,
        target.model,
        `Mixing agent ${index + 1}`,
      ));
    }
    for (const [index, target] of (mixing.pipeline ?? []).entries()) {
      owners.push(targetOwner(
        `mix-pipeline:${index}`,
        "mix-pipeline",
        target.provider,
        target.model,
        `Mixing pipeline stage ${index + 1}`,
      ));
    }
    for (const [index, target] of (mixing.fusion?.panel ?? []).entries()) {
      owners.push(targetOwner(
        `mix-panel:${index}`,
        "mix-panel",
        target.provider,
        target.model,
        `Mixing panel member ${index + 1}`,
      ));
    }
    if (mixing.fusion?.judge) {
      owners.push(targetOwner(
        "mix-judge",
        "mix-judge",
        mixing.fusion.judge.provider,
        mixing.fusion.judge.model,
        "Mixing judge",
      ));
    }
    if (mixing.fusion?.synthesizer) {
      owners.push(targetOwner(
        "mix-synthesizer",
        "mix-synthesizer",
        mixing.fusion.synthesizer.provider,
        mixing.fusion.synthesizer.model,
        "Mixing synthesizer",
      ));
    }
    for (const [index, target] of (mixing.rules ?? []).entries()) {
      owners.push(targetOwner(
        `mix-rule:${index}`,
        "mix-rule",
        target.provider,
        target.model,
        `Mixing rule ${index + 1}`,
      ));
    }
  }

  const webSearch = config.webSearchFallback;
  if (webSearch?.enabled === true && webSearch.provider && webSearch.model) {
    owners.push(targetOwner(
      "web-search-helper",
      "web-search-helper",
      webSearch.provider,
      webSearch.model,
      "Web-search helper",
    ));
  }
  const image = config.imageFallback;
  if (image?.enabled === true && image.provider && image.model) {
    owners.push(targetOwner(
      "image-helper",
      "image-helper",
      image.provider,
      image.model,
      "Image helper",
    ));
  }
  return owners;
}

function targetOwner(
  id: string,
  kind: ModelContinuityReferenceKind,
  provider: string,
  model: string,
  label: string,
): ReferenceOwner {
  return { id, kind, primary: `${provider}/${model}`, label };
}

function referenceStatus(
  primary: string,
  automaticEligible: boolean,
  input: CollectModelContinuityReferencesInput,
  row: ModelContinuityModelRow | undefined,
  policy: ModelContinuityPolicy,
): ModelContinuityReference["status"] {
  if (input.retiredTargets.has(primary)) return "retired";
  const primaryTarget = qualifiedModelTarget(primary);
  if (
    !primaryTarget
    || !input.config.providers[primaryTarget.provider]
    || !row
    || row.disabled === true
    || (input.config.disabledModels ?? []).includes(primary)
  ) {
    return "policy_invalid";
  }
  const classifier = input.config.autoModeClassifier;
  const classifierTarget = classifier ? `${classifier.provider}/${classifier.model}` : null;
  const validationConfig = automaticEligible && classifierTarget === primary
    ? { ...input.config, autoModeClassifier: undefined }
    : input.config;
  const policyResult = validateContinuityPolicy({
    primaryTarget: primary,
    config: validationConfig,
    retiredTargets: input.retiredTargets,
    models: input.models,
    automatic: automaticEligible ? policy.automatic : "off",
    fallbacks: policy.fallbacks,
  });
  if (!policyResult.ok) return "policy_invalid";
  if (row.authReady === false) return "authentication_required";
  return "ready";
}

function findMutableReferenceOwner(
  config: FrogConfig,
  referenceId: string,
): MutableReferenceOwner | null {
  if (referenceId.startsWith("provider-default:")) {
    const provider = referenceId.slice("provider-default:".length);
    const providerConfig = config.providers[provider];
    if (!provider || !providerConfig?.defaultModel) return null;
    return {
      kind: "provider-default",
      primary: `${provider}/${providerConfig.defaultModel}`,
      replace: target => {
        providerConfig.defaultModel = target.model;
      },
    };
  }
  if (referenceId === "long-context") {
    const target = config.longContext;
    if (!target?.provider || !target.model) return null;
    return objectReferenceOwner("long-context", target);
  }
  if (referenceId === "classifier") {
    const target = config.autoModeClassifier;
    if (!target?.provider || !target.model) return null;
    return objectReferenceOwner("classifier", target);
  }
  if (referenceId === "mix-coordinator") {
    const target = config.modelMixing?.coordinator;
    if (!target?.provider || !target.model) return null;
    return objectReferenceOwner("mix-coordinator", target);
  }
  if (referenceId === "mix-judge") {
    const target = config.modelMixing?.fusion?.judge;
    return target ? objectReferenceOwner("mix-judge", target) : null;
  }
  if (referenceId === "mix-synthesizer") {
    const target = config.modelMixing?.fusion?.synthesizer;
    return target ? objectReferenceOwner("mix-synthesizer", target) : null;
  }
  if (referenceId === "web-search-helper") {
    const target = config.webSearchFallback;
    if (!target?.provider || !target.model) return null;
    return objectReferenceOwner("web-search-helper", target);
  }
  if (referenceId === "image-helper") {
    const target = config.imageFallback;
    if (!target?.provider || !target.model) return null;
    return objectReferenceOwner("image-helper", target);
  }

  const indexed = parseIndexedReferenceId(referenceId);
  if (!indexed) return null;
  if (indexed.kind === "subagent") {
    const configuredModel = config.subagentModels?.[indexed.index];
    if (typeof configuredModel !== "string") return null;
    return {
      kind: "subagent",
      primary: resolvedSubagentPrimary(config, configuredModel),
      replace: target => {
        config.subagentModels![indexed.index] = `${target.provider}/${target.model}`;
      },
    };
  }
  const targets = indexedTargets(config, indexed.kind);
  const target = targets?.[indexed.index];
  return target ? objectReferenceOwner(indexed.kind, target) : null;
}

function objectReferenceOwner(
  kind: MutableReferenceOwner["kind"],
  target: { provider?: string; model?: string },
): MutableReferenceOwner | null {
  if (!target.provider || !target.model) return null;
  return {
    kind,
    primary: `${target.provider}/${target.model}`,
    replace: replacement => {
      target.provider = replacement.provider;
      target.model = replacement.model;
    },
  };
}

function resolvedSubagentPrimary(config: FrogConfig, configuredModel: string): string {
  try {
    const route = routeModel(config, configuredModel);
    return `${route.providerName}/${route.modelId}`;
  } catch {
    return configuredModel;
  }
}

function parseIndexedReferenceId(referenceId: string): {
  kind: "subagent" | "mix-agent" | "mix-pipeline" | "mix-panel" | "mix-rule";
  index: number;
} | null {
  const match = /^(subagent|mix-agent|mix-pipeline|mix-panel|mix-rule):(0|[1-9]\d*)$/.exec(referenceId);
  if (!match) return null;
  return {
    kind: match[1] as "subagent" | "mix-agent" | "mix-pipeline" | "mix-panel" | "mix-rule",
    index: Number(match[2]),
  };
}

function isModelContinuityReferenceId(referenceId: string): boolean {
  if (referenceId.startsWith("provider-default:")) {
    return referenceId.length > "provider-default:".length;
  }
  if (
    referenceId === "long-context"
    || referenceId === "classifier"
    || referenceId === "mix-coordinator"
    || referenceId === "mix-judge"
    || referenceId === "mix-synthesizer"
    || referenceId === "web-search-helper"
    || referenceId === "image-helper"
  ) {
    return true;
  }
  return parseIndexedReferenceId(referenceId) !== null;
}

function indexedTargets(
  config: FrogConfig,
  kind: "mix-agent" | "mix-pipeline" | "mix-panel" | "mix-rule",
): { provider: string; model: string }[] | undefined {
  if (kind === "mix-agent") return config.modelMixing?.agents;
  if (kind === "mix-pipeline") return config.modelMixing?.pipeline;
  if (kind === "mix-panel") return config.modelMixing?.fusion?.panel;
  return config.modelMixing?.rules;
}

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

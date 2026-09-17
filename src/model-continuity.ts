import {
  resolveAutoModeClassifierTarget,
  validateClassifierModel,
} from "./classifier-settings";
import { findOpenAIResponsesFallbackProviderEntry } from "./fallback-openai-responses";
import { DEFAULT_IMAGE_FALLBACK_MODEL } from "./image-fallback";
import type { ModelAliasEntry } from "./model-aliases";
import type { SelectedModelCatalog } from "./model-catalog-runtime";
import { routeModel } from "./router";
import { DEFAULT_WEB_SEARCH_FALLBACK_MODEL } from "./web-search-fallback";
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
  | "continuity-policy"
  | "continuity-policy-candidate"
  | "gateway-alias";

export interface ModelContinuityReference {
  id: string;
  kind: ModelContinuityReferenceKind;
  primary: string;
  status: "ready" | "retired" | "authentication_required" | "policy_invalid";
  active: boolean;
  actionRequired: boolean;
  removable: boolean;
  automaticEligible: boolean;
  policy: ModelContinuityPolicy;
  supportStatus: "validated" | "discovered" | "unknown";
  label: string;
  policyPrimary?: string;
  policyFallbackIndex?: number;
}

export interface ModelContinuitySummary {
  actionableModelCount: number;
  actionableReferenceCount: number;
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

export interface RemoveModelContinuityReferenceInput {
  config: FrogConfig;
  referenceId: string;
  expectedPrimary: string;
}

export type RemoveModelContinuityReferenceResult =
  | { ok: true }
  | { ok: false; status: 400 | 409; error: string };

interface ReferenceOwner {
  id: string;
  kind: ModelContinuityReferenceKind;
  primary: string;
  label: string;
  active: boolean;
  policyPrimary?: string;
  policyFallbackIndex?: number;
}

interface MutableReferenceOwner {
  kind: Exclude<ModelContinuityReferenceKind, "gateway-alias" | "continuity-policy">;
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
      active: false,
    });
  }
  for (const [primary, configuredPolicy] of Object.entries(input.config.modelContinuity ?? {})) {
    const policy = normalizeContinuityPolicy(configuredPolicy);
    owners.push({
      id: `continuity-policy:${encodeURIComponent(primary)}`,
      kind: "continuity-policy",
      primary,
      label: `Continuity policy for ${primary}`,
      active: policy.automatic !== "off",
    });
    policy.fallbacks.forEach((fallback, index) => {
      owners.push({
        id: `continuity-policy-candidate:${encodeURIComponent(primary)}:${index}`,
        kind: "continuity-policy-candidate",
        primary: fallback,
        label: `Fallback ${index + 1} for ${primary}`,
        active: policy.automatic !== "off",
        policyPrimary: primary,
        policyFallbackIndex: index,
      });
    });
  }

  return owners.map(owner => {
    const row = rows.get(owner.primary);
    const policyPrimary = owner.policyPrimary ?? owner.primary;
    const policy = normalizeContinuityPolicy(input.config.modelContinuity?.[policyPrimary]);
    const automaticEligible = NON_AUTOMATIC_KINDS[owner.kind] !== true;
    const status = referenceStatus(
      owner.primary,
      owner.kind === "continuity-policy",
      input,
      row,
      policy,
    );
    return {
      ...owner,
      status,
      actionRequired: owner.active && status !== "ready",
      automaticEligible,
      removable: referenceRemovable(input.config, owner),
      policy,
      supportStatus: row?.supportStatus ?? "unknown",
    };
  });
}

export function summarizeModelContinuityReferences(
  references: readonly ModelContinuityReference[],
): ModelContinuitySummary {
  const actionable = references.filter(reference => reference.actionRequired);
  return {
    actionableModelCount: new Set(actionable.map(reference => reference.primary)).size,
    actionableReferenceCount: actionable.length,
  };
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
  const policyCandidate = findPolicyCandidateReference(input.config, input.referenceId);
  if (policyCandidate) {
    if (input.replacement === policyCandidate.policyPrimary) {
      return { ok: false, status: 400, error: "fallback target cannot match its policy primary" };
    }
    if (policyCandidate.policy.fallbacks.some(
      (fallback, index) => index !== policyCandidate.index && fallback === input.replacement,
    )) {
      return { ok: false, status: 400, error: "duplicate fallback target" };
    }
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

export function removeModelContinuityReference(
  input: RemoveModelContinuityReferenceInput,
): RemoveModelContinuityReferenceResult {
  const policyCandidate = findPolicyCandidateReference(input.config, input.referenceId);
  if (input.referenceId.startsWith("continuity-policy-candidate:")) {
    if (!policyCandidate || policyCandidate.primary !== input.expectedPrimary) {
      return { ok: false, status: 409, error: "model reference changed; reload and retry" };
    }
    policyCandidate.policy.fallbacks.splice(policyCandidate.index, 1);
    if (policyCandidate.policy.automatic === "off" && policyCandidate.policy.fallbacks.length === 0) {
      delete input.config.modelContinuity![policyCandidate.policyPrimary];
      if (Object.keys(input.config.modelContinuity!).length === 0) delete input.config.modelContinuity;
    }
    return { ok: true };
  }
  if (input.referenceId.startsWith("provider-default:")) {
    return {
      ok: false,
      status: 400,
      error: "provider defaults are required; replace this model instead",
    };
  }
  if (input.referenceId.startsWith("gateway-alias:")) {
    return {
      ok: false,
      status: 400,
      error: "gateway aliases are retained past-session identifiers",
    };
  }
  if (input.referenceId.startsWith("continuity-policy:")) {
    const policyEntry = Object.entries(input.config.modelContinuity ?? {})
      .find(([primary]) => `continuity-policy:${encodeURIComponent(primary)}` === input.referenceId);
    if (!policyEntry) {
      return { ok: false, status: 400, error: `unknown model reference: ${input.referenceId}` };
    }
    if (policyEntry[0] !== input.expectedPrimary) {
      return { ok: false, status: 409, error: "model reference changed; reload and retry" };
    }
    delete input.config.modelContinuity![policyEntry[0]];
    if (Object.keys(input.config.modelContinuity!).length === 0) delete input.config.modelContinuity;
    return { ok: true };
  }

  const ownerPrimary = findRemovalReferencePrimary(input.config, input.referenceId);
  if (ownerPrimary === null && !isModelContinuityReferenceId(input.referenceId)) {
    return { ok: false, status: 400, error: `unknown model reference: ${input.referenceId}` };
  }
  if (ownerPrimary === null || ownerPrimary !== input.expectedPrimary) {
    return { ok: false, status: 409, error: "model reference changed; reload and retry" };
  }
  if (input.referenceId === "classifier" && input.config.autoModeClassifierEnabled === true) {
    return {
      ok: false,
      status: 400,
      error: "disable auto-mode classifier routing before removing its saved target",
    };
  }

  if (input.referenceId === "long-context") {
    delete input.config.longContext;
    return { ok: true };
  }
  if (input.referenceId === "classifier") {
    delete input.config.autoModeClassifier;
    return { ok: true };
  }
  if (input.referenceId === "mix-coordinator") {
    delete input.config.modelMixing?.coordinator;
    return { ok: true };
  }
  if (input.referenceId === "mix-judge") {
    delete input.config.modelMixing?.fusion?.judge;
    return { ok: true };
  }
  if (input.referenceId === "mix-synthesizer") {
    delete input.config.modelMixing?.fusion?.synthesizer;
    return { ok: true };
  }
  if (input.referenceId === "web-search-helper") {
    if (input.config.webSearchFallback) {
      input.config.webSearchFallback.enabled = false;
      delete input.config.webSearchFallback.provider;
      delete input.config.webSearchFallback.model;
    }
    return { ok: true };
  }
  if (input.referenceId === "image-helper") {
    if (input.config.imageFallback) {
      input.config.imageFallback.enabled = false;
      delete input.config.imageFallback.provider;
      delete input.config.imageFallback.model;
    }
    return { ok: true };
  }

  const indexed = parseIndexedReferenceId(input.referenceId);
  if (!indexed) {
    return { ok: false, status: 400, error: `model reference cannot be removed: ${input.referenceId}` };
  }
  if (indexed.kind === "subagent") {
    input.config.subagentModels!.splice(indexed.index, 1);
    return { ok: true };
  }
  const targets = indexedTargets(input.config, indexed.kind);
  if (!targets?.[indexed.index]) {
    return { ok: false, status: 409, error: "model reference changed; reload and retry" };
  }
  targets.splice(indexed.index, 1);
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
      active: true,
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
      true,
    ));
  }
  for (const [index, configuredModel] of (config.subagentModels ?? []).entries()) {
    if (typeof configuredModel !== "string") continue;
    owners.push({
      id: `subagent:${index}`,
      kind: "subagent",
      primary: resolvedSubagentPrimary(config, configuredModel),
      label: `Subagent model ${index + 1}`,
      active: true,
    });
  }
  if (config.autoModeClassifier) {
    owners.push(targetOwner(
      "classifier",
      "classifier",
      config.autoModeClassifier.provider,
      config.autoModeClassifier.model,
      "Auto-mode classifier",
      config.autoModeClassifierEnabled === true,
    ));
  }

  const mixing = config.modelMixing;
  if (mixing) {
    const enabled = mixing.enabled === true;
    const combine = mixing.combine ?? "route";
    const mode = mixing.mode ?? "coordinator";
    const routeMode = enabled && combine === "route";
    const pipelineMode = enabled && combine === "pipeline";
    const fusionMode = enabled && combine === "fusion";
    const explicitPipeline = (mixing.pipeline?.length ?? 0) > 0;
    const explicitPanel = (mixing.fusion?.panel?.length ?? 0) > 0;
    const pipelineHasResolvedStage = explicitPipeline
      ? mixing.pipeline!.some(target => isConfiguredTarget(config, target))
      : (mixing.agents ?? []).some(target =>
        isPipelineRole(target.role) && isConfiguredTarget(config, target)
      );
    const pipelineFallbackAgentIndex = pipelineMode && !pipelineHasResolvedStage
      ? (mixing.agents ?? []).findIndex(target => isConfiguredTarget(config, target))
      : -1;
    const coordinatorActive = (routeMode && mode === "coordinator")
      || (fusionMode
        && isConfiguredTarget(config, mixing.coordinator)
        && (
          !isConfiguredTarget(config, mixing.fusion?.judge)
          || !isConfiguredTarget(config, mixing.fusion?.synthesizer)
        ));

    if (mixing.coordinator) {
      owners.push(targetOwner(
        "mix-coordinator",
        "mix-coordinator",
        mixing.coordinator.provider,
        mixing.coordinator.model,
        "Mixing coordinator",
        coordinatorActive,
      ));
    }
    for (const [index, target] of (mixing.agents ?? []).entries()) {
      const pipelineRole = isPipelineRole(target.role);
      const active = routeMode
        || (pipelineMode && !explicitPipeline && pipelineRole)
        || (pipelineMode && index === pipelineFallbackAgentIndex)
        || (fusionMode && !explicitPanel);
      owners.push(targetOwner(
        `mix-agent:${index}`,
        "mix-agent",
        target.provider,
        target.model,
        `Mixing agent ${index + 1}`,
        active,
      ));
    }
    for (const [index, target] of (mixing.pipeline ?? []).entries()) {
      owners.push(targetOwner(
        `mix-pipeline:${index}`,
        "mix-pipeline",
        target.provider,
        target.model,
        `Mixing pipeline stage ${index + 1}`,
        pipelineMode && explicitPipeline,
      ));
    }
    for (const [index, target] of (mixing.fusion?.panel ?? []).entries()) {
      owners.push(targetOwner(
        `mix-panel:${index}`,
        "mix-panel",
        target.provider,
        target.model,
        `Mixing panel member ${index + 1}`,
        fusionMode && explicitPanel,
      ));
    }
    if (mixing.fusion?.judge) {
      owners.push(targetOwner(
        "mix-judge",
        "mix-judge",
        mixing.fusion.judge.provider,
        mixing.fusion.judge.model,
        "Mixing judge",
        fusionMode,
      ));
    }
    if (mixing.fusion?.synthesizer) {
      owners.push(targetOwner(
        "mix-synthesizer",
        "mix-synthesizer",
        mixing.fusion.synthesizer.provider,
        mixing.fusion.synthesizer.model,
        "Mixing synthesizer",
        fusionMode,
      ));
    }
    for (const [index, target] of (mixing.rules ?? []).entries()) {
      owners.push(targetOwner(
        `mix-rule:${index}`,
        "mix-rule",
        target.provider,
        target.model,
        `Mixing rule ${index + 1}`,
        routeMode && mode === "rules",
      ));
    }
  }

  const webSearch = helperTarget(
    config,
    config.webSearchFallback,
    DEFAULT_WEB_SEARCH_FALLBACK_MODEL,
  );
  if (webSearch) {
    owners.push(targetOwner(
      "web-search-helper",
      "web-search-helper",
      webSearch.provider,
      webSearch.model,
      "Web-search helper",
      config.webSearchFallback?.enabled === true,
    ));
  }
  const image = helperTarget(
    config,
    config.imageFallback,
    DEFAULT_IMAGE_FALLBACK_MODEL,
  );
  if (image) {
    owners.push(targetOwner(
      "image-helper",
      "image-helper",
      image.provider,
      image.model,
      "Image helper",
      config.imageFallback?.enabled === true,
    ));
  }
  return owners;
}

function helperTarget(
  config: FrogConfig,
  settings: { enabled?: boolean; provider?: string; model?: string } | undefined,
  defaultModel: string,
): { provider: string; model: string } | null {
  if (!settings) return null;
  const provider = settings.provider
    ?? findOpenAIResponsesFallbackProviderEntry(config)?.name
    ?? "";
  return { provider, model: settings.model ?? defaultModel };
}

function targetOwner(
  id: string,
  kind: ModelContinuityReferenceKind,
  provider: string | undefined,
  model: string | undefined,
  label: string,
  active: boolean,
): ReferenceOwner {
  return { id, kind, primary: targetPrimary(provider, model), label, active };
}

function targetPrimary(provider: string | undefined, model: string | undefined): string {
  return `${provider ?? ""}/${model ?? ""}`;
}

function isConfiguredTarget(
  config: FrogConfig,
  target: { provider?: string; model?: string } | undefined,
): boolean {
  return Boolean(
    target
    && typeof target.provider === "string"
    && target.provider.length > 0
    && typeof target.model === "string"
    && target.model.length > 0
    && config.providers[target.provider],
  );
}

function isPipelineRole(role: string | undefined): boolean {
  return role === "thinker" || role === "worker" || role === "verifier";
}

function referenceRemovable(config: FrogConfig, owner: ReferenceOwner): boolean {
  if (owner.kind === "provider-default" || owner.kind === "gateway-alias") return false;
  if (owner.kind === "classifier") return config.autoModeClassifierEnabled !== true;
  return true;
}

function referenceStatus(
  primary: string,
  validatePolicy: boolean,
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
  if (validatePolicy && !continuityPolicyStructureValid(primary, policy)) {
    return "policy_invalid";
  }
  if (row.authReady === false) return "authentication_required";
  return "ready";
}

function continuityPolicyStructureValid(primary: string, policy: ModelContinuityPolicy): boolean {
  if (!isContinuityAutomatic(policy.automatic) || policy.fallbacks.length > MAX_CONTINUITY_FALLBACKS) {
    return false;
  }
  const seen = new Set<string>();
  for (const fallback of policy.fallbacks) {
    if (fallback === primary || seen.has(fallback)) return false;
    seen.add(fallback);
  }
  return true;
}

function findRemovalReferencePrimary(config: FrogConfig, referenceId: string): string | null {
  if (referenceId === "long-context") {
    const target = config.longContext;
    return target ? targetPrimary(target.provider, target.model) : null;
  }
  if (referenceId === "classifier") {
    const target = config.autoModeClassifier;
    return target ? targetPrimary(target.provider, target.model) : null;
  }
  if (referenceId === "mix-coordinator") {
    const target = config.modelMixing?.coordinator;
    return target ? targetPrimary(target.provider, target.model) : null;
  }
  if (referenceId === "mix-judge") {
    const target = config.modelMixing?.fusion?.judge;
    return target ? targetPrimary(target.provider, target.model) : null;
  }
  if (referenceId === "mix-synthesizer") {
    const target = config.modelMixing?.fusion?.synthesizer;
    return target ? targetPrimary(target.provider, target.model) : null;
  }
  if (referenceId === "web-search-helper") {
    const target = helperTarget(config, config.webSearchFallback, DEFAULT_WEB_SEARCH_FALLBACK_MODEL);
    return target ? targetPrimary(target.provider, target.model) : null;
  }
  if (referenceId === "image-helper") {
    const target = helperTarget(config, config.imageFallback, DEFAULT_IMAGE_FALLBACK_MODEL);
    return target ? targetPrimary(target.provider, target.model) : null;
  }

  const indexed = parseIndexedReferenceId(referenceId);
  if (!indexed) return null;
  if (indexed.kind === "subagent") {
    const configuredModel = config.subagentModels?.[indexed.index];
    return typeof configuredModel === "string"
      ? resolvedSubagentPrimary(config, configuredModel)
      : null;
  }
  const target = indexedTargets(config, indexed.kind)?.[indexed.index];
  return target ? targetPrimary(target.provider, target.model) : null;
}

function findMutableReferenceOwner(
  config: FrogConfig,
  referenceId: string,
): MutableReferenceOwner | null {
  const policyCandidate = findPolicyCandidateReference(config, referenceId);
  if (policyCandidate) {
    return {
      kind: "continuity-policy-candidate",
      primary: policyCandidate.primary,
      replace: target => {
        policyCandidate.policy.fallbacks[policyCandidate.index] = `${target.provider}/${target.model}`;
      },
    };
  }
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
    return target ? objectReferenceOwner("long-context", target) : null;
  }
  if (referenceId === "classifier") {
    const target = config.autoModeClassifier;
    return target ? objectReferenceOwner("classifier", target) : null;
  }
  if (referenceId === "mix-coordinator") {
    const target = config.modelMixing?.coordinator;
    return target ? objectReferenceOwner("mix-coordinator", target) : null;
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
    const settings = config.webSearchFallback;
    const target = helperTarget(config, settings, DEFAULT_WEB_SEARCH_FALLBACK_MODEL);
    if (!settings || !target) return null;
    return {
      kind: "web-search-helper",
      primary: `${target.provider}/${target.model}`,
      replace: replacement => {
        settings.provider = replacement.provider;
        settings.model = replacement.model;
      },
    };
  }
  if (referenceId === "image-helper") {
    const settings = config.imageFallback;
    const target = helperTarget(config, settings, DEFAULT_IMAGE_FALLBACK_MODEL);
    if (!settings || !target) return null;
    return {
      kind: "image-helper",
      primary: `${target.provider}/${target.model}`,
      replace: replacement => {
        settings.provider = replacement.provider;
        settings.model = replacement.model;
      },
    };
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
): MutableReferenceOwner {
  return {
    kind,
    primary: targetPrimary(target.provider, target.model),
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

function findPolicyCandidateReference(
  config: FrogConfig,
  referenceId: string,
): {
  policyPrimary: string;
  index: number;
  primary: string;
  policy: ModelContinuityPolicy;
} | null {
  const parsed = parsePolicyCandidateReferenceId(referenceId);
  if (!parsed) return null;
  const policy = config.modelContinuity?.[parsed.policyPrimary];
  const primary = policy?.fallbacks[parsed.index];
  if (!policy || typeof primary !== "string") return null;
  return { ...parsed, primary, policy };
}

function parsePolicyCandidateReferenceId(
  referenceId: string,
): { policyPrimary: string; index: number } | null {
  const match = /^continuity-policy-candidate:(.+):(0|[1-9]\d*)$/.exec(referenceId);
  if (!match) return null;
  try {
    const policyPrimary = decodeURIComponent(match[1]);
    if (!policyPrimary) return null;
    return { policyPrimary, index: Number(match[2]) };
  } catch {
    return null;
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
  return parsePolicyCandidateReferenceId(referenceId) !== null
    || parseIndexedReferenceId(referenceId) !== null;
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

import { useEffect, useId, useMemo, useRef, useState } from "react";
import type { DragEvent } from "react";
import { Switch, Notice } from "../ui";
import { IconArrowDown, IconArrowUp, IconCheck, IconChevron, IconSearch } from "../icons";
import { useT, Trans, type TFn, type TKey } from "../i18n";
import type { DeepLinkTarget } from "../navigation";

export type ModelSupportStatus = "validated" | "discovered" | "unknown";
interface ModelRow { provider: string; id: string; namespaced: string; disabled: boolean; authReady: boolean; supportStatus: ModelSupportStatus }
interface FeaturedModelsResponse { available?: string[]; chosen?: string[] }
interface ModelControlRow { provider: string | null; id: string; namespaced: string; disabled: boolean; canHide: boolean; authReady: boolean; supportStatus: ModelSupportStatus }
interface ProviderVisibilitySummary { provider: string; visible: number; hidden: number }

export interface ModelCatalogStatus {
  source: "remote" | "cached" | "bundled";
  catalogRevision: number;
  sourceCommit: string;
  refreshedAt?: string;
  skippedRecords: number;
  warningCount: number;
}

export function parseCatalogStatus(value: unknown): ModelCatalogStatus {
  if (!value || typeof value !== "object") throw new Error("catalog status response must be an object");
  if (!("source" in value) || (value.source !== "remote" && value.source !== "cached" && value.source !== "bundled")) {
    throw new Error("invalid catalog source");
  }
  if (!("catalogRevision" in value) || typeof value.catalogRevision !== "number" || !Number.isInteger(value.catalogRevision) || value.catalogRevision < 0) {
    throw new Error("invalid catalog revision");
  }
  if (!("sourceCommit" in value) || typeof value.sourceCommit !== "string" || !/^[0-9a-f]{40}$/.test(value.sourceCommit)) {
    throw new Error("invalid catalog source commit");
  }
  if ("refreshedAt" in value && value.refreshedAt !== undefined && (typeof value.refreshedAt !== "string" || !Number.isFinite(Date.parse(value.refreshedAt)))) {
    throw new Error("invalid catalog refresh time");
  }
  if (!("skippedRecords" in value) || typeof value.skippedRecords !== "number" || !Number.isInteger(value.skippedRecords) || value.skippedRecords < 0) {
    throw new Error("invalid skipped record count");
  }
  let warningCount = 0;
  if ("warnings" in value) {
    const warnings = value.warnings;
    if (
      !warnings
      || typeof warnings !== "object"
      || !("count" in warnings)
      || typeof warnings.count !== "number"
      || !Number.isInteger(warnings.count)
      || warnings.count < 0
    ) {
      throw new Error("invalid catalog warnings");
    }
    warningCount = warnings.count;
  }
  return {
    source: value.source,
    catalogRevision: value.catalogRevision,
    sourceCommit: value.sourceCommit,
    ...("refreshedAt" in value && typeof value.refreshedAt === "string" ? { refreshedAt: value.refreshedAt } : {}),
    skippedRecords: value.skippedRecords,
    warningCount,
  };
}

export function ModelSupportStatusBadge({ status, t }: { status: ModelSupportStatus; t: TFn }) {
  const label = status === "validated"
    ? t("models.support.validated")
    : status === "discovered"
      ? t("models.support.discovered")
      : t("models.support.unknown");
  const className = status === "validated" ? "badge-green" : status === "discovered" ? "badge-accent" : "badge-amber";
  return <span className={`badge ${className}`}>{label}</span>;
}

export function ModelCatalogStatusSummary({
  status,
  t,
  onRefresh,
}: {
  status: ModelCatalogStatus | null;
  t: TFn;
  onRefresh: () => void;
}) {
  const confirmedCurrent = status?.source === "remote" || status?.refreshedAt !== undefined;
  const needsAttention = status === null
    || !confirmedCurrent
    || status.skippedRecords > 0
    || status.warningCount > 0;
  const title = status === null
    ? t("models.catalog.unavailable")
    : !confirmedCurrent && status.source === "cached"
      ? t("models.catalog.cached")
      : !confirmedCurrent && status.source === "bundled"
        ? t("models.catalog.bundled")
        : needsAttention
          ? t("models.catalog.review")
          : t("models.catalog.remote");
  return (
    <div className={`models-status-card${needsAttention ? " warn" : ""}`}>
      <div className="models-status-label">{title}</div>
      {status ? (
        <>
          <p>{t("models.catalog.details", {
            revision: status.catalogRevision,
            commit: status.sourceCommit.slice(0, 8),
            refreshedAt: status.refreshedAt?.replace("T", " ").replace("Z", " UTC") ?? t("models.catalog.noRefresh"),
          })}</p>
          {status.skippedRecords > 0 && <p>{t("models.catalog.skipped", { n: status.skippedRecords })}</p>}
          {status.warningCount > 0 && <p>{t("models.catalog.warnings", { n: status.warningCount })}</p>}
        </>
      ) : (
        <p>{t("models.catalog.unavailableBody")}</p>
      )}
      <p>{t("models.catalog.nextCheck")}</p>
      <button className="btn btn-ghost btn-sm" type="button" onClick={onRefresh}>{t("models.refreshDashboard")}</button>
    </div>
  );
}

export type ModelContinuityAutomatic = "off" | "retired" | "transient" | "all";
export type ModelContinuityStatus = "ready" | "retired" | "authentication_required" | "policy_invalid";
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
export type ModelContinuityReason =
  | "retired"
  | "connect_failure"
  | "connect_timeout"
  | "http_404"
  | "http_410"
  | "http_429"
  | "http_5xx"
  | "circuit_open";

export interface ModelContinuityPolicy {
  fallbacks: string[];
  automatic: ModelContinuityAutomatic;
}

export interface ModelContinuityReference {
  id: string;
  kind: ModelContinuityReferenceKind;
  primary: string;
  status: ModelContinuityStatus;
  automaticEligible: boolean;
  policy: ModelContinuityPolicy;
  supportStatus: ModelSupportStatus;
  label?: string;
}

export interface ModelContinuityReport {
  policies: Record<string, ModelContinuityPolicy>;
  references: ModelContinuityReference[];
  circuits: Array<{ primary: string; reason: ModelContinuityReason; retryAt: number }>;
}

export interface ModelContinuitySetAction {
  action: "set";
  primary: string;
  referenceId: string;
  fallbacks: string[];
  automatic: ModelContinuityAutomatic;
}

export interface ModelContinuityReplaceAction {
  action: "replace";
  referenceId: string;
  expectedPrimary: string;
  replacement: string;
}

export type ModelContinuityAction = ModelContinuitySetAction | ModelContinuityReplaceAction;

const CONTINUITY_AUTOMATIC_VALUES: Record<ModelContinuityAutomatic, true> = {
  off: true,
  retired: true,
  transient: true,
  all: true,
};
const CONTINUITY_STATUS_VALUES: Record<ModelContinuityStatus, true> = {
  ready: true,
  retired: true,
  authentication_required: true,
  policy_invalid: true,
};
const CONTINUITY_REFERENCE_KINDS: Record<ModelContinuityReferenceKind, true> = {
  "provider-default": true,
  "long-context": true,
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
  "gateway-alias": true,
};
const CONTINUITY_REASON_VALUES: Record<ModelContinuityReason, true> = {
  retired: true,
  connect_failure: true,
  connect_timeout: true,
  http_404: true,
  http_410: true,
  http_429: true,
  http_5xx: true,
  circuit_open: true,
};
const CONTINUITY_SUPPORT_VALUES: Record<ModelSupportStatus, true> = {
  validated: true,
  discovered: true,
  unknown: true,
};
const MAX_CONTINUITY_FALLBACKS = 3;

function recordValue(value: unknown, error: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(error);
  return value as Record<string, unknown>;
}

function requiredString(value: unknown, error: string): string {
  if (typeof value !== "string" || value.trim() === "") throw new Error(error);
  return value;
}

function parseModelContinuityPolicy(value: unknown): ModelContinuityPolicy {
  const policy = recordValue(value, "invalid model continuity policy");
  if (
    !Array.isArray(policy.fallbacks)
    || policy.fallbacks.length > MAX_CONTINUITY_FALLBACKS
    || !policy.fallbacks.every(item => typeof item === "string" && item.trim() !== "")
  ) {
    throw new Error("invalid model continuity fallbacks");
  }
  if (CONTINUITY_AUTOMATIC_VALUES[policy.automatic as ModelContinuityAutomatic] !== true) {
    throw new Error("invalid model continuity automatic mode");
  }
  return {
    fallbacks: [...policy.fallbacks] as string[],
    automatic: policy.automatic as ModelContinuityAutomatic,
  };
}

export function parseModelContinuityReport(value: unknown): ModelContinuityReport {
  const report = recordValue(value, "model continuity response must be an object");
  const rawPolicies = recordValue(report.policies, "invalid model continuity policies");
  if (!Array.isArray(report.references) || !Array.isArray(report.circuits)) {
    throw new Error("invalid model continuity response lists");
  }

  const policies: Record<string, ModelContinuityPolicy> = {};
  for (const [primary, policy] of Object.entries(rawPolicies)) {
    requiredString(primary, "invalid model continuity policy target");
    policies[primary] = parseModelContinuityPolicy(policy);
  }

  const references = report.references.map(value => {
    const reference = recordValue(value, "invalid model continuity reference");
    if (CONTINUITY_REFERENCE_KINDS[reference.kind as ModelContinuityReferenceKind] !== true) {
      throw new Error("invalid model continuity reference kind");
    }
    if (CONTINUITY_STATUS_VALUES[reference.status as ModelContinuityStatus] !== true) {
      throw new Error("invalid model continuity reference status");
    }
    if (typeof reference.automaticEligible !== "boolean") {
      throw new Error("invalid model continuity automatic eligibility");
    }
    if (CONTINUITY_SUPPORT_VALUES[reference.supportStatus as ModelSupportStatus] !== true) {
      throw new Error("invalid model continuity support status");
    }
    if (reference.label !== undefined && typeof reference.label !== "string") {
      throw new Error("invalid model continuity display label");
    }
    return {
      id: requiredString(reference.id, "invalid model continuity reference id"),
      kind: reference.kind as ModelContinuityReferenceKind,
      primary: requiredString(reference.primary, "invalid model continuity primary target"),
      status: reference.status as ModelContinuityStatus,
      automaticEligible: reference.automaticEligible,
      policy: parseModelContinuityPolicy(reference.policy),
      supportStatus: reference.supportStatus as ModelSupportStatus,
      ...(reference.label === undefined ? {} : { label: reference.label }),
    };
  });

  const circuits = report.circuits.map(value => {
    const entry = recordValue(value, "invalid model continuity active status");
    if (CONTINUITY_REASON_VALUES[entry.reason as ModelContinuityReason] !== true) {
      throw new Error("invalid model continuity reason");
    }
    if (typeof entry.retryAt !== "number" || !Number.isFinite(entry.retryAt) || entry.retryAt < 0) {
      throw new Error("invalid model continuity retry time");
    }
    return {
      primary: requiredString(entry.primary, "invalid model continuity active target"),
      reason: entry.reason as ModelContinuityReason,
      retryAt: entry.retryAt,
    };
  });

  return { policies, references, circuits };
}

export function updateModelContinuityFallback(
  fallbacks: readonly string[],
  index: number,
  replacement: string,
): string[] {
  if (!Number.isInteger(index) || index < 0 || index >= MAX_CONTINUITY_FALLBACKS) return [...fallbacks];
  const slots = Array.from({ length: MAX_CONTINUITY_FALLBACKS }, (_, slot) => fallbacks[slot] ?? "");
  slots[index] = replacement;
  return slots.filter(Boolean);
}

export type ModelContinuityLoadResult = "applied" | "failed" | "superseded";
export type ModelContinuityActionResult = "applied" | "failed" | "superseded";

export async function saveModelContinuityPolicy(
  reference: ModelContinuityReference,
  draft: ModelContinuityPolicy,
  send: (action: ModelContinuitySetAction) => Promise<ModelContinuityActionResult>,
): Promise<ModelContinuityPolicy | null> {
  try {
    const result = await send({
      action: "set",
      primary: reference.primary,
      referenceId: reference.id,
      fallbacks: [...draft.fallbacks],
      automatic: draft.automatic,
    });
    if (result === "applied") {
      return { fallbacks: [...draft.fallbacks], automatic: draft.automatic };
    }
    if (result === "superseded") return null;
  } catch {
    // The caller owns the visible error; restore the last server-confirmed policy below.
  }
  return { fallbacks: [...reference.policy.fallbacks], automatic: reference.policy.automatic };
}

export async function confirmModelContinuityReplacement(
  reference: ModelContinuityReference,
  replacement: string,
  confirm: () => boolean,
  send: (action: ModelContinuityReplaceAction) => Promise<ModelContinuityActionResult>,
): Promise<ModelContinuityActionResult> {
  if (!replacement || !confirm()) return "failed";
  return send({
    action: "replace",
    referenceId: reference.id,
    expectedPrimary: reference.primary,
    replacement,
  });
}

type ModelContinuityRequest = (input: string, init: RequestInit) => Promise<Response>;

export async function postModelContinuityAction(
  request: ModelContinuityRequest,
  apiBase: string,
  action: ModelContinuityAction,
  reloadStale: () => Promise<ModelContinuityLoadResult> | ModelContinuityLoadResult,
): Promise<{ ok: boolean; stale: boolean; reloadFailed: boolean; superseded: boolean; message: string }> {
  try {
    const response = await request(`${apiBase}/api/model-continuity`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(action),
    });
    const body = await response.json().catch(() => ({})) as { error?: unknown };
    const message = typeof body.error === "string" ? body.error : "";
    if (response.status === 409) {
      const reloaded = await reloadStale();
      return {
        ok: false,
        stale: reloaded === "applied",
        reloadFailed: reloaded === "failed",
        superseded: reloaded === "superseded",
        message,
      };
    }
    return { ok: response.ok, stale: false, reloadFailed: false, superseded: false, message };
  } catch {
    return { ok: false, stale: false, reloadFailed: false, superseded: false, message: "" };
  }
}

type ModelContinuityLoadCallbacks = {
  success: (report: ModelContinuityReport) => void;
  failure: () => void;
  settled: () => void;
};

export async function loadModelContinuityReport(
  request: (input: string) => Promise<Response>,
  apiBase: string,
  isLatest: () => boolean,
  callbacks: ModelContinuityLoadCallbacks,
): Promise<ModelContinuityLoadResult> {
  try {
    const response = await request(`${apiBase}/api/model-continuity`);
    if (!response.ok) throw new Error("model continuity load failed");
    const report = parseModelContinuityReport(await response.json());
    if (!isLatest()) return "superseded";
    callbacks.success(report);
    return "applied";
  } catch {
    if (!isLatest()) return "superseded";
    callbacks.failure();
    return "failed";
  } finally {
    if (isLatest()) callbacks.settled();
  }
}

const CONTINUITY_PURPOSE_KEYS: Record<ModelContinuityReferenceKind, TKey> = {
  "provider-default": "models.continuity.purpose.default",
  "long-context": "models.continuity.purpose.longContext",
  subagent: "models.continuity.purpose.subagent",
  classifier: "models.continuity.purpose.classifier",
  "mix-coordinator": "models.continuity.purpose.mixing",
  "mix-agent": "models.continuity.purpose.mixing",
  "mix-pipeline": "models.continuity.purpose.mixing",
  "mix-panel": "models.continuity.purpose.mixing",
  "mix-judge": "models.continuity.purpose.mixing",
  "mix-synthesizer": "models.continuity.purpose.mixing",
  "mix-rule": "models.continuity.purpose.mixing",
  "web-search-helper": "models.continuity.purpose.webSearch",
  "image-helper": "models.continuity.purpose.image",
  "gateway-alias": "models.continuity.purpose.savedName",
};
const CONTINUITY_REASON_KEYS: Record<ModelContinuityReason, TKey> = {
  retired: "models.continuity.reason.retired",
  connect_failure: "models.continuity.reason.connectFailure",
  connect_timeout: "models.continuity.reason.connectTimeout",
  http_404: "models.continuity.reason.notFound",
  http_410: "models.continuity.reason.gone",
  http_429: "models.continuity.reason.busy",
  http_5xx: "models.continuity.reason.service",
  circuit_open: "models.continuity.reason.temporary",
};
const CONTINUITY_FALLBACK_LABEL_KEYS: TKey[] = [
  "models.continuity.fallback.first",
  "models.continuity.fallback.second",
  "models.continuity.fallback.third",
];

function continuityPurpose(reference: ModelContinuityReference, t: TFn): string {
  return t(CONTINUITY_PURPOSE_KEYS[reference.kind]);
}

function continuityProblemTitle(reference: ModelContinuityReference, t: TFn): string {
  const purpose = continuityPurpose(reference, t);
  if (reference.status === "retired") return t("models.continuity.problem.retired", { purpose });
  if (reference.status === "authentication_required") return t("models.continuity.problem.authentication", { purpose });
  if (reference.status === "policy_invalid") return t("models.continuity.problem.policy", { purpose });
  if (reference.policy.automatic !== "off" && reference.automaticEligible) {
    return t("models.continuity.problem.automatic", { purpose });
  }
  return purpose;
}

function continuityImpact(reference: ModelContinuityReference, t: TFn): string {
  if (reference.status === "retired") return t("models.continuity.impact.retired");
  if (reference.status === "authentication_required") return t("models.continuity.impact.authentication");
  if (reference.status === "policy_invalid") return t("models.continuity.impact.policy");
  return t("models.continuity.impact.ready");
}

function continuityReasonText(reason: ModelContinuityReason, t: TFn): string {
  return t(CONTINUITY_REASON_KEYS[reason]);
}

function ContinuityReferenceCard({
  reference,
  selectableModels,
  t,
  onSet,
  onReplace,
}: {
  reference: ModelContinuityReference;
  selectableModels: readonly string[];
  t: TFn;
  onSet: (action: ModelContinuitySetAction) => Promise<ModelContinuityActionResult>;
  onReplace: (action: ModelContinuityReplaceAction) => Promise<ModelContinuityActionResult>;
}) {
  const [draft, setDraft] = useState<ModelContinuityPolicy>({
    fallbacks: [...reference.policy.fallbacks],
    automatic: reference.policy.automatic,
  });
  const [replacement, setReplacement] = useState("");
  const [saving, setSaving] = useState(false);
  const fieldId = useId();
  const purpose = continuityPurpose(reference, t);

  useEffect(() => {
    setDraft({ fallbacks: [...reference.policy.fallbacks], automatic: reference.policy.automatic });
    setReplacement("");
  }, [reference.primary, reference.policy.automatic, reference.policy.fallbacks.join("\u0000")]);

  const saveDraft = async () => {
    if (saving) return;
    setSaving(true);
    try {
      const saved = await saveModelContinuityPolicy(reference, draft, onSet);
      if (saved) setDraft(saved);
    } finally {
      setSaving(false);
    }
  };

  const replace = async () => {
    if (saving || !replacement) return;
    setSaving(true);
    try {
      const replaced = await confirmModelContinuityReplacement(
        reference,
        replacement,
        () => window.confirm(t("models.continuity.replaceConfirm", { purpose, model: replacement })),
        onReplace,
      );
      if (replaced === "applied") setReplacement("");
    } finally {
      setSaving(false);
    }
  };

  const candidateModels = selectableModels.filter(model => model !== reference.primary);

  return (
    <article className={`continuity-card${reference.status === "ready" ? "" : " attention"}`}>
      <div className="continuity-card-head">
        <div>
          <h4>{continuityProblemTitle(reference, t)}</h4>
          <p>{continuityImpact(reference, t)}</p>
        </div>
        <span className={`badge ${reference.status === "ready" ? "badge-green" : "badge-amber"}`}>
          {reference.status === "ready" ? t("models.continuity.status.ready") : t("models.continuity.status.attention")}
        </span>
      </div>

      <dl className="continuity-facts">
        <div><dt>{t("models.continuity.currentModel")}</dt><dd><code className="text-anywhere">{reference.primary}</code></dd></div>
        <div>
          <dt>{t("models.continuity.reason")}</dt>
          <dd>{reference.status === "ready" ? t("models.continuity.reason.ready") : continuityImpact(reference, t)}</dd>
        </div>
        <div>
          <dt>{t("models.continuity.savedFallbacks")}</dt>
          <dd>
            {reference.policy.fallbacks.length > 0
              ? <ol className="continuity-fallback-order">{reference.policy.fallbacks.map(model => <li key={model}><code className="text-anywhere">{model}</code></li>)}</ol>
              : t("models.continuity.noFallbacks")}
          </dd>
        </div>
      </dl>

      {reference.automaticEligible ? (
        <div className="continuity-policy-editor">
          <div className="continuity-field">
            <label htmlFor={`${fieldId}-automatic`}>{t("models.continuity.automaticScope")}</label>
            <select
              id={`${fieldId}-automatic`}
              className="select-sm"
              value={draft.automatic}
              disabled={saving}
              aria-label={t("models.continuity.automaticScope")}
              onChange={event => setDraft(current => ({
                ...current,
                automatic: event.target.value as ModelContinuityAutomatic,
              }))}
            >
              <option value="off">{t("models.continuity.automatic.off")}</option>
              <option value="retired">{t("models.continuity.automatic.retired")}</option>
              <option value="transient">{t("models.continuity.automatic.transient")}</option>
              <option value="all">{t("models.continuity.automatic.all")}</option>
            </select>
          </div>

          <div className="continuity-fallback-fields">
            {CONTINUITY_FALLBACK_LABEL_KEYS.map((labelKey, index) => {
              const currentValue = draft.fallbacks[index] ?? "";
              const options = candidateModels.filter(model =>
                model === currentValue || !draft.fallbacks.some((selected, selectedIndex) => selectedIndex !== index && selected === model)
              );
              const enabled = index === 0 || Boolean(draft.fallbacks[index - 1]);
              return (
                <div className="continuity-field" key={labelKey}>
                  <label htmlFor={`${fieldId}-fallback-${index}`}>{t(labelKey)}</label>
                  <select
                    id={`${fieldId}-fallback-${index}`}
                    className="select-sm"
                    value={currentValue}
                    disabled={saving || !enabled}
                    aria-label={t(labelKey)}
                    onChange={event => setDraft(current => ({
                      ...current,
                      fallbacks: updateModelContinuityFallback(current.fallbacks, index, event.target.value),
                    }))}
                  >
                    <option value="">{t("models.continuity.fallback.none")}</option>
                    {currentValue && !candidateModels.includes(currentValue) && (
                      <option value={currentValue}>{currentValue} · {t("models.continuity.fallback.unavailable")}</option>
                    )}
                    {options.map(model => <option key={model} value={model}>{model}</option>)}
                  </select>
                </div>
              );
            })}
          </div>

          <button
            type="button"
            className="btn btn-ghost"
            disabled={saving}
            aria-label={t("models.continuity.saveAutomatic")}
            onClick={() => void saveDraft()}
          >
            {saving ? t("prov.savingDefault") : t("models.continuity.saveAutomatic")}
          </button>
        </div>
      ) : (
        <p className="continuity-manual-only">{t("models.continuity.manualOnly")}</p>
      )}

      <div className="continuity-replace">
        <div className="continuity-field">
          <label htmlFor={`${fieldId}-replacement`}>{t("models.continuity.replaceModel")}</label>
          <select
            id={`${fieldId}-replacement`}
            className="select-sm"
            value={replacement}
            disabled={saving}
            aria-label={t("models.continuity.replaceModel")}
            onChange={event => setReplacement(event.target.value)}
          >
            <option value="">{t("models.continuity.replaceChoose")}</option>
            {candidateModels.map(model => <option key={model} value={model}>{model}</option>)}
          </select>
        </div>
        <button
          type="button"
          className="btn btn-primary"
          disabled={saving || !replacement}
          aria-label={t("models.continuity.replace")}
          onClick={() => void replace()}
        >
          {t("models.continuity.replace")}
        </button>
      </div>
    </article>
  );
}

export function ModelContinuityPanel({
  report,
  selectableModels = [],
  t,
  onSet,
  onReplace,
}: {
  report: ModelContinuityReport;
  selectableModels?: readonly string[];
  t: TFn;
  onSet: (action: ModelContinuitySetAction) => Promise<ModelContinuityActionResult>;
  onReplace: (action: ModelContinuityReplaceAction) => Promise<ModelContinuityActionResult>;
}) {
  const attention = report.references.filter(reference => reference.status !== "ready");
  const automatic = report.references.filter(reference =>
    reference.status === "ready"
    && reference.automaticEligible
    && reference.policy.automatic !== "off"
  );
  const normal = report.references.filter(reference =>
    reference.status === "ready"
    && (!reference.automaticEligible || reference.policy.automatic === "off")
  );

  return (
    <section className="panel continuity-panel" aria-labelledby="model-continuity-title">
      <div className="continuity-panel-head">
        <div>
          <div className="eyebrow">{t("models.continuity.eyebrow")}</div>
          <h3 id="model-continuity-title">{attention.length > 0 ? t("models.continuity.titleAttention") : t("models.continuity.titleReady")}</h3>
          <p>{attention.length > 0 ? t("models.continuity.introAttention") : t("models.continuity.introReady")}</p>
        </div>
        <span className={`badge ${attention.length > 0 ? "badge-amber" : "badge-green"}`}>
          {attention.length > 0
            ? t("models.continuity.attentionCount", { n: attention.length })
            : t("models.continuity.status.ready")}
        </span>
      </div>


      {attention.length > 0 && (
        <div className="continuity-card-list">
          {attention.map(reference => (
            <ContinuityReferenceCard
              key={reference.id}
              reference={reference}
              selectableModels={selectableModels}
              t={t}
              onSet={onSet}
              onReplace={onReplace}
            />
          ))}
        </div>
      )}
      {report.circuits.length > 0 && (
        <div className="continuity-active-status" role="status">
          <strong>{t("models.continuity.activeTitle")}</strong>
          <p>{t("models.continuity.activeImpact")}</p>
          <ul>
            {report.circuits.map(entry => (
              <li key={entry.primary}>
                <code className="text-anywhere">{entry.primary}</code>
                <span>{continuityReasonText(entry.reason, t)}</span>
              </li>
            ))}
          </ul>
        </div>
      )}

      {automatic.length > 0 && (
        <div className="continuity-automatic-list">
          <h4>{t("models.continuity.automaticActive")}</h4>
          {automatic.map(reference => (
            <ContinuityReferenceCard
              key={reference.id}
              reference={reference}
              selectableModels={selectableModels}
              t={t}
              onSet={onSet}
              onReplace={onReplace}
            />
          ))}
        </div>
      )}

      {normal.length > 0 && (
        <details className="continuity-normal-list">
          <summary>{t("models.continuity.normalSummary", { n: normal.length })}</summary>
          <div className="continuity-card-list">
            {normal.map(reference => (
              <ContinuityReferenceCard
                key={reference.id}
                reference={reference}
                selectableModels={selectableModels}
                t={t}
                onSet={onSet}
                onReplace={onReplace}
              />
            ))}
          </div>
        </details>
      )}
    </section>
  );
}

export function parseModelRows(value: unknown): ModelRow[] {
  if (!Array.isArray(value)) throw new Error("models response must be an array");
  return value.map(item => {
    if (!item || typeof item !== "object") throw new Error("invalid model row");
    if (
      !("provider" in item) || typeof item.provider !== "string"
      || !("id" in item) || typeof item.id !== "string"
      || !("namespaced" in item) || typeof item.namespaced !== "string"
    ) {
      throw new Error("invalid model row");
    }
    return {
      provider: item.provider,
      id: item.id,
      namespaced: item.namespaced,
      disabled: "disabled" in item && item.disabled === true,
      authReady: !("authReady" in item) || item.authReady !== false,
      supportStatus: "supportStatus" in item && (item.supportStatus === "validated" || item.supportStatus === "discovered")
        ? item.supportStatus
        : "unknown",
    };
  });
}

function parseFeaturedModels(value: unknown): Required<FeaturedModelsResponse> {
  if (!value || typeof value !== "object") throw new Error("featured models response must be an object");
  const data = value as FeaturedModelsResponse;
  if (!Array.isArray(data.available) || !data.available.every(item => typeof item === "string")) {
    throw new Error("invalid featured available models");
  }
  if (!Array.isArray(data.chosen) || !data.chosen.every(item => typeof item === "string")) {
    throw new Error("invalid featured chosen models");
  }
  return { available: data.available, chosen: data.chosen };
}

function splitModelName(model: string): { provider: string | null; id: string } {
  const slash = model.indexOf("/");
  if (slash <= 0) return { provider: null, id: model };
  return { provider: model.slice(0, slash), id: model.slice(slash + 1) };
}

export default function Models({ apiBase, target }: { apiBase: string; target?: DeepLinkTarget | null }) {
  const t = useT();
  const [models, setModels] = useState<ModelRow[]>([]);
  const [disabled, setDisabled] = useState<Set<string>>(new Set());
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  const [status, setStatus] = useState("");
  const [ok, setOk] = useState(false);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const busyRef = useRef(false);
  const [catalogStatus, setCatalogStatus] = useState<ModelCatalogStatus | null>(null);
  const [continuityReport, setContinuityReport] = useState<ModelContinuityReport | null>(null);
  const [continuityLoading, setContinuityLoading] = useState(true);
  const [continuityStatus, setContinuityStatus] = useState("");
  const [continuityOk, setContinuityOk] = useState(false);

  const [featuredAvailable, setFeaturedAvailable] = useState<string[]>([]);
  const [featuredChosen, setFeaturedChosen] = useState<string[]>([]);
  const [featuredQuery, setFeaturedQuery] = useState("");
  const [featuredStatus, setFeaturedStatus] = useState("");
  const [featuredOk, setFeaturedOk] = useState(false);
  const [featuredLoading, setFeaturedLoading] = useState(true);
  const [featuredSaving, setFeaturedSaving] = useState(false);
  const [featuredDirty, setFeaturedDirty] = useState(false);
  const [draggedFeatured, setDraggedFeatured] = useState<string | null>(null);
  const [dragOverFeatured, setDragOverFeatured] = useState<string | null>(null);
  const featuredDirtyRef = useRef(false);
  const featuredSavingRef = useRef(false);
  const featuredLoadSeqRef = useRef(0);
  const continuityLoadSeqRef = useRef(0);
  const modelControlsRef = useRef<HTMLElement | null>(null);

  const loadFeatured = async (force = false) => {
    if (!force && (featuredDirtyRef.current || featuredSavingRef.current)) return;
    const requestId = ++featuredLoadSeqRef.current;
    try {
      const res = await fetch(`${apiBase}/api/subagent-models`);
      if (!res.ok) throw new Error("featured load failed");
      const data = parseFeaturedModels(await res.json());
      if (requestId !== featuredLoadSeqRef.current) return;
      if (!force && (featuredDirtyRef.current || featuredSavingRef.current)) return;
      setFeaturedAvailable(data.available);
      setFeaturedChosen(data.chosen.filter(model => data.available.includes(model)));
      featuredDirtyRef.current = false;
      setFeaturedDirty(false);
    } catch {
      setFeaturedOk(false);
      setFeaturedStatus(t("models.featuredLoadFail"));
    } finally {
      setFeaturedLoading(false);
    }
  };

  const loadContinuity = async (): Promise<ModelContinuityLoadResult> => {
    const requestId = ++continuityLoadSeqRef.current;
    setContinuityLoading(true);
    return loadModelContinuityReport(
      input => fetch(input),
      apiBase,
      () => requestId === continuityLoadSeqRef.current,
      {
        success: report => {
          setContinuityReport(report);
          setContinuityStatus("");
        },
        failure: () => {
          setContinuityOk(false);
          setContinuityStatus(t("models.continuity.loadFailed"));
        },
        settled: () => setContinuityLoading(false),
      },
    );
  };

  const loadModels = async () => {
    try {
      const [modelsResponse, catalogResponse] = await Promise.all([
        fetch(`${apiBase}/api/models`),
        fetch(`${apiBase}/api/model-catalog/status`).catch(() => null),
      ]);
      if (!modelsResponse.ok) throw new Error("models load failed");
      const data = parseModelRows(await modelsResponse.json());
      setModels(data);
      setDisabled(new Set(data.filter(m => m.disabled).map(m => m.namespaced)));
      if (catalogResponse?.ok) {
        try {
          setCatalogStatus(parseCatalogStatus(await catalogResponse.json()));
        } catch {
          setCatalogStatus(null);
        }
      } else {
        setCatalogStatus(null);
      }
    } catch {
      setOk(false); setStatus(t("models.loadFail"));
    } finally {
      setLoading(false);
    }
  };

  const refreshAll = () => {
    setLoading(true);
    void loadModels();
    void loadContinuity();
    void loadFeatured(true);
  };

  useEffect(() => {
    void loadModels();
    void loadContinuity();
    void loadFeatured(true);
    // Provider models resolve lazily (live /models + OAuth tokens), so a provider that wasn't ready
    // on first load would otherwise stay missing until a manual remove/re-add.
    // Re-poll to pick it up; skip while a toggle PUT is in flight to avoid clobbering.
    const timer = setInterval(() => { if (!busyRef.current) { void loadModels(); void loadFeatured(); } }, 10000);
    return () => clearInterval(timer);
  }, [apiBase]);

  useEffect(() => {
    if (target === "model-visibility-row") modelControlsRef.current?.scrollIntoView({ block: "start", behavior: "smooth" });
    if (target === "model-refresh") {
      modelControlsRef.current?.scrollIntoView({ block: "start", behavior: "smooth" });
      refreshAll();
    }
  }, [target]);

  const activeCount = models.filter(model => !disabled.has(model.namespaced) && model.authReady).length;
  const providerHiddenSummaries = useMemo<ProviderVisibilitySummary[]>(() => {
    const summaries = new Map<string, ProviderVisibilitySummary>();
    for (const model of models) {
      const summary = summaries.get(model.provider) ?? { provider: model.provider, visible: 0, hidden: 0 };
      if (disabled.has(model.namespaced)) summary.hidden += 1;
      else if (model.authReady) summary.visible += 1;
      summaries.set(model.provider, summary);
    }
    return [...summaries.values()]
      .filter(summary => summary.hidden > 0)
      .sort((a, b) => a.provider.localeCompare(b.provider));
  }, [models, disabled]);

  const providerHiddenSummaryText = providerHiddenSummaries
    .map(summary => t("models.providerHiddenSummaryItem", {
      provider: summary.provider,
      visible: summary.visible,
      hidden: summary.hidden,
    }))
    .join("; ");
  const hiddenCount = disabled.size;
  const authUnavailableCount = models.filter(model => !disabled.has(model.namespaced) && !model.authReady).length;
  const featuredSelected = useMemo(() => new Set(featuredChosen), [featuredChosen]);

  const controlRows = useMemo<ModelControlRow[]>(() => {
    const rows: ModelControlRow[] = [];
    const seen = new Set<string>();
    for (const model of models) {
      seen.add(model.namespaced);
      rows.push({
        provider: model.provider,
        id: model.id,
        namespaced: model.namespaced,
        disabled: disabled.has(model.namespaced),
        canHide: true,
        authReady: model.authReady,
        supportStatus: model.supportStatus,
      });
    }
    for (const model of featuredAvailable) {
      if (seen.has(model)) continue;
      const parts = splitModelName(model);
      rows.push({
        provider: parts.provider,
        id: parts.id,
        namespaced: model,
        disabled: false,
        canHide: false,
        authReady: true,
        supportStatus: "unknown",
      });
    }
    return rows;
  }, [models, disabled, featuredAvailable]);

  const selectableContinuityModels = useMemo(
    () => models
      .filter(model => !disabled.has(model.namespaced) && model.authReady)
      .map(model => model.namespaced),
    [models, disabled],
  );

  const featuredRows = useMemo<ModelControlRow[]>(() => {
    const byName = new Map(controlRows.map(row => [row.namespaced, row]));
    return featuredChosen.map(model => {
      const row = byName.get(model);
      if (row) return row;
      const parts = splitModelName(model);
      return {
        provider: parts.provider,
        id: parts.id,
        namespaced: model,
        disabled: false,
        canHide: false,
        authReady: true,
        supportStatus: "unknown",
      };
    });
  }, [controlRows, featuredChosen]);

  const filteredRows = useMemo(() => {
    const q = featuredQuery.trim().toLowerCase();
    return controlRows.filter(row => !q || row.namespaced.toLowerCase().includes(q));
  }, [controlRows, featuredQuery]);

  const groupedRows = useMemo(() => {
    const groups = new Map<string, ModelControlRow[]>();
    for (const row of filteredRows) {
      const key = row.provider ?? "__claude_code__";
      const bucket = groups.get(key) ?? [];
      bucket.push(row);
      groups.set(key, bucket);
    }
    return [...groups.entries()].sort(([a], [b]) => a.localeCompare(b));
  }, [filteredRows]);

  const submitContinuityAction = async (
    action: ModelContinuityAction,
    successMessage: TKey,
  ): Promise<ModelContinuityActionResult> => {
    setContinuityStatus("");
    const result = await postModelContinuityAction(
      (input, init) => fetch(input, init),
      apiBase,
      action,
      loadContinuity,
    );
    if (result.ok) {
      const [, continuityReloaded] = await Promise.all([
        loadModels(),
        loadContinuity(),
        loadFeatured(true),
      ]);
      if (continuityReloaded === "superseded") return "superseded";
      if (continuityReloaded === "applied") {
        setContinuityOk(true);
        setContinuityStatus(t(successMessage));
      }
      return "applied";
    }
    if (result.superseded) return "superseded";
    setContinuityOk(false);
    if (result.reloadFailed) {
      setContinuityStatus(t("models.continuity.loadFailed"));
    } else if (result.stale) {
      setContinuityStatus(t("models.continuity.stale"));
    } else if (result.message) {
      setContinuityStatus(t("models.continuity.saveFailedWithReason", { reason: result.message }));
    } else {
      setContinuityStatus(t("models.continuity.saveFailed"));
    }
    return "failed";
  };



  const apply = async (next: Set<string>, nextFeatured?: string[]) => {
    setBusy(true);
    busyRef.current = true;
    setStatus("");
    try {
      const r = await fetch(`${apiBase}/api/disabled-models`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ models: [...next] }),
      });
      if (r.ok) {
        setDisabled(next);
        setOk(true);
        setStatus(t("models.applied"));
        if (nextFeatured) {
          setFeaturedChosen(nextFeatured);
          void saveFeatured(nextFeatured);
        } else {
          loadFeatured();
        }
      }
      else { setOk(false); setStatus(t("models.saveFailed")); }
    } catch {
      setOk(false); setStatus(t("models.networkError"));
    } finally {
      setBusy(false);
      busyRef.current = false;
    }
  };

  const saveFeatured = async (modelsToSave = featuredChosen) => {
    if (modelsToSave === featuredChosen && !featuredDirtyRef.current) {
      setFeaturedOk(true);
      setFeaturedStatus(t("models.priorityNoChanges"));
      return;
    }
    const visibleModels = modelsToSave.filter(model => !disabled.has(model));
    setFeaturedStatus("");
    setFeaturedSaving(true);
    featuredSavingRef.current = true;
    try {
      const res = await fetch(`${apiBase}/api/subagent-models`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ models: visibleModels }),
      });
      const data = await res.json().catch(() => ({})) as { applied?: unknown; error?: string };
      const applied = Array.isArray(data.applied)
        ? data.applied.filter((model): model is string => typeof model === "string")
        : visibleModels;
      setFeaturedOk(res.ok);
      if (res.ok) {
        setFeaturedChosen(applied);
        featuredDirtyRef.current = false;
        setFeaturedDirty(false);
      }
      setFeaturedStatus(res.ok
        ? t("models.featuredSaved", { n: applied.length, cmd: "frogp refresh" })
        : (data.error || t("models.featuredSaveFailed")));
    } catch {
      setFeaturedOk(false);
      setFeaturedStatus(t("models.featuredNetworkError"));
    } finally {
      setFeaturedSaving(false);
      featuredSavingRef.current = false;
    }
  };

  const saveFeaturedChanges = () => {
    void saveFeatured();
  };

  const featuredAfterVisibilityChange = (nextDisabled: Set<string>): string[] | undefined => {
    const nextFeatured = featuredChosen.filter(model => !nextDisabled.has(model));
    return nextFeatured.length === featuredChosen.length ? undefined : nextFeatured;
  };

  const toggle = (row: ModelControlRow) => {
    if (!row.canHide) return;
    const next = new Set(disabled);
    if (next.has(row.namespaced)) next.delete(row.namespaced); else next.add(row.namespaced);
    apply(next, featuredAfterVisibilityChange(next));
  };

  const toggleProvider = (rows: ModelControlRow[], enable: boolean) => {
    const next = new Set(disabled);
    for (const row of rows) {
      if (!row.canHide) continue;
      if (enable) next.delete(row.namespaced); else next.add(row.namespaced);
    }
    apply(next, featuredAfterVisibilityChange(next));
  };

  const toggleCollapse = (p: string) => {
    setCollapsed(prev => { const n = new Set(prev); if (n.has(p)) n.delete(p); else n.add(p); return n; });
  };

  const toggleFeatured = (row: ModelControlRow) => {
    if (row.disabled) return;
    if (!row.authReady && !featuredChosen.includes(row.namespaced)) return;
    setFeaturedStatus("");
    setFeaturedChosen(prev => {
      if (prev.includes(row.namespaced)) {
        setFeaturedDirty(true);
        featuredDirtyRef.current = true;
        return prev.filter(item => item !== row.namespaced);
      }
      featuredDirtyRef.current = true;
      setFeaturedDirty(true);
      return [...prev, row.namespaced];
    });
  };

  const reorderFeatured = (from: string, to: string) => {
    if (!from || from === to) return;
    setFeaturedChosen(prev => {
      const fromIndex = prev.indexOf(from);
      const toIndex = prev.indexOf(to);
      if (fromIndex < 0 || toIndex < 0) return prev;
      const next = [...prev];
      const [item] = next.splice(fromIndex, 1);
      next.splice(toIndex, 0, item);
      featuredDirtyRef.current = true;
      setFeaturedDirty(true);
      return next;
    });
  };

  const handleFeaturedDragStart = (event: DragEvent<HTMLDivElement>, model: string) => {
    if (featuredSaving) {
      event.preventDefault();
      return;
    }
    setDraggedFeatured(model);
    setDragOverFeatured(model);
    event.dataTransfer.effectAllowed = "move";
    event.dataTransfer.setData("text/plain", model);
  };

  const handleFeaturedDragOver = (event: DragEvent<HTMLDivElement>, model: string) => {
    event.preventDefault();
    event.dataTransfer.dropEffect = "move";
    setDragOverFeatured(model);
  };

  const handleFeaturedDrop = (event: DragEvent<HTMLDivElement>, model: string) => {
    event.preventDefault();
    const source = draggedFeatured || event.dataTransfer.getData("text/plain");
    reorderFeatured(source, model);
    setDraggedFeatured(null);
    setDragOverFeatured(null);
  };

  const handleFeaturedDragEnd = () => {
    setDraggedFeatured(null);
    setDragOverFeatured(null);
  };

  const moveFeatured = (index: number, dir: -1 | 1) => {
    setFeaturedChosen(prev => {
      const next = [...prev];
      const target = index + dir;
      if (target < 0 || target >= next.length) return prev;
      [next[index], next[target]] = [next[target], next[index]];
      setFeaturedDirty(true);
      featuredDirtyRef.current = true;
      return next;
    });
  };

  if (loading) return <div className="row muted"><span className="spin" /> {t("models.loading")}</div>;

  return (
    <div className="models-page">
      <div className="models-hero">
        <div className="models-hero-copy">
          <h2>{t("models.controlTitle")}</h2>
          <p>{t("models.subtitle")}</p>
        </div>
        <ModelCatalogStatusSummary status={catalogStatus} t={t} onRefresh={refreshAll} />
      </div>

      {continuityLoading && (
        <section className="panel continuity-panel" aria-label={t("models.continuity.loading")}>
          <div className="row muted"><span className="spin" /> {t("models.continuity.loading")}</div>
        </section>
      )}
      {continuityStatus && <Notice tone={continuityOk ? "ok" : "err"}>{continuityStatus}</Notice>}
      {continuityReport && (
        <ModelContinuityPanel
          report={continuityReport}
          selectableModels={selectableContinuityModels}
          t={t}
          onSet={action => submitContinuityAction(action, "models.continuity.saved")}
          onReplace={action => submitContinuityAction(action, "models.continuity.replaced")}
        />
      )}

      {status && <Notice tone={ok ? "ok" : "err"}>{status}</Notice>}

      <section ref={modelControlsRef} className="panel model-control-panel">
        <div className="model-summary-grid model-summary-strip">
          <div className="stat"><div className="muted">{t("models.summary.visible")}</div><div className="stat-value">{activeCount}</div><div className="muted stat-caption">{t("models.summary.visibleHint")}</div></div>
          <div className="stat"><div className="muted">{t("models.summary.authUnavailable")}</div><div className="stat-value">{authUnavailableCount}</div><div className="muted stat-caption">{t("models.summary.authUnavailableHint")}</div></div>
          <div className="stat"><div className="muted">{t("models.summary.hidden")}</div><div className="stat-value">{hiddenCount}</div><div className="muted stat-caption">{hiddenCount > 0 ? t("models.visibilityHiddenCount", { n: hiddenCount }) : t("models.visibilityAllShown")}</div></div>
          <div className="stat"><div className="muted">{t("models.summary.featured")}</div><div className="stat-value accent-value">{featuredChosen.length}</div><div className="muted stat-caption">{t("models.summary.featuredHint")}</div></div>
        </div>

        {providerHiddenSummaries.length > 0 && (
          <Notice tone="err">
            {t("models.providerHiddenNotice", { providers: providerHiddenSummaryText, cmd: "frogp doctor claude" })}
          </Notice>
        )}

        <div className="model-control-head">
          <div>
            <h3 className="panel-title model-control-title">{t("models.controlListTitle")}</h3>
            <p className="page-sub model-control-copy">{t("models.controlHint")} {t("models.visibilityAutoSave")} {t("models.priorityManualSave")} {t("models.pickerRecoveryHint")}</p>
          </div>
          <div className="featured-meter" aria-label={t("models.featuredCount", { n: featuredChosen.length })}>
            <div className="featured-meter-count">{t("models.featuredCount", { n: featuredChosen.length })}</div>
          </div>
        </div>

        {featuredStatus && <Notice tone={featuredOk ? "ok" : "err"}>{featuredStatus}</Notice>}

        {!featuredLoading && (
          <div className="selected-order-card">
            <div className="selected-order-head">
              <div>
                <h4>{t("models.orderTitle")}</h4>
                <p>{t("models.orderHint")}</p>
              </div>
            </div>
            {featuredRows.length === 0 ? (
              <div className="selected-order-empty">{t("models.orderEmpty")}</div>
            ) : (
              <div className="selected-order-list">
                {featuredRows.map((row, index) => (
                  <div
                    key={row.namespaced}
                    className={`selected-order-item${draggedFeatured === row.namespaced ? " dragging" : ""}${dragOverFeatured === row.namespaced && draggedFeatured !== row.namespaced ? " drop-target" : ""}`}
                    draggable={!featuredSaving}
                    onDragStart={event => handleFeaturedDragStart(event, row.namespaced)}
                    onDragOver={event => handleFeaturedDragOver(event, row.namespaced)}
                    onDrop={event => handleFeaturedDrop(event, row.namespaced)}
                    onDragEnd={handleFeaturedDragEnd}
                    aria-label={t("models.orderItemAria", { n: index + 1, model: row.namespaced })}
                  >
                    <div className="drag-handle" aria-hidden="true">⋮⋮</div>
                    <div className="selected-order-rank">{index + 1}</div>
                    <div className="selected-order-main">
                      <div className="model-control-name">
                        <code className="mono text-anywhere">{row.id}</code>
                        {row.provider && <span className="model-provider-tag">{row.provider}</span>}
                        {!row.authReady && <span className="badge badge-amber">{t("models.authLoginRequired")}</span>}
                        <ModelSupportStatusBadge status={row.supportStatus} t={t} />
                      </div>
                      <div className="model-control-meta">
                        {row.authReady
                          ? t("models.orderDragHint")
                          : <Trans k="models.authNotReadyMeta" cmd={row.provider ? `frogp login ${row.provider}` : "frogp login"} />}
                      </div>
                    </div>
                    <div className="selected-order-actions">
                      <button className="btn btn-ghost btn-icon btn-sm" onClick={() => moveFeatured(index, -1)} disabled={index === 0 || featuredSaving} aria-label={t("models.featuredMoveUp", { m: row.namespaced })}>
                        <IconArrowUp />
                      </button>
                      <button className="btn btn-ghost btn-icon btn-sm" onClick={() => moveFeatured(index, 1)} disabled={index === featuredRows.length - 1 || featuredSaving} aria-label={t("models.featuredMoveDown", { m: row.namespaced })}>
                        <IconArrowDown />
                      </button>
                      <button className="btn btn-ghost btn-sm" onClick={() => toggleFeatured(row)} disabled={featuredSaving}>
                        {t("models.orderRemove")}
                      </button>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>
        )}

        <div className="model-control-toolbar">
          <div className="featured-search">
            <IconSearch />
            <input
              className="input"
              value={featuredQuery}
              onChange={e => setFeaturedQuery(e.target.value)}
              placeholder={t("models.controlSearch")}
            />
          </div>
          <div className="model-save-group">
            {featuredDirty && <span className="model-save-note">{t("models.priorityDirty")}</span>}
            <button className="btn btn-primary" onClick={saveFeaturedChanges} disabled={featuredSaving || !featuredDirty}>
              {featuredSaving ? t("prov.savingDefault") : t("models.prioritySave")}
            </button>
          </div>
        </div>

        {featuredLoading ? (
          <div className="row muted"><span className="spin" /> {t("models.featuredLoading")}</div>
        ) : groupedRows.length === 0 ? (
          <div className="empty">{t("models.controlNoModels")}</div>
        ) : (
          <div className="model-control-groups">
            {groupedRows.map(([providerKey, rows]) => {
              const isCollapsed = collapsed.has(providerKey);
              const hideableRows = rows.filter(row => row.canHide);
              const groupActiveCount = rows.filter(row => !row.disabled && row.authReady).length;
              const percent = rows.length === 0 ? "0%" : `${Math.round((groupActiveCount / rows.length) * 100)}%`;
              const providerLabel = providerKey === "__claude_code__" ? t("models.providerClaudeCode") : providerKey;
              return (
                <section key={providerKey} className="model-provider-card">
                  <div
                    onClick={() => toggleCollapse(providerKey)}
                    onKeyDown={e => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); toggleCollapse(providerKey); } }}
                    role="button"
                    tabIndex={0}
                    className="model-provider-head"
                  >
                    <IconChevron className="model-provider-chevron" style={{ transform: isCollapsed ? "none" : "rotate(90deg)" }} />
                    <div className="model-provider-title">
                      <span>{providerLabel}</span>
                      <span className="model-account-badge">{t("models.accountBadge")}</span>
                      <span className="muted mono">{t("models.active", { active: groupActiveCount, total: rows.length })}</span>
                    </div>
                    <div className="provider-meter" aria-hidden="true"><span style={{ width: percent }} /></div>
                    {hideableRows.length > 0 && (
                      <div className="model-provider-actions">
                        <button onClick={e => { e.stopPropagation(); toggleProvider(rows, true); }} disabled={busy} className="btn btn-ghost btn-sm">{t("models.allOn")}</button>
                        <button onClick={e => { e.stopPropagation(); toggleProvider(rows, false); }} disabled={busy} className="btn btn-ghost btn-sm">{t("models.allOff")}</button>
                      </div>
                    )}
                  </div>
                  {!isCollapsed && (
                    <div className="model-list model-control-list">
                      {rows.map(row => {
                        const selected = featuredSelected.has(row.namespaced);
                        const rank = featuredChosen.indexOf(row.namespaced);
                        const priorityDisabled = featuredSaving || row.disabled || (!row.authReady && !selected);
                        const loginCmd = row.provider ? `frogp login ${row.provider}` : "frogp login";
                        const priorityLabel = row.disabled
                          ? t("models.priorityHidden")
                          : selected
                            ? t("models.prioritySelected", { n: rank + 1 })
                            : !row.authReady
                              ? t("models.authLoginRequired")
                              : t("models.priorityAdd");
                        return (
                          <div key={row.namespaced} className={`visibility-model-row model-control-row${row.disabled ? " disabled" : ""}${selected ? " prioritized" : ""}`}>
                            <Switch on={!row.disabled} onClick={() => toggle(row)} disabled={busy || !row.canHide} label={t("models.visibilityToggle", { model: row.namespaced })} />
                            <div className="model-control-main">
                              <div className="model-control-name">
                                <code className="mono text-anywhere">{row.id}</code>
                                {row.provider && <span className="model-provider-tag">{row.provider}</span>}
                                {!row.canHide && <span className="badge badge-muted">{t("models.builtinBadge")}</span>}
                                {!row.authReady && <span className="badge badge-amber">{t("models.authLoginRequired")}</span>}
                                <ModelSupportStatusBadge status={row.supportStatus} t={t} />
                              </div>
                              <div className="model-control-meta">
                                {!row.authReady
                                  ? <Trans k="models.authNotReadyMeta" cmd={loginCmd} />
                                  : row.disabled ? t("models.rowHidden") : t("models.rowVisible")}
                              </div>
                            </div>
                            <div className="model-row-actions">
                              <button
                                className={`btn btn-sm ${selected ? "btn-ghost" : "btn-primary"}`}
                                onClick={() => toggleFeatured(row)}
                                disabled={priorityDisabled}
                              >
                                {selected && <IconCheck />}
                                {priorityLabel}
                              </button>
                            </div>
                          </div>
                        );
                      })}
                    </div>
                  )}
                </section>
              );
            })}
          </div>
        )}
      </section>

      {controlRows.length === 0 && (
        <div className="empty">
          <div className="title">{t("models.noRouted")}</div>
          <div style={{ fontSize: 13 }}>{t("models.noRoutedHint")}</div>
        </div>
      )}
    </div>
  );
}

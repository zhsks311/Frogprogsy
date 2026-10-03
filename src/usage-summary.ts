import { baseProviderLabel } from "./provider-label";
import type { CacheUsageSemantics } from "./types";
import type { PersistedUsageEntry, UsageStatus } from "./usage-log";
import { buildUsagePricing, isShadowUsageEntry, type UsagePricingConfig, type UsagePricingSummary } from "./usage-pricing";

export type UsageRange = "7d" | "30d" | "all";

export interface UsageSummaryTotals {
  requests: number;
  reportedRequests: number;
  unreportedRequests: number;
  unsupportedRequests: number;
  estimatedRequests: number;
  inputTokens: number;
  outputTokens: number;
  cachedInputTokens: number;
  reasoningOutputTokens: number;
  totalTokens: number;
  coverageRatio: number;
}
export type CacheHitRateStatus = "available" | "no_data" | "unsupported" | "unavailable" | "error";

export interface UsageCacheMetrics {
  status: CacheHitRateStatus;
  formula: "cache_read_input_tokens / total_input_tokens";
  requests: number;
  /** Requests whose final lifecycle explicitly records successful completion. */
  successfulRequests: number;
  /** Successfully completed requests included in the token-weighted rate. */
  measuredRequests: number;
  /** Pre-lifecycle rows are excluded from the headline and retained as a separate historical rate. */
  legacyRequests: number;
  legacyMeasuredRequests: number;
  historicalCacheReadInputTokens: number;
  historicalTotalInputTokens: number;
  historicalHitRate: number | null;
  cacheReadInputTokens: number;
  /** Exact writes from requests that reported them; unavailable counters prevent unknown from becoming zero. */
  cacheCreationInputTokens: number;
  cacheCreationMeasuredRequests: number;
  cacheCreationUnavailableRequests: number;
  /** Exact uncached input only when read and write buckets are both known. */
  uncachedInputTokens: number;
  uncachedMeasuredRequests: number;
  uncachedUnavailableRequests: number;
  /** Inclusive input not read from cache; may include provider cache writes when their write bucket is absent. */
  nonCacheReadInputTokens: number;
  totalInputTokens: number;
  hitRate: number | null;
  coverageRatio: number | null;
  unsupportedRequests: number;
  unavailableRequests: number;
  failedRequests: number;
  abortedRequests: number;
  incompleteRequests: number;
  /** Incomplete streamed responses with provider usage observed before termination. */
  partialRequests: number;
}

export interface UsageCacheDay extends UsageCacheMetrics {
  date: string;
}

export interface UsageCacheProvider extends UsageCacheMetrics {
  provider: string;
}

export interface UsageCacheModel extends UsageCacheMetrics {
  provider: string;
  model: string;
}


export interface UsageDay {
  date: string;
  requests: number;
  reportedRequests: number;
  totalTokens: number;
}

export interface UsageModel {
  provider: string;
  model: string;
  resolvedModel?: string;
  requests: number;
  reportedRequests: number;
  totalTokens: number;
  inputTokens: number;
  outputTokens: number;
  shareRatio: number;
}

export interface UsageProvider {
  provider: string;
  requests: number;
  reportedRequests: number;
  totalTokens: number;
  shareRatio: number;
}
export interface UsageSourceState {
  observedUsage: {
    available: true;
    source: "local_request_log";
    authoritative: false;
    reason: null;
  };
  sessionLimits: {
    available: false;
    source: null;
    reason: "no_authoritative_source";
  };
  cost: {
    available: false;
    source: null;
    reason: "no_authoritative_source";
  } | {
    available: true;
    source: "local_price_table";
    authoritative: false;
    reason: "display_only_not_billing";
  };
}


export interface UsageSummary {
  range: UsageRange;
  since: number | null;
  generatedAt: number;
  summary: UsageSummaryTotals;
  days: UsageDay[];
  models: UsageModel[];
  providers: UsageProvider[];
  sourceState: UsageSourceState;
  cacheHitRate: UsageCacheMetrics;
  cacheDays: UsageCacheDay[];
  cacheModels: UsageCacheModel[];
  cacheProviders: UsageCacheProvider[];
  pricing: UsagePricingSummary;
}

const DAY_MS = 86_400_000;

export function parseRange(input: string | null | undefined): UsageRange {
  if (input === "7d" || input === "30d" || input === "all") return input;
  return "30d";
}

function rangeWindow(range: UsageRange, now: number): { since: number | null; days: number } {
  if (range === "7d") return { since: now - 7 * DAY_MS, days: 7 };
  if (range === "30d") return { since: now - 30 * DAY_MS, days: 30 };
  return { since: null, days: 0 };
}

function localDateKey(ts: number): string {
  const d = new Date(ts);
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

function dayCountForAllRange(entries: PersistedUsageEntry[], now: number): number {
  if (entries.length === 0) return 1;
  const oldest = entries.reduce((min, e) => Math.min(min, e.timestamp), entries[0].timestamp);
  const days = Math.ceil((now - oldest) / DAY_MS) + 1;
  return Math.max(1, days);
}

function blankTotals(): UsageSummaryTotals {
  return {
    requests: 0,
    reportedRequests: 0,
    unreportedRequests: 0,
    unsupportedRequests: 0,
    estimatedRequests: 0,
    inputTokens: 0,
    outputTokens: 0,
    cachedInputTokens: 0,
    reasoningOutputTokens: 0,
    totalTokens: 0,
    coverageRatio: 0,
  };
}

function bumpStatus(totals: UsageSummaryTotals, status: UsageStatus): void {
  totals.requests += 1;
  if (status === "reported") totals.reportedRequests += 1;
  else if (status === "unreported") totals.unreportedRequests += 1;
  else if (status === "unsupported") totals.unsupportedRequests += 1;
  else if (status === "estimated") totals.estimatedRequests += 1;
}

function addTokens(totals: UsageSummaryTotals, entry: PersistedUsageEntry): void {
  if (!entry.usage) return;
  totals.inputTokens += entry.usage.inputTokens ?? 0;
  totals.outputTokens += entry.usage.outputTokens;
  if (typeof entry.usage.cachedInputTokens === "number") totals.cachedInputTokens += entry.usage.cachedInputTokens;
  if (typeof entry.usage.reasoningOutputTokens === "number") totals.reasoningOutputTokens += entry.usage.reasoningOutputTokens;
  if (typeof entry.totalTokens === "number") totals.totalTokens += entry.totalTokens;
  else totals.totalTokens += (entry.usage.inputTokens ?? 0) + entry.usage.outputTokens;
}

function finalizeCoverage(totals: UsageSummaryTotals): void {
  totals.coverageRatio = totals.requests === 0 ? 0 : totals.reportedRequests / totals.requests;
}

function isNonNegativeFinite(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0;
}

function cacheUsageSemantics(entry: PersistedUsageEntry): CacheUsageSemantics | undefined {
  if (
    entry.cacheUsageSemantics === "anthropic_separate_input_buckets"
    || entry.cacheUsageSemantics === "openai_input_total_includes_cached"
    || entry.cacheUsageSemantics === "google_input_total_includes_cached"
    || entry.cacheUsageSemantics === "openrouter_input_total_includes_cached"
    || entry.cacheUsageSemantics === "deepseek_hit_plus_miss"
  ) return entry.cacheUsageSemantics;
  // Rows written by the first cache-metric implementation predate the semantics field, but its
  // `reported` status required all three Anthropic buckets. Preserve that exact, non-guessed contract.
  if (
    entry.cacheUsageStatus === "reported"
    && isNonNegativeFinite(entry.usage?.cacheReadInputTokens)
    && isNonNegativeFinite(entry.usage?.cacheCreationInputTokens)
    && isNonNegativeFinite(entry.usage?.inputTokens)
  ) return "anthropic_separate_input_buckets";
  return undefined;
}

interface CacheAccumulator {
  requests: number;
  successfulRequests: number;
  measuredRequests: number;
  legacyRequests: number;
  legacyMeasuredRequests: number;
  historicalCacheReadInputTokens: number;
  historicalTotalInputTokens: number;
  cacheReadInputTokens: number;
  cacheCreationInputTokens: number;
  cacheCreationMeasuredRequests: number;
  cacheCreationUnavailableRequests: number;
  uncachedInputTokens: number;
  uncachedMeasuredRequests: number;
  uncachedUnavailableRequests: number;
  nonCacheReadInputTokens: number;
  totalInputTokens: number;
  unsupportedRequests: number;
  unavailableRequests: number;
  failedRequests: number;
  abortedRequests: number;
  incompleteRequests: number;
  partialRequests: number;
}

function blankCacheAccumulator(): CacheAccumulator {
  return {
    requests: 0,
    successfulRequests: 0,
    measuredRequests: 0,
    legacyRequests: 0,
    legacyMeasuredRequests: 0,
    historicalCacheReadInputTokens: 0,
    historicalTotalInputTokens: 0,
    cacheReadInputTokens: 0,
    cacheCreationInputTokens: 0,
    cacheCreationMeasuredRequests: 0,
    cacheCreationUnavailableRequests: 0,
    uncachedInputTokens: 0,
    uncachedMeasuredRequests: 0,
    uncachedUnavailableRequests: 0,
    nonCacheReadInputTokens: 0,
    totalInputTokens: 0,
    unsupportedRequests: 0,
    unavailableRequests: 0,
    failedRequests: 0,
    abortedRequests: 0,
    incompleteRequests: 0,
    partialRequests: 0,
  };
}

type CacheRequestOutcome = "successful" | "legacy" | "failed" | "aborted" | "incomplete";

function cacheRequestOutcome(entry: PersistedUsageEntry): CacheRequestOutcome {
  switch (entry.outcome) {
    case "completed":
      return "successful";
    case "client_cancel":
    case "upstream_abort":
      return "aborted";
    case "timeout":
    case "provider_non_2xx":
    case "bridge_error":
    case "internal_error":
      return "failed";
    case undefined:
      if (entry.status === 499) return "aborted";
      if (Number.isInteger(entry.status) && (entry.status < 200 || entry.status >= 300)) return "failed";
      // A bare historical 2xx does not prove that a streaming response reached its terminal event.
      return Number.isInteger(entry.status) && entry.status >= 200 && entry.status < 300 ? "legacy" : "incomplete";
    default:
      return "incomplete";
  }
}

function addComparableCacheUsage(
  totals: CacheAccumulator,
  entry: PersistedUsageEntry,
  legacy: boolean,
): boolean {
  if (entry.cacheUsageStatus !== "reported") return false;
  const usage = entry.usage;
  const cacheRead = usage?.cacheReadInputTokens;
  const providerInput = usage?.inputTokens;
  const semantics = cacheUsageSemantics(entry);
  let totalInput: number | undefined;
  let nonCacheRead: number | undefined;
  let cacheWrite: number | undefined;
  let uncachedInput: number | undefined;

  if (
    semantics === "anthropic_separate_input_buckets"
    && isNonNegativeFinite(cacheRead)
    && isNonNegativeFinite(usage?.cacheCreationInputTokens)
    && isNonNegativeFinite(providerInput)
  ) {
    totalInput = cacheRead + usage.cacheCreationInputTokens + providerInput;
    nonCacheRead = usage.cacheCreationInputTokens + providerInput;
    cacheWrite = usage.cacheCreationInputTokens;
    uncachedInput = providerInput;
  } else if (
    (
      semantics === "openai_input_total_includes_cached"
      || semantics === "google_input_total_includes_cached"
      || semantics === "openrouter_input_total_includes_cached"
    )
    && isNonNegativeFinite(cacheRead)
    && isNonNegativeFinite(providerInput)
    && cacheRead <= providerInput
  ) {
    totalInput = providerInput;
    nonCacheRead = providerInput - cacheRead;
    const observedWrite = usage?.observedCacheWriteInputTokens;
    if (
      isNonNegativeFinite(observedWrite)
      && cacheRead + observedWrite <= providerInput
    ) {
      cacheWrite = observedWrite;
      uncachedInput = providerInput - cacheRead - observedWrite;
    }
  } else if (
    semantics === "deepseek_hit_plus_miss"
    && isNonNegativeFinite(cacheRead)
    && isNonNegativeFinite(usage?.cacheMissInputTokens)
  ) {
    totalInput = cacheRead + usage.cacheMissInputTokens;
    nonCacheRead = usage.cacheMissInputTokens;
  }

  if (
    !isNonNegativeFinite(cacheRead)
    || !isNonNegativeFinite(totalInput)
    || !isNonNegativeFinite(nonCacheRead)
    || totalInput === 0
  ) return false;

  if (legacy) {
    totals.legacyMeasuredRequests += 1;
    totals.historicalCacheReadInputTokens += cacheRead;
    totals.historicalTotalInputTokens += totalInput;
    return true;
  }

  totals.measuredRequests += 1;
  totals.cacheReadInputTokens += cacheRead;
  totals.nonCacheReadInputTokens += nonCacheRead;
  totals.totalInputTokens += totalInput;
  if (cacheWrite !== undefined && uncachedInput !== undefined) {
    totals.cacheCreationInputTokens += cacheWrite;
    totals.cacheCreationMeasuredRequests += 1;
    totals.uncachedInputTokens += uncachedInput;
    totals.uncachedMeasuredRequests += 1;
  } else {
    totals.cacheCreationUnavailableRequests += 1;
    totals.uncachedUnavailableRequests += 1;
  }
  return true;
}

function addCacheEntry(totals: CacheAccumulator, entry: PersistedUsageEntry): void {
  totals.requests += 1;
  const outcome = cacheRequestOutcome(entry);
  if (outcome === "aborted") {
    if (entry.usage && (
      entry.outcome === "client_cancel"
      || entry.outcome === "upstream_abort"
    )) totals.partialRequests += 1;
    else totals.abortedRequests += 1;
    return;
  }
  if (outcome === "failed") {
    if (entry.usage && entry.outcome === "bridge_error") totals.partialRequests += 1;
    else totals.failedRequests += 1;
    return;
  }
  if (outcome === "incomplete") {
    totals.incompleteRequests += 1;
    return;
  }
  if (outcome === "legacy") {
    totals.legacyRequests += 1;
    addComparableCacheUsage(totals, entry, true);
    return;
  }

  totals.successfulRequests += 1;
  if (addComparableCacheUsage(totals, entry, false)) return;
  const semantics = cacheUsageSemantics(entry);
  if (entry.cacheUsageStatus === "unsupported" && semantics === undefined) {
    totals.unsupportedRequests += 1;
  } else {
    totals.unavailableRequests += 1;
  }
}

function finalizeCacheMetrics(totals: CacheAccumulator): UsageCacheMetrics {
  const status: CacheHitRateStatus = totals.requests === 0
    ? "no_data"
    : totals.measuredRequests > 0
      ? "available"
      : totals.failedRequests > 0 || totals.abortedRequests > 0 || totals.incompleteRequests > 0 || totals.partialRequests > 0
        ? "error"
        : totals.unavailableRequests > 0 || totals.legacyRequests > 0
          ? "unavailable"
          : "unsupported";
  return {
    status,
    formula: "cache_read_input_tokens / total_input_tokens",
    ...totals,
    historicalHitRate: totals.legacyMeasuredRequests > 0 && totals.historicalTotalInputTokens > 0
      ? totals.historicalCacheReadInputTokens / totals.historicalTotalInputTokens
      : null,
    hitRate: totals.measuredRequests > 0 && totals.totalInputTokens > 0
      ? totals.cacheReadInputTokens / totals.totalInputTokens
      : null,
    coverageRatio: totals.successfulRequests > 0
      ? totals.measuredRequests / totals.successfulRequests
      : null,
  };
}

interface UsageCacheAnalytics {
  summary: UsageCacheMetrics;
  days: UsageCacheDay[];
  models: UsageCacheModel[];
  providers: UsageCacheProvider[];
}

function buildCacheAnalytics(
  entries: PersistedUsageEntry[],
  range: UsageRange,
  now: number,
): UsageCacheAnalytics {
  const summary = blankCacheAccumulator();
  const dayAccumulators = new Map<string, CacheAccumulator>();
  const dayCount = range === "all" ? dayCountForAllRange(entries, now) : rangeWindow(range, now).days;
  for (let i = dayCount - 1; i >= 0; i--) {
    dayAccumulators.set(localDateKey(now - i * DAY_MS), blankCacheAccumulator());
  }
  const modelAccumulators = new Map<string, { provider: string; model: string; totals: CacheAccumulator }>();
  const providerAccumulators = new Map<string, CacheAccumulator>();

  for (const entry of entries) {
    addCacheEntry(summary, entry);
    const dayKey = localDateKey(entry.timestamp);
    let day = dayAccumulators.get(dayKey);
    if (!day) {
      day = blankCacheAccumulator();
      dayAccumulators.set(dayKey, day);
    }
    addCacheEntry(day, entry);

    const provider = baseProviderLabel(entry.provider);
    let providerTotals = providerAccumulators.get(provider);
    if (!providerTotals) {
      providerTotals = blankCacheAccumulator();
      providerAccumulators.set(provider, providerTotals);
    }
    addCacheEntry(providerTotals, entry);

    const model = entry.resolvedModel ?? entry.model;
    const modelKey = JSON.stringify([provider, model]);
    let modelGroup = modelAccumulators.get(modelKey);
    if (!modelGroup) {
      modelGroup = { provider, model, totals: blankCacheAccumulator() };
      modelAccumulators.set(modelKey, modelGroup);
    }
    addCacheEntry(modelGroup.totals, entry);
  }

  return {
    summary: finalizeCacheMetrics(summary),
    days: [...dayAccumulators.entries()]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([date, totals]) => ({ date, ...finalizeCacheMetrics(totals) })),
    models: [...modelAccumulators.values()]
      .map(({ provider, model, totals }) => ({ provider, model, ...finalizeCacheMetrics(totals) }))
      .sort((a, b) => b.requests - a.requests || a.provider.localeCompare(b.provider) || a.model.localeCompare(b.model)),
    providers: [...providerAccumulators.entries()]
      .map(([provider, totals]) => ({ provider, ...finalizeCacheMetrics(totals) }))
      .sort((a, b) => b.requests - a.requests || a.provider.localeCompare(b.provider)),
  };
}

function usageSourceState(pricing: UsagePricingSummary): UsageSourceState {
  return {
    observedUsage: {
      available: true,
      source: "local_request_log",
      authoritative: false,
      reason: null,
    },
    sessionLimits: {
      available: false,
      source: null,
      reason: "no_authoritative_source",
    },
    cost: pricing.available ? {
      available: true,
      source: "local_price_table",
      authoritative: false,
      reason: "display_only_not_billing",
    } : {
      available: false,
      source: null,
      reason: "no_authoritative_source",
    },
  };
}

function buildDayGrid(range: UsageRange, since: number | null, now: number, entries: PersistedUsageEntry[]): UsageDay[] {
  const window = rangeWindow(range, now);
  const days = range === "all" ? dayCountForAllRange(entries, now) : window.days;
  const grid = new Map<string, UsageDay>();
  for (let i = days - 1; i >= 0; i--) {
    const key = localDateKey(now - i * DAY_MS);
    grid.set(key, { date: key, requests: 0, reportedRequests: 0, totalTokens: 0 });
  }
  for (const entry of entries) {
    const key = localDateKey(entry.timestamp);
    let day = grid.get(key);
    if (!day) {
      day = { date: key, requests: 0, reportedRequests: 0, totalTokens: 0 };
      grid.set(key, day);
    }
    day.requests += 1;
    if (entry.usageStatus === "reported") day.reportedRequests += 1;
    if (typeof entry.totalTokens === "number") day.totalTokens += entry.totalTokens;
    else if (entry.usage) day.totalTokens += (entry.usage.inputTokens ?? 0) + entry.usage.outputTokens;
  }
  void since;
  return [...grid.values()].sort((a, b) => a.date.localeCompare(b.date));
}

function buildModels(entries: PersistedUsageEntry[], totalRequests: number): UsageModel[] {
  const byKey = new Map<string, UsageModel>();
  for (const entry of entries) {
    const providerKey = baseProviderLabel(entry.provider);
    const key = `${providerKey}${entry.model}`;
    let model = byKey.get(key);
    if (!model) {
      model = {
        provider: providerKey,
        model: entry.model,
        ...(entry.resolvedModel ? { resolvedModel: entry.resolvedModel } : {}),
        requests: 0,
        reportedRequests: 0,
        totalTokens: 0,
        inputTokens: 0,
        outputTokens: 0,
        shareRatio: 0,
      };
      byKey.set(key, model);
    }
    model.requests += 1;
    if (entry.usageStatus === "reported") model.reportedRequests += 1;
    if (entry.usage) {
      model.inputTokens += entry.usage.inputTokens ?? 0;
      model.outputTokens += entry.usage.outputTokens;
      if (typeof entry.totalTokens === "number") model.totalTokens += entry.totalTokens;
      else model.totalTokens += (entry.usage.inputTokens ?? 0) + entry.usage.outputTokens;
    }
  }
  const models = [...byKey.values()];
  for (const m of models) m.shareRatio = totalRequests === 0 ? 0 : m.requests / totalRequests;
  return models.sort((a, b) => b.requests - a.requests);
}

function buildProviders(entries: PersistedUsageEntry[], totalRequests: number): UsageProvider[] {
  const byKey = new Map<string, UsageProvider>();
  for (const entry of entries) {
    const providerKey = baseProviderLabel(entry.provider);
    let provider = byKey.get(providerKey);
    if (!provider) {
      provider = {
        provider: providerKey,
        requests: 0,
        reportedRequests: 0,
        totalTokens: 0,
        shareRatio: 0,
      };
      byKey.set(providerKey, provider);
    }
    provider.requests += 1;
    if (entry.usageStatus === "reported") provider.reportedRequests += 1;
    if (entry.usage) {
      if (typeof entry.totalTokens === "number") provider.totalTokens += entry.totalTokens;
      else provider.totalTokens += (entry.usage.inputTokens ?? 0) + entry.usage.outputTokens;
    }
  }
  const providers = [...byKey.values()];
  for (const p of providers) p.shareRatio = totalRequests === 0 ? 0 : p.requests / totalRequests;
  return providers.sort((a, b) => b.requests - a.requests);
}

export function summarizeUsage(entries: PersistedUsageEntry[], range: UsageRange, now: number, pricingConfig?: UsagePricingConfig): UsageSummary {
  const { since } = rangeWindow(range, now);
  const inRange = since === null ? entries : entries.filter(e => e.timestamp >= since);
  const totals = blankTotals();
  for (const entry of inRange) {
    bumpStatus(totals, entry.usageStatus);
    addTokens(totals, entry);
  }
  finalizeCoverage(totals);
  const pricing = buildUsagePricing(inRange, pricingConfig);
  const cache = buildCacheAnalytics(inRange.filter(entry => !isShadowUsageEntry(entry)), range, now);
  return {
    range,
    since,
    generatedAt: now,
    summary: totals,
    days: buildDayGrid(range, since, now, inRange),
    models: buildModels(inRange, totals.requests),
    providers: buildProviders(inRange, totals.requests),
    sourceState: usageSourceState(pricing),
    cacheHitRate: cache.summary,
    cacheDays: cache.days,
    cacheModels: cache.models,
    cacheProviders: cache.providers,
    pricing,
  };
}

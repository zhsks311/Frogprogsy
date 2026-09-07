import { baseProviderLabel } from "./provider-label";
import type { CacheUsageSemantics } from "./types";
import type { PersistedUsageEntry, UsageStatus } from "./usage-log";
import { buildUsagePricing, type UsagePricingConfig, type UsagePricingSummary } from "./usage-pricing";

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

export interface UsageCacheHitRate {
  status: CacheHitRateStatus;
  formula: "cache_read_input_tokens / total_input_tokens";
  cacheReadInputTokens: number;
  /** Cache creation is an Anthropic-only separate bucket; native OpenAI never contributes here. */
  cacheCreationInputTokens: number;
  /** Raw provider input counters: Anthropic plain input plus OpenAI's inclusive input total. */
  inputTokens: number;
  /** Provenance-aware denominator used by `formula`; never reconstruct it from the other aggregate fields. */
  totalInputTokens: number;
  hitRate: number | null;
  reportedRequests: number;
  unsupportedRequests: number;
  unavailableRequests: number;
  failedRequests: number;
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
  cacheHitRate: UsageCacheHitRate;
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
  totals.inputTokens += entry.usage.inputTokens;
  totals.outputTokens += entry.usage.outputTokens;
  if (typeof entry.usage.cachedInputTokens === "number") totals.cachedInputTokens += entry.usage.cachedInputTokens;
  if (typeof entry.usage.reasoningOutputTokens === "number") totals.reasoningOutputTokens += entry.usage.reasoningOutputTokens;
  if (typeof entry.totalTokens === "number") totals.totalTokens += entry.totalTokens;
  else totals.totalTokens += entry.usage.inputTokens + entry.usage.outputTokens;
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

function summarizeCacheHitRate(entries: PersistedUsageEntry[]): UsageCacheHitRate {
  let cacheReadInputTokens = 0;
  let cacheCreationInputTokens = 0;
  let inputTokens = 0;
  let totalInputTokens = 0;
  let reportedRequests = 0;
  let unsupportedRequests = 0;
  let unavailableRequests = 0;
  let failedRequests = 0;

  for (const entry of entries) {
    if (entry.status < 200 || entry.status >= 300) {
      failedRequests += 1;
      continue;
    }
    const usage = entry.usage;
    const cacheRead = usage?.cacheReadInputTokens;
    const cacheCreation = usage?.cacheCreationInputTokens;
    const providerInput = usage?.inputTokens;
    const semantics = cacheUsageSemantics(entry);
    if (
      entry.cacheUsageStatus === "reported"
      && semantics === "anthropic_separate_input_buckets"
      && isNonNegativeFinite(cacheRead)
      && isNonNegativeFinite(cacheCreation)
      && isNonNegativeFinite(providerInput)
    ) {
      cacheReadInputTokens += cacheRead;
      cacheCreationInputTokens += cacheCreation;
      inputTokens += providerInput;
      totalInputTokens += cacheRead + cacheCreation + providerInput;
      reportedRequests += 1;
    } else if (
      entry.cacheUsageStatus === "reported"
      && semantics === "openai_input_total_includes_cached"
      && isNonNegativeFinite(cacheRead)
      && isNonNegativeFinite(providerInput)
      && cacheRead <= providerInput
    ) {
      cacheReadInputTokens += cacheRead;
      inputTokens += providerInput;
      totalInputTokens += providerInput;
      reportedRequests += 1;
    } else if (entry.cacheUsageStatus === "unsupported" && semantics === undefined) {
      unsupportedRequests += 1;
    } else {
      unavailableRequests += 1;
    }
  }

  const status: CacheHitRateStatus = entries.length === 0
    ? "no_data"
    : reportedRequests > 0
      ? "available"
      : failedRequests > 0
        ? "error"
        : unavailableRequests > 0
          ? "unavailable"
          : "unsupported";
  return {
    status,
    formula: "cache_read_input_tokens / total_input_tokens",
    cacheReadInputTokens,
    cacheCreationInputTokens,
    inputTokens,
    totalInputTokens,
    hitRate: reportedRequests > 0 && totalInputTokens > 0 ? cacheReadInputTokens / totalInputTokens : null,
    reportedRequests,
    unsupportedRequests,
    unavailableRequests,
    failedRequests,
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
    else if (entry.usage) day.totalTokens += entry.usage.inputTokens + entry.usage.outputTokens;
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
      model.inputTokens += entry.usage.inputTokens;
      model.outputTokens += entry.usage.outputTokens;
      if (typeof entry.totalTokens === "number") model.totalTokens += entry.totalTokens;
      else model.totalTokens += entry.usage.inputTokens + entry.usage.outputTokens;
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
      else provider.totalTokens += entry.usage.inputTokens + entry.usage.outputTokens;
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
  return {
    range,
    since,
    generatedAt: now,
    summary: totals,
    days: buildDayGrid(range, since, now, inRange),
    models: buildModels(inRange, totals.requests),
    providers: buildProviders(inRange, totals.requests),
    sourceState: usageSourceState(pricing),
    cacheHitRate: summarizeCacheHitRate(inRange),
    pricing,
  };
}

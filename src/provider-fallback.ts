import { applyLongContextRoute, routeModel, type RouteKind, type RouteResult } from "./router";
import { effectiveKeyCandidates } from "./provider-keys";
import type { FrogConfig, FrogParsedRequest, FrogProviderConfig } from "./types";

export type AttemptSource = "primary" | "fallback" | "continuity";

export interface AttemptContext {
  source: AttemptSource;
  attemptIndex: number;
  providerName: string;
  provider: FrogProviderConfig;
  modelId: string;
  routeKind: RouteKind;
  ambiguousCandidates?: string[];
  keyIndex?: number;
}

export interface AttemptBuildResult {
  primaryRoute: RouteResult;
  attempts: AttemptContext[];
}

export interface AttemptBuildOptions {
  continuityRoutes?: readonly RouteResult[];
  suppressGenericFallback?: boolean;
}

function providerKeyCandidates(provider: FrogProviderConfig): Array<{ keyIndex?: number; key?: string }> {
  if (provider.authMode === "forward" || provider.authMode === "oauth" || provider.authMode === "claude-grant") return [{}];
  const keys = effectiveKeyCandidates(provider);
  if (keys.length === 0) return [{}];
  return keys.map(candidate => ({ keyIndex: candidate.index, key: candidate.key }));
}

export function buildKeyAttemptsForRoute(
  route: RouteResult,
  source: AttemptSource,
  firstAttemptIndex: number,
): AttemptContext[] {
  return providerKeyCandidates(route.provider).map((candidate, offset) => ({
    source,
    attemptIndex: firstAttemptIndex + offset,
    providerName: route.providerName,
    provider: candidate.key === undefined ? { ...route.provider } : { ...route.provider, apiKey: candidate.key },
    modelId: route.modelId,
    routeKind: route.routeKind,
    ...(route.ambiguousCandidates ? { ambiguousCandidates: route.ambiguousCandidates } : {}),
    ...(candidate.keyIndex !== undefined ? { keyIndex: candidate.keyIndex } : {}),
  }));
}

function firstValidFallbackRoute(config: FrogConfig, primaryProviderName: string, fallbackModelId: string): RouteResult | null {
  for (const providerName of config.fallbackProviders ?? []) {
    const provider = config.providers[providerName];
    if (!provider) continue;
    if (providerName === primaryProviderName) continue;
    if (provider.authMode !== "forward" && provider.authMode !== "oauth" && provider.authMode !== "claude-grant" && effectiveKeyCandidates(provider).length === 0) continue;
    return {
      providerName,
      provider: { ...provider },
      modelId: provider.defaultModel ?? fallbackModelId,
      routeKind: "default",
    };
  }
  return null;
}

export function resolvePrimaryRoute(config: FrogConfig, parsed: FrogParsedRequest): RouteResult {
  const routed = routeModel(config, parsed.modelId);
  return applyLongContextRoute(config, { ...parsed, resolvedRouteKind: routed.routeKind }) ?? routed;
}

export function buildAttemptContexts(
  config: FrogConfig,
  parsed: FrogParsedRequest,
  options: AttemptBuildOptions = {},
): AttemptBuildResult {
  const primaryRoute = resolvePrimaryRoute(config, parsed);
  const attempts = buildKeyAttemptsForRoute(primaryRoute, "primary", 0);
  for (const continuityRoute of options.continuityRoutes ?? []) {
    attempts.push(...buildKeyAttemptsForRoute(continuityRoute, "continuity", attempts.length));
  }
  // Classifier routes are pinned to their single explicit `autoModeClassifier` target. Only
  // same-provider key retries (already built above via provider key candidates) are allowed —
  // never a generic `fallbackProviders` cross-provider fallback, which would let a different
  // provider/model silently become the auto-mode safety judge.
  if (!options.suppressGenericFallback && primaryRoute.routeKind !== "classifier") {
    const fallbackRoute = firstValidFallbackRoute(config, primaryRoute.providerName, primaryRoute.modelId);
    if (fallbackRoute && fallbackRoute.providerName !== primaryRoute.providerName) {
      attempts.push(...buildKeyAttemptsForRoute(fallbackRoute, "fallback", attempts.length));
    }
  }
  return { primaryRoute, attempts };
}

/**
 * Rewrite the model id a request carries upstream. Adapters read `parsed.modelId`, while
 * Responses-style adapters serialize `parsed._rawBody`, so both must be kept in sync.
 */
export function applyParsedModelId(parsed: FrogParsedRequest, modelId: string): void {
  if (parsed._rawBody && typeof parsed._rawBody === "object") {
    (parsed._rawBody as { model?: string }).model = modelId;
  }
  parsed.modelId = modelId;
}

export function cloneParsedForAttempt(base: FrogParsedRequest, attempt: AttemptContext): FrogParsedRequest {
  const parsed = structuredClone(base) as FrogParsedRequest;
  applyParsedModelId(parsed, attempt.modelId);
  if (parsed._messagesRawBody) {
    parsed._messagesRawBody.model = attempt.modelId;
  }
  return parsed;
}

export function isSameTargetRetryCandidate(attempt: AttemptContext, next: AttemptContext | undefined): boolean {
  return !!next
    && next.providerName === attempt.providerName
    && next.modelId === attempt.modelId;
}

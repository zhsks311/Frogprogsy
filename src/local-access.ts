/**
 * Local access keys — request-scoped authentication for the relay.
 *
 * The relay used to derive trust from where a request appeared to come from (a loopback bind plus the
 * `Origin`/`Host` headers). Both are properties the caller controls once the bind is not loopback, so
 * an exposed relay authenticated nobody. `localAccess` replaces that with a secret the caller must
 * present per request:
 *
 *   - Config stores only `sha256:<hex>` of each key; the plaintext exists once, when it is generated.
 *   - Verification is a constant-time digest comparison, so a wrong key leaks no prefix information.
 *   - `requestLimit` is a per-key sliding window enforced in-process (the relay is single-process).
 *
 * The key travels in `x-frogp-local-key`, or in the Anthropic auth slot (`x-api-key` /
 * `Authorization: Bearer …`) that Claude Code already fills from `ANTHROPIC_AUTH_TOKEN`, so an
 * existing client needs no new header. A presented key is registered as a relay-local credential
 * (`isLocalAccessSecret`), which keeps `forward` authMode from relaying it upstream as if it were the
 * caller's provider credential.
 */
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import type { FrogConfig, LocalAccessKeyConfig } from "./types";

export const LOCAL_ACCESS_HEADER = "x-frogp-local-key";
const SECRET_PREFIX = "frogp_";
const HASH_PREFIX = "sha256:";

export type LocalAccessDenial =
  | "missing_key"
  | "unknown_key"
  | "rate_limited";

export interface LocalAccessGrant {
  ok: true;
  key: LocalAccessKeyConfig;
}

export interface LocalAccessDenied {
  ok: false;
  reason: LocalAccessDenial;
  /** Present for `rate_limited` only; whole seconds until the window admits another request. */
  retryAfterSec?: number;
}

export type LocalAccessDecision = LocalAccessGrant | LocalAccessDenied;

export function isLocalAccessEnabled(config: FrogConfig): boolean {
  return config.localAccess?.enabled === true;
}

export function localAccessKeys(config: FrogConfig): LocalAccessKeyConfig[] {
  return config.localAccess?.keys ?? [];
}

/** `sha256:<hex>` digest of a plaintext key. Config never stores the plaintext. */
export function hashLocalAccessSecret(secret: string): string {
  return `${HASH_PREFIX}${createHash("sha256").update(secret, "utf8").digest("hex")}`;
}

/** A new 256-bit key. Printed once by the CLI/entrypoint that creates it. */
export function generateLocalAccessSecret(): string {
  return `${SECRET_PREFIX}${randomBytes(32).toString("base64url")}`;
}

function normalizedHash(secretHash: string): string | null {
  const trimmed = secretHash.trim().toLowerCase();
  const hex = trimmed.startsWith(HASH_PREFIX) ? trimmed.slice(HASH_PREFIX.length) : trimmed;
  return /^[0-9a-f]{64}$/.test(hex) ? hex : null;
}

/**
 * Reject a key list that cannot authenticate anything before the relay starts listening: a config
 * that looks like it protects the relay but cannot must never come up. Returns the offending reason,
 * or `null` when every entry is usable.
 */
export function localAccessConfigIssue(config: FrogConfig): string | null {
  const keys = localAccessKeys(config);
  if (keys.length === 0) return "localAccess.keys is empty; create one with: frogp local-key add <label>";
  const seen = new Set<string>();
  for (const key of keys) {
    const id = typeof key.id === "string" ? key.id.trim() : "";
    if (!id) return "every localAccess key needs a non-empty id";
    if (seen.has(id)) return `duplicate localAccess key id: ${id}`;
    seen.add(id);
    if (typeof key.secretHash !== "string" || !normalizedHash(key.secretHash)) {
      return `localAccess key ${id} needs secretHash as "sha256:<64 hex chars>"`;
    }
    if (key.requestLimit) {
      const { windowSec, maxRequests } = key.requestLimit;
      if (!Number.isFinite(windowSec) || windowSec <= 0 || !Number.isFinite(maxRequests) || maxRequests <= 0) {
        return `localAccess key ${id} needs requestLimit.windowSec and requestLimit.maxRequests > 0`;
      }
    }
    // Per-key provider/model scoping is declared by the type but no request path narrows a route to a
    // key yet. Fail closed rather than admit a key whose scope would silently not apply.
    if (key.providers !== undefined || key.models !== undefined) {
      return `localAccess key ${id} declares providers/models scopes, which are not enforced yet; remove them`;
    }
  }
  return null;
}

function constantTimeHashEquals(a: string, b: string): boolean {
  const left = Buffer.from(a, "hex");
  const right = Buffer.from(b, "hex");
  if (left.length !== right.length || left.length === 0) return false;
  return timingSafeEqual(left, right);
}

/**
 * Relay-local credentials seen so far: the digests configured at startup plus every digest that has
 * authenticated a request. `forward` authMode consults this to avoid relaying a relay key upstream as
 * the caller's provider credential.
 */
const relayLocalSecretHashes = new Set<string>();

/** Register the configured key digests. Called once per server start; safe to call repeatedly. */
export function registerLocalAccessKeys(config: FrogConfig): void {
  for (const key of localAccessKeys(config)) {
    const hash = typeof key.secretHash === "string" ? normalizedHash(key.secretHash) : null;
    if (hash) relayLocalSecretHashes.add(hash);
  }
}

/** True when `value` is a relay-local key (bare or `Bearer …`), i.e. not a caller provider credential. */
export function isLocalAccessSecret(value: string | undefined | null): boolean {
  const secret = bareSecret(value);
  if (!secret) return false;
  return relayLocalSecretHashes.has(normalizedHash(hashLocalAccessSecret(secret)) ?? "");
}

/** Test seam: drop the registered digests so an isolated case starts from a clean process state. */
export function __resetLocalAccessRegistry(): void {
  relayLocalSecretHashes.clear();
  runtimeAccessToken = null;
}

function bareSecret(value: string | undefined | null): string | undefined {
  const trimmed = value?.trim();
  if (!trimmed) return undefined;
  const bearer = /^Bearer\s+(.+)$/i.exec(trimmed);
  return (bearer ? bearer[1].trim() : trimmed) || undefined;
}

/** The key candidates a request carries, in the order they are tried. */
export function presentedLocalAccessSecrets(headers: Headers): string[] {
  const candidates = [
    headers.get(LOCAL_ACCESS_HEADER),
    headers.get("x-api-key"),
    headers.get("authorization"),
  ];
  const out: string[] = [];
  for (const candidate of candidates) {
    const secret = bareSecret(candidate);
    if (secret && !out.includes(secret)) out.push(secret);
  }
  return out;
}

/**
 * A per-start secret written to `~/.frogprogsy/local-access.token` (mode 0600). Reading it proves the
 * caller is a same-machine process with access to the config directory — which already holds the
 * provider credentials — so `frogp models`/`doctor` keep working against an authenticated relay
 * without the user pasting a key. It is not part of the config and never survives a restart.
 */
let runtimeAccessToken: string | null = null;

export const RUNTIME_ACCESS_KEY_ID = "runtime-local";

export function setRuntimeAccessToken(secret: string | null): void {
  runtimeAccessToken = secret?.trim() || null;
  if (runtimeAccessToken) {
    const digest = normalizedHash(hashLocalAccessSecret(runtimeAccessToken));
    if (digest) relayLocalSecretHashes.add(digest);
  }
}

const requestWindows = new Map<string, number[]>();

function withinRequestLimit(key: LocalAccessKeyConfig, now: number): { ok: boolean; retryAfterSec?: number } {
  const limit = key.requestLimit;
  if (!limit) return { ok: true };
  const windowMs = limit.windowSec * 1000;
  const hits = (requestWindows.get(key.id) ?? []).filter(at => now - at < windowMs);
  if (hits.length >= limit.maxRequests) {
    requestWindows.set(key.id, hits);
    const oldest = hits[0] ?? now;
    return { ok: false, retryAfterSec: Math.max(1, Math.ceil((windowMs - (now - oldest)) / 1000)) };
  }
  hits.push(now);
  requestWindows.set(key.id, hits);
  return { ok: true };
}

/** Test seam: forget every sliding window so limits do not leak between cases. */
export function __resetLocalAccessRequestWindows(): void {
  requestWindows.clear();
}

/**
 * Authenticate a request against the configured keys and charge it against that key's request limit.
 * Only call this when `isLocalAccessEnabled(config)`; a matched key is also registered as a
 * relay-local credential so `forward` providers do not relay it upstream.
 */
export function authorizeLocalAccess(config: FrogConfig, headers: Headers, now = Date.now()): LocalAccessDecision {
  const presented = presentedLocalAccessSecrets(headers);
  if (presented.length === 0) return { ok: false, reason: "missing_key" };

  for (const secret of presented) {
    const digest = normalizedHash(hashLocalAccessSecret(secret));
    if (!digest) continue;
    if (runtimeAccessToken) {
      const tokenDigest = normalizedHash(hashLocalAccessSecret(runtimeAccessToken));
      if (tokenDigest && constantTimeHashEquals(digest, tokenDigest)) {
        return { ok: true, key: { id: RUNTIME_ACCESS_KEY_ID, label: "same-machine process", secretHash: `${HASH_PREFIX}${tokenDigest}` } };
      }
    }
    for (const key of localAccessKeys(config)) {
      const expected = typeof key.secretHash === "string" ? normalizedHash(key.secretHash) : null;
      if (!expected || !constantTimeHashEquals(digest, expected)) continue;
      relayLocalSecretHashes.add(digest);
      const limit = withinRequestLimit(key, now);
      if (!limit.ok) return { ok: false, reason: "rate_limited", retryAfterSec: limit.retryAfterSec };
      return { ok: true, key };
    }
  }
  return { ok: false, reason: "unknown_key" };
}

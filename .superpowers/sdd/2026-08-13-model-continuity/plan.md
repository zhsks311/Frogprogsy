# Model Continuity Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Detect every configured retired-model reference, let users replace it through GUI or CLI, and provide opt-in exact-model fallback for ordinary `/v1/messages` requests.

**Architecture:** `src/model-continuity.ts` owns catalog-backed retirement facts, policy validation, reference inventory, owner-specific replacement, and the 30-second in-memory circuit map. Existing routing and attempt code remains the data-plane owner: it appends only exact continuity candidates, rebuilds each candidate from the immutable parsed request, and never uses generic `fallbackProviders` for continuity. The existing Models page and online-only `frogp models` command consume one management API report.

**Tech Stack:** Bun, TypeScript, Zod-backed existing catalog types, React 19, Vite, Bun test.

## Global Constraints

- Work only in the existing linked worktree `/Users/d66hjkxwt9/orca/workspaces/frogprogsy/모델-하위호환` on branch `feature/model-fadeout`.
- `structure/11_model-continuity.md` is the approved design and must remain the source of truth.
- Automatic fallback defaults to `off`; never infer a target from a model name, family, price, prompt, or provider default.
- A continuity sequence contains at most three exact configured `provider/model` targets in user order.
- Keep `fallbackProviders` independent; it must never supply a continuity candidate.
- Keep the auto-mode classifier pinned to one explicit target; its inventory row supports permanent replacement but rejects automatic continuity.
- First implementation automates only ordinary routed `/v1/messages` requests. Mixing internals and web-search/image helper calls receive diagnosis and permanent replacement only.
- Retry only connection failure, header timeout, and HTTP 404/410/429/5xx observed before a successful response body. Never retry free-form SSE error text, adapter parse failures, auth/request/context/tool/schema errors, or post-output failures.
- Runtime circuit state is memory-only, keyed by exact configured provider/model, and expires after 30 seconds without timers or persistence.
- Automatic resolution never rewrites the persisted primary target. Only the explicit `replace` action mutates an owner setting.
- Do not add dependencies, a new GUI page, a state/history file, a background worker, polling, or model probing.
- Preserve response metadata on the requested Claude Code alias and reuse existing safe request-log fields.
- Use Bun for all install, check, test, GUI build, and packaging commands. Do not add an npm local workflow.
- Do not push a remote branch.

---

### Task 1: Core policy and retirement facts

**Files:**
- Create: `src/model-continuity.ts`
- Modify: `src/types.ts:311-420`
- Modify: `src/model-catalog-config.ts:340-360`
- Test: `tests/model-continuity.test.ts`
- Test: `tests/model-catalog-config.test.ts:351-381`

**Interfaces:**
- Consumes: `FrogConfig`, `SelectedModelCatalog`, `ModelCatalogProviderV1`, existing `disabledModels` representation.
- Produces:
  - `ModelContinuityAutomatic = "off" | "retired" | "transient" | "all"`
  - `ModelContinuityPolicy { fallbacks: string[]; automatic: ModelContinuityAutomatic }`
  - `FrogConfig.modelContinuity?: Record<string, ModelContinuityPolicy>`
  - `qualifiedModelTarget(value: string): { provider: string; model: string } | null`
  - `buildRetiredTargetIndex(config: FrogConfig, catalog: SelectedModelCatalog): ReadonlySet<string>`
  - `normalizeContinuityPolicy(value: ModelContinuityPolicy | undefined): ModelContinuityPolicy`
  - `validateContinuityPolicy(input): { ok: true; policy: ModelContinuityPolicy; warnings: string[] } | { ok: false; error: string }`

- [ ] **Step 1: Write failing policy and retirement tests**

Add tests with concrete fixtures:

```ts
import { describe, expect, test } from "bun:test";
import {
  buildRetiredTargetIndex,
  normalizeContinuityPolicy,
  qualifiedModelTarget,
  validateContinuityPolicy,
} from "../src/model-continuity";

// Reuse a SelectedModelCatalog fixture whose provider id is "anthropic" and
// whose retiredModels is ["claude-old"]. The configured provider map key is
// deliberately renamed to "work" with catalogProviderId:"anthropic".

test("retirement uses catalogProviderId and never provider-name inference", () => {
  const retired = buildRetiredTargetIndex(configWithRenamedManagedProvider(), selectedCatalog());
  expect(retired.has("work/claude-old")).toBeTrue();
  expect(retired.has("custom/claude-old")).toBeFalse();
});

test("policy defaults off and preserves exact order", () => {
  expect(normalizeContinuityPolicy(undefined)).toEqual({ fallbacks: [], automatic: "off" });
  expect(validateContinuityPolicy(validPolicyInput([
    "work/claude-new",
    "codex/gpt-x",
  ]))).toEqual({
    ok: true,
    policy: { fallbacks: ["work/claude-new", "codex/gpt-x"], automatic: "all" },
    warnings: [],
  });
});

test.each([
  ["self", ["work/claude-old"]],
  ["duplicate", ["work/claude-new", "work/claude-new"]],
  ["too many", ["work/a", "work/b", "work/c", "work/d"]],
  ["retired", ["work/claude-retired"]],
  ["hidden", ["work/claude-hidden"]],
  ["unknown provider", ["missing/model"]],
])("rejects %s fallback candidates", (_name, fallbacks) => {
  expect(validateContinuityPolicy(policyInput({ fallbacks })).ok).toBeFalse();
});
```

Update the existing retired-default test so the effective managed provider keeps the persisted retired default rather than silently changing to the managed default:

```ts
expect(effective.providers.umans.defaultModel).toBe("umans-glm-5.1");
```

- [ ] **Step 2: Run the focused tests and confirm failure**

Run:

```bash
bun test --isolate ./tests/model-continuity.test.ts ./tests/model-catalog-config.test.ts
```

Expected: FAIL because `src/model-continuity.ts` and the new types do not exist, and the existing default still changes to `umans-coder`.

- [ ] **Step 3: Add the minimal config types**

In `src/types.ts`, add:

```ts
export type ModelContinuityAutomatic = "off" | "retired" | "transient" | "all";

export interface ModelContinuityPolicy {
  fallbacks: string[];
  automatic: ModelContinuityAutomatic;
}
```

Add this optional field to `FrogConfig` beside the other model-routing fields:

```ts
/** Exact ordinary-route fallback policies keyed by configured provider/model. */
modelContinuity?: Record<string, ModelContinuityPolicy>;
```

Do not add owner reference ids to persisted config. Reference ids belong to the management inventory only.

- [ ] **Step 4: Implement pure parsing, normalization, validation, and retirement indexing**

Create `src/model-continuity.ts` with these invariants:

```ts
export const MAX_CONTINUITY_FALLBACKS = 3;
export const CONTINUITY_CIRCUIT_MS = 30_000;

export function qualifiedModelTarget(value: string) {
  const slash = value.indexOf("/");
  if (slash <= 0 || slash === value.length - 1) return null;
  return { provider: value.slice(0, slash), model: value.slice(slash + 1) };
}

export function normalizeContinuityPolicy(policy: ModelContinuityPolicy | undefined): ModelContinuityPolicy {
  return policy
    ? { fallbacks: [...policy.fallbacks], automatic: policy.automatic }
    : { fallbacks: [], automatic: "off" };
}
```

`buildRetiredTargetIndex` must iterate configured providers, look up only `provider.catalogProviderId`, and add `<configured-name>/<retired-id>` for the matching selected catalog provider. Skip custom providers and `liveModels:false` providers unless they carry a verified catalog identity; never match URL, adapter, or visible name.

`validateContinuityPolicy` receives the primary target, config, retired index, visible model rows, requested automatic mode, and fallback strings. It performs structural/catalog boundary checks once and returns normalized data. It may warn for `supportStatus:"discovered"` or currently unavailable authentication, but it must reject `disabled:true` and every invalid target named in the global constraints. Authentication is request-dependent for forwarded providers, so policy save must not reject a configured target solely because the management snapshot reports `authReady:false`; the request loop resolves authentication independently for each attempt and skips an unusable candidate.

- [ ] **Step 5: Remove the implicit managed-default replacement**

Delete only this behavior from `mergeManagedProvider`:

```ts
if (persisted.defaultModel !== undefined && retiredModelIds.has(persisted.defaultModel)) {
  if (managed.defaultModel !== undefined) effective.defaultModel = managed.defaultModel;
  else delete effective.defaultModel;
}
```

Remove the now-unused local retired set from `mergeManagedProvider`. Preserve explicit `userModels` and custom-provider behavior.

- [ ] **Step 6: Run focused tests**

Run:

```bash
bun test --isolate ./tests/model-continuity.test.ts ./tests/model-catalog-config.test.ts
```

Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add src/model-continuity.ts src/types.ts src/model-catalog-config.ts tests/model-continuity.test.ts tests/model-catalog-config.test.ts
git commit -m "feat: define explicit model continuity policies"
```

---

### Task 2: Reference inventory and validated permanent replacement

**Files:**
- Modify: `src/model-continuity.ts`
- Modify: `src/model-aliases.ts:24-36,154-176`
- Test: `tests/model-continuity.test.ts`

**Interfaces:**
- Consumes: Task 1 policy functions, persisted/effective config, selected catalog, persisted aliases.
- Produces:
  - `ModelContinuityReferenceKind`
  - `ModelContinuityReference`
  - `collectModelContinuityReferences(input): ModelContinuityReference[]`
  - `replaceModelContinuityReference(input): { ok: true } | { ok: false; status: 400 | 409; error: string }`
  - `listPersistedModelAliases(): ModelAliasEntry[]`

- [ ] **Step 1: Write failing inventory tests**

Cover each active owner and the explicit exclusions:

```ts
test("inventory enumerates active owners and excludes dormant typed fields", () => {
  const rows = collectModelContinuityReferences(inventoryInput());
  expect(rows.map(row => row.kind)).toEqual([
    "provider-default",
    "long-context",
    "subagent",
    "classifier",
    "mix-coordinator",
    "mix-agent",
    "mix-pipeline",
    "mix-panel",
    "mix-judge",
    "mix-synthesizer",
    "mix-rule",
    "web-search-helper",
    "image-helper",
    "gateway-alias",
  ]);
  expect(rows.some(row => row.id.includes("shadowCompare"))).toBeFalse();
  expect(rows.some(row => row.id.includes("searchProviders"))).toBeFalse();
});

test("same target keeps separate permanent-replacement owners", () => {
  const rows = collectModelContinuityReferences(repeatedTargetInput());
  const repeated = rows.filter(row => row.primary === "codex/gpt-x");
  expect(repeated.map(row => row.id)).toEqual([
    "provider-default:codex",
    "classifier",
    "mix-agent:0",
  ]);
});
```

Each row must expose:

```ts
interface ModelContinuityReference {
  id: string;
  kind: ModelContinuityReferenceKind;
  primary: string;
  status: "ready" | "retired" | "authentication_required" | "policy_invalid";
  automaticEligible: boolean;
  policy: ModelContinuityPolicy;
  supportStatus: "validated" | "discovered" | "unknown";
  label: string;
}
```

- [ ] **Step 2: Write failing owner replacement tests**

```ts
test("replacement rejects stale expected target", () => {
  const result = replaceModelContinuityReference({
    config,
    referenceId: "mix-agent:0",
    expectedPrimary: "codex/old",
    replacement: "codex/new",
    validateTarget,
  });
  expect(result).toEqual({ ok: false, status: 409, error: "model reference changed; reload and retry" });
});

test("provider default replacement stays inside its provider", () => {
  expect(replace("provider-default:work", "work/old", "codex/new").ok).toBeFalse();
  expect(replace("provider-default:work", "work/old", "work/new").ok).toBeTrue();
  expect(config.providers.work.defaultModel).toBe("new");
});

test("classifier replacement reuses strict classifier validation", () => {
  expect(replace("classifier", "work/old", "codex/new").ok).toBeTrue();
  expect(config.autoModeClassifier).toEqual({ provider: "codex", model: "new" });
});
```

Also cover long-context, subagent index, every model-mixing target array/singleton, web-search helper, and image helper. A gateway alias row has no mutable owner and must return a clear 400 directing the caller to configure a route policy instead.

- [ ] **Step 3: Run the focused test and confirm failure**

Run:

```bash
bun test --isolate ./tests/model-continuity.test.ts
```

Expected: FAIL because inventory/replacement functions and alias listing do not exist.

- [ ] **Step 4: Implement deterministic reference ids and inventory**

Use fixed singleton ids and array-index ids protected by `expectedPrimary`:

```ts
const ids = {
  providerDefault: (provider: string) => `provider-default:${provider}`,
  longContext: "long-context",
  subagent: (index: number) => `subagent:${index}`,
  classifier: "classifier",
  mixAgent: (index: number) => `mix-agent:${index}`,
  mixPipeline: (index: number) => `mix-pipeline:${index}`,
  mixPanel: (index: number) => `mix-panel:${index}`,
  mixRule: (index: number) => `mix-rule:${index}`,
};
```

Do not call these ids from the data plane. They identify configuration owners only. Inventory must derive retirement from Task 1's immutable index, capability/support status from the current model rows, and automatic eligibility from kind. `classifier`, all `mix-*`, `web-search-helper`, `image-helper`, and `subagent` rows set `automaticEligible:false` in this implementation.
Gateway-alias rows must be limited to aliases whose provider still exists and whose route is either active in the current configured/effective model universe or present in the current retired-target index. Do not surface stale file entries from removed providers as configurable references.

- [ ] **Step 5: Implement owner-specific replacement**

Use a switch over the parsed reference id. Guard every mutation with exact `expectedPrimary` equality and target validation. Rules:

- provider default: replacement provider must equal the owner provider; store the model part;
- long-context, classifier, mixing, web-search helper, image helper: store both provider and model;
- subagent: replace only the exact current array index;
- gateway alias: reject permanent replacement because a past Claude session is not a mutable config owner.

Return a mutation result; do not save inside the pure function. The management API will call `state.persist()` and the existing catalog refresh after success.

- [ ] **Step 6: Export alias listing without exposing file paths**

Add:

```ts
export function listPersistedModelAliases(): ModelAliasEntry[] {
  return Object.values(readState().aliases).map(entry => ({ ...entry }));
}
```

Do not expose `MODEL_ALIASES_PATH` through the API report.

- [ ] **Step 7: Run focused tests**

```bash
bun test --isolate ./tests/model-continuity.test.ts ./tests/model-alias-stability.test.ts
```

Expected: PASS.

- [ ] **Step 8: Commit**

```bash
git add src/model-continuity.ts src/model-aliases.ts tests/model-continuity.test.ts
git commit -m "feat: inventory and replace model references"
```

---

### Task 3: Retired alias tombstones and typed routing result

**Files:**
- Modify: `src/model-aliases.ts:24-36,102-151,154-176`
- Modify: `src/router.ts:23-32,280-320`
- Modify: `src/runtime-config-state.ts:32-51,91-93`
- Modify: `src/server.ts:739-839,4221-4237,4373-4387`
- Test: `tests/model-alias-stability.test.ts`
- Test: `tests/router-matching.test.ts`
- Test: `tests/model-continuity.test.ts`

**Interfaces:**
- Consumes: Task 1 retired index, Task 2 alias listing.
- Produces:
  - `ModelAliasEntry.status?: "active" | "retired"` (absent reads as active)
  - `reconcileRetiredModelAliases(retiredTargets: ReadonlySet<string>): ModelAliasEntry[]`
  - `RouteResult.retired?: true`
  - `RuntimeConfigState.retiredTargets: ReadonlySet<string>`

- [ ] **Step 1: Write failing tombstone tests**

```ts
test("canonical pruning preserves only currently catalog-confirmed retired aliases", () => {
  const [old] = materializeModelAliases([{ provider: "work", model: "old" }], { prune: true });
  reconcileRetiredModelAliases(new Set(["work/old"]));
  materializeModelAliases([{ provider: "work", model: "new" }], { prune: true });

  expect(resolvePersistedModelAlias(old.alias)).toMatchObject({
    routeKey: "work/old",
    status: "retired",
  });
  expect(materializeModelAliases([{ provider: "work", model: "new" }])).not.toContainEqual(
    expect.objectContaining({ routeKey: "work/old" }),
  );

  reconcileRetiredModelAliases(new Set());
  materializeModelAliases([{ provider: "work", model: "new" }], { prune: true });
  expect(resolvePersistedModelAlias(old.alias)).toBeUndefined();
});

test("a newly active slug collision cannot overwrite a retired alias", () => {
  const [old] = materializeModelAliases([{ provider: "a", model: "b-c" }], { prune: true });
  reconcileRetiredModelAliases(new Set(["a/b-c"]));
  const [current] = materializeModelAliases([{ provider: "a-b", model: "c" }], { prune: true });

  expect(current.alias).not.toBe(old.alias);
  expect(resolvePersistedModelAlias(old.alias)?.routeKey).toBe("a/b-c");
  expect(resolvePersistedModelAlias(current.alias)?.routeKey).toBe("a-b/c");
});

test("router distinguishes retired tombstone from fabricated gateway alias", () => {
  const retired = routeModel(config, retiredAlias);
  expect(retired).toMatchObject({ providerName: "work", modelId: "old", retired: true });
  expect(() => routeModel(config, "claude-frogp-fabricated")).toThrow("Unknown gateway model alias");
});
```

- [ ] **Step 2: Run focused tests and confirm failure**

```bash
bun test --isolate ./tests/model-alias-stability.test.ts ./tests/router-matching.test.ts ./tests/model-continuity.test.ts
```

Expected: FAIL because tombstone fields and retired routing facts do not exist.

- [ ] **Step 3: Extend the alias registry compatibly**

Add the optional status:

```ts
status?: "active" | "retired";
```

Treat absent status as active for schema-version-1 compatibility. Active materialization writes `status:"active"`. `reconcileRetiredModelAliases` marks only existing entries whose exact route key appears in the supplied retired set, and removes the retired status from every entry no longer confirmed by that set. A canonical `prune:true` removes stale active entries but preserves entries still marked retired. Return/publish only active entries so tombstones never appear in picker/catalog output. Add regressions for a provider removed from config and for a model removed from `retiredModels`: neither may leave an authoritative retired tombstone behind.

Every writer must reserve alias strings owned by current tombstones. If a new active route's computed alias equals a tombstone alias for a different route key, assign the active route its deterministic collision suffix; never overwrite or rename the tombstone because existing Claude Code sessions still carry that exact alias. Subset writers may reuse a tombstone alias only when the route key itself is the same and has become active again.

Do not synthesize a new alias for a model already retired before this installation; no existing session can depend on an alias FrogProgsy never issued. The selected catalog is the only tombstone authority; an old registry status cannot keep a route retired after catalog/config reconciliation.

- [ ] **Step 4: Carry retired facts through routing**

When `resolveConfiguredModelAlias` returns a tombstone, return the exact configured provider/model route with `retired:true`. Unknown gateway aliases continue to throw the existing redacted error.

For an explicit qualified target, `handleMessages` checks `state.retiredTargets` before attempts. A retired exact target and a retired alias both enter the continuity preflight. Do not make `routeModel` read the catalog or global process state.

- [ ] **Step 5: Add retired targets to runtime config state**

Compute once from persisted config plus selected catalog:

```ts
retiredTargets: ReadonlySet<string>;
```

Recompute it in `rebuild()` because provider catalog bindings may change. At startup and after each runtime rebuild, call `reconcileRetiredModelAliases(state.retiredTargets)` before any canonical catalog writer can prune the prior active alias.

Update test-state construction with the same deterministic computation.

- [ ] **Step 6: Return typed 410 when automatic retirement is off**

Pass `state.retiredTargets` into `handleMessages` through its options. Before building attempts:

```ts
if (primaryIsRetired && !continuityAllowsRetired(policy)) {
  return formatAnthropicErrorResponse(
    410,
    "invalid_request_error",
    `Model "${responseModelId}" was retired. Run: frogp models continuity`,
  );
}
```

Do not echo secrets or local paths. Keep fabricated/unknown aliases on 404.

- [ ] **Step 7: Run focused tests**

```bash
bun test --isolate ./tests/model-alias-stability.test.ts ./tests/router-matching.test.ts ./tests/model-continuity.test.ts
```

Expected: PASS.

- [ ] **Step 8: Commit**

```bash
git add src/model-aliases.ts src/router.ts src/runtime-config-state.ts src/server.ts tests/model-alias-stability.test.ts tests/router-matching.test.ts tests/model-continuity.test.ts
git commit -m "feat: preserve retired model aliases safely"
```

---

### Task 4: Exact continuity attempts and 30-second circuit

**Files:**
- Modify: `src/model-continuity.ts`
- Modify: `src/provider-fallback.ts:5-101`
- Modify: `src/server.ts:739-1027,1170-1231`
- Modify: `src/server.ts:1349-1385` request-log continuity field
- Test: `tests/provider-fallback-chain.test.ts`
- Test: `tests/fallback-attempt-context.test.ts`
- Test: `tests/model-continuity-runtime.test.ts`

**Interfaces:**
- Consumes: Task 1 policies/retired index and existing `AttemptContext` loop.
- Produces:
  - `ContinuityCircuit` with `isOpen`, `open`, `succeed`, and a redacted `snapshot(now)` for management reporting
  - `continuityCandidates(primary, policy, retiredTargets, circuit, now): string[]`
  - `buildKeyAttemptsForRoute(route, source, firstAttemptIndex)` exported from `provider-fallback.ts`
  - `buildAttemptContexts(config, parsed, options)` where options may provide exact continuity routes and suppress generic provider fallback for classifier as before
  - `isContinuityEligibleHttpFailure(status, details): ContinuityReason | null`, based only on status and exact structured error type/code
  - `RequestLogEntry.continuityReason?: "retired" | "connect_failure" | "connect_timeout" | "http_404" | "http_410" | "http_429" | "http_5xx" | "circuit_open"`

- [ ] **Step 1: Write failing pure circuit tests**

Use an injected clock; never sleep:

```ts
test("circuit opens for 30 seconds and clears on success", () => {
  const circuit = new ContinuityCircuit();
  circuit.open("work/old", "http_5xx", 1_000);
  expect(circuit.isOpen("work/old", 30_999)).toBeTrue();
  expect(circuit.isOpen("work/old", 31_000)).toBeFalse();

  circuit.open("work/old", "http_5xx", 40_000);
  circuit.succeed("work/old");
  expect(circuit.isOpen("work/old", 40_001)).toBeFalse();
});
```

- [ ] **Step 2: Write failing data-plane tests**

Base them on `tests/provider-fallback-chain.test.ts` and assert exact URLs, model bodies, attempts, and auth boundaries:

```ts
test("503 uses exact continuity fallback instead of fallbackProviders default", async () => {
  const cfg = baseConfig();
  cfg.fallbackProviders = ["later"];
  cfg.modelContinuity = {
    "primary/primary-model": {
      fallbacks: ["fallback/fallback-other"],
      automatic: "transient",
    },
  };

  // primary returns 503; fallback/fallback-other returns 200.
  const response = await invokeMessages(cfg);
  expect(response.status).toBe(200);
  expect(calls.map(call => [call.url, call.body.model])).toEqual([
    ["https://primary.test/v1/messages", "primary-model"],
    ["https://fallback.test/v1/messages", "fallback-other"],
  ]);
});

test.each([400, 401, 402, 403])("HTTP %i never uses continuity fallback", async status => {
  // Assert one upstream call and the same terminal status.
});

test("retired mode selects exact fallback without calling primary", async () => {
  // Mark primary retired and assert only fallback/fallback-other is fetched.
});

test("open circuit skips primary then retries it after clock expiry", async () => {
  // Inject now=1_000 for first 503, now=2_000 for skip, now=31_001 for primary success.
});

test("200 stream error never triggers another target", async () => {
  // Return HTTP 200 SSE containing an adapter error event; assert one fetch.
});

test("request-dependent auth skips an unusable candidate without rejecting the saved policy", async () => {
  // First fallback requires forwarded credentials absent from this request.
  // Assert it is logged as skipped and the second exact fallback receives the request.
  // Repeat with a compatible forwarded header and assert the first fallback is used.
});

test("continuity classification never infers a context error from free-form text", () => {
  expect(isContinuityEligibleHttpFailure(500, {
    type: "upstream_error",
    message: "context window exceeded",
  })).toBe("http_5xx");
  expect(isContinuityEligibleHttpFailure(500, {
    type: "invalid_request_error",
    code: "context_length_exceeded",
    message: "structured provider error",
  })).toBeNull();
});
```

Also prove candidate reconstruction across adapters by using an Anthropic primary and OpenAI-chat fallback. Assert fallback URL, Authorization header, request body model, and the absence of primary-only fields.

- [ ] **Step 3: Run focused tests and confirm failure**

```bash
bun test --isolate ./tests/model-continuity-runtime.test.ts ./tests/provider-fallback-chain.test.ts ./tests/fallback-attempt-context.test.ts
```

Expected: FAIL because exact continuity candidates and circuit state are not implemented.

- [ ] **Step 4: Split reusable same-provider key attempt construction**

Export the existing key-attempt builder without changing its semantics:

```ts
export function buildKeyAttemptsForRoute(
  route: RouteResult,
  source: AttemptSource,
  firstAttemptIndex: number,
): AttemptContext[];
```

Keep generic provider fallback construction separate. Extend `AttemptSource` with `"continuity"`. Continuity routes are exact `{providerName, modelId}` pairs validated from policy; never derive their model from `provider.defaultModel`.

Ordering for an eligible request:

```text
primary key attempts
→ exact continuity fallback 1 key attempts
→ exact continuity fallback 2 key attempts
→ exact continuity fallback 3 key attempts
```

Do not append generic `fallbackProviders` when a continuity policy is handling the triggering retired/transient condition. Preserve existing generic behavior when no continuity policy applies.

- [ ] **Step 5: Implement the memory-only circuit**

`ContinuityCircuit` owns one private `Map<string, { until: number; reason: ContinuityReason }>` and performs lazy expiry in `isOpen`. It has no timer and no file I/O. Instantiate one circuit per server in `startServer`; tests inject their own instance and clock through `handleMessages` options.

Open the circuit only after the primary target's permitted same-provider key progression has exhausted on an eligible failure. Do not open it after an authentication-resolution failure or terminal status. Clear it after a successful primary upstream response. `snapshot(now)` returns only exact route key, reason enum, and expiry timestamp; it performs the same lazy expiry and never exposes credentials or upstream bodies.

- [ ] **Step 6: Integrate exact candidates into the existing attempt loop**

Before `buildAttemptContexts`, resolve the requested ordinary route and its exact primary key. Select a policy by that key. For `retired|all`, skip the retired primary and start with the first valid explicit target. For `transient|all`, enter continuity candidates only when `isContinuityEligibleHttpFailure` returns a reason:

- connection/header timeout;
- HTTP 404/410/429; or
- HTTP 5xx unless the parsed structured error `code` or `type` exactly identifies a context-limit error.

Do not call the existing `classifyError(status, type, message)` substring classifier to decide continuity. Keep the existing generic provider-fallback behavior unchanged; the ordinary request loop must select the continuity-specific predicate only when moving from a primary/continuity attempt to another explicit continuity candidate. A free-form 5xx body that merely contains words such as `context window` remains an eligible 5xx because it is not a trustworthy structured classification.

Use existing `cloneParsedForAttempt` for every candidate. Keep response metadata on `responseModelId`. Record `continuityReason` and existing attempt rows; do not add raw error bodies.

- [ ] **Step 7: Run focused tests**

```bash
bun test --isolate ./tests/model-continuity-runtime.test.ts ./tests/provider-fallback-chain.test.ts ./tests/provider-key-failover.test.ts ./tests/fallback-attempt-context.test.ts ./tests/fallback-abort.test.ts
```

Expected: PASS, including all pre-existing provider/key fallback behavior.

- [ ] **Step 8: Commit**

```bash
git add src/model-continuity.ts src/provider-fallback.ts src/server.ts tests/model-continuity-runtime.test.ts tests/provider-fallback-chain.test.ts tests/fallback-attempt-context.test.ts
git commit -m "feat: fail over exact model routes before output"
```

---

### Task 5: Management API

**Files:**
- Modify: `src/server.ts:2033-2044,2350-2370,2844-2895,4010-4055`
- Test: `tests/model-continuity-api.test.ts`
- Modify: `structure/05_gui-and-management-api.md`

**Interfaces:**
- Consumes: Tasks 1-4 inventory, validation, replacement, runtime circuit state.
- Produces:
  - `GET /api/model-continuity`
  - `POST /api/model-continuity` action `set | replace`
  - Stable report enums shared by CLI and GUI.

- [ ] **Step 1: Write failing GET report tests**

```ts
test("GET returns problem-first references without local paths or secrets", async () => {
  const response = await managementRequest("GET", "/api/model-continuity", state);
  expect(response.status).toBe(200);
  const body = await response.json() as ContinuityReport;
  expect(body.references[0]).toMatchObject({
    kind: "provider-default",
    status: "retired",
    primary: "work/old",
    automaticEligible: true,
  });
  expect(JSON.stringify(body)).not.toContain(state.persisted.providers.work.apiKey!);
  expect(JSON.stringify(body)).not.toContain(process.env.FROGPROGSY_HOME!);
});
```

Report shape:

```ts
interface ContinuityReport {
  policies: Record<string, ModelContinuityPolicy>;
  references: ModelContinuityReference[];
}
```

Sort references by severity (`retired`, invalid/auth, ready), then label, then id for deterministic CLI/GUI output.

- [ ] **Step 2: Write failing POST action tests**

```ts
test("set validates exact policies and persists once", async () => {
  const response = await post({
    action: "set",
    primary: "work/old",
    fallbacks: ["work/new"],
    automatic: "retired",
  });
  expect(response.status).toBe(200);
  expect(saved.modelContinuity?.["work/old"]).toEqual({
    fallbacks: ["work/new"],
    automatic: "retired",
  });
});

test("set rejects classifier automatic fallback", async () => {
  const response = await post({
    action: "set",
    referenceId: "classifier",
    primary: "work/old",
    fallbacks: ["work/new"],
    automatic: "all",
  });
  expect(response.status).toBe(400);
});

test("replace rejects stale owner and refreshes catalog only after success", async () => {
  // First request uses wrong expectedPrimary -> 409, zero saves, zero refreshes.
  // Second request uses current primary -> 200, one save, one refresh.
});
```

Also test non-local mutation rejection through the existing management origin guard.

- [ ] **Step 3: Run the focused API test and confirm failure**

```bash
bun test --isolate ./tests/model-continuity-api.test.ts
```

Expected: FAIL with unknown endpoint.

- [ ] **Step 4: Add the GET endpoint**

Use `state.persisted`, `state.effective`, `state.catalog`, current model rows from `effectiveModelView`, active/retired aliases, and the server circuit snapshot. Return public fields only. Do not let the GUI reconstruct inventory from several endpoints.

- [ ] **Step 5: Add `set` and `replace` actions**

Parse a discriminated action object:

```ts
type ContinuityAction =
  | { action: "set"; primary: string; fallbacks: string[]; automatic: ModelContinuityAutomatic; referenceId?: string }
  | { action: "replace"; referenceId: string; expectedPrimary: string; replacement: string };
```

`set` validates and either writes the normalized policy or deletes the map entry when the normalized policy is `{fallbacks:[], automatic:"off"}`. `replace` calls Task 2's owner function. Both call `state.persist()` exactly once on success. `replace` also calls the existing best-effort Claude catalog refresh after persistence. Errors return stable `{error, code}` without config paths.

- [ ] **Step 6: Update the management SOT**

Add the two endpoints and the ordinary-route-only automation boundary to `structure/05_gui-and-management-api.md`. Keep `structure/11_model-continuity.md` authoritative for the full behavior.

- [ ] **Step 7: Run focused management tests**

```bash
bun test --isolate ./tests/model-continuity-api.test.ts ./tests/provider-rest-api.test.ts ./tests/claude-profile-dashboard-api.test.ts
```

Expected: PASS.

- [ ] **Step 8: Commit**

```bash
git add src/server.ts tests/model-continuity-api.test.ts structure/05_gui-and-management-api.md
git commit -m "feat: expose model continuity management"
```

---

### Task 6: CLI continuity workflow

**Files:**
- Modify: `src/cli.ts:190-225,819-939,2070-2080`
- Modify: `tests/cli-models.test.ts`
- Modify: `docs-site/content/docs/en/reference/cli.md`
- Modify: `docs-site/content/docs/ko/reference/cli.md`
- Modify: `docs-site/content/docs/zh-cn/reference/cli.md`

**Interfaces:**
- Consumes: Task 5 management API.
- Produces:
  - `frogp models continuity [--json]`
  - `frogp models continuity set <provider/model> --fallback <provider/model>... --auto off|retired|transient|all`
  - `frogp models continuity replace <reference-id> <provider/model>`

- [ ] **Step 1: Extend the stub proxy and write failing CLI tests**

```ts
test("models continuity prints problem, impact, and executable next action", async () => {
  const result = await runCli(home, ["models", "continuity"]);
  expect(result.status).toBe(0);
  expect(result.stdout).toContain("work/old");
  expect(result.stdout).toContain("retired");
  expect(result.stdout).toContain("frogp models continuity replace provider-default:work work/new");
});

test("models continuity --json prints the API document unchanged", async () => {
  const result = await runCli(home, ["models", "continuity", "--json"], { FORCE_COLOR: "1" });
  expect(JSON.parse(result.stdout)).toEqual(STUB_CONTINUITY_REPORT);
  expect(result.stdout).not.toContain("\u001b[");
});

test("set preserves repeated fallback order", async () => {
  const result = await runCli(home, [
    "models", "continuity", "set", "work/old",
    "--fallback", "work/new",
    "--fallback", "codex/gpt-x",
    "--auto", "all",
  ]);
  expect(stub.actions.at(-1)).toEqual({
    action: "set",
    primary: "work/old",
    fallbacks: ["work/new", "codex/gpt-x"],
    automatic: "all",
  });
});
```

Add unknown option, missing argument, stopped proxy, API 400, and replace command tests.

- [ ] **Step 2: Run focused CLI tests and confirm failure**

```bash
bun test --isolate ./tests/cli-models.test.ts
```

Expected: FAIL because `models` treats `continuity` as an unknown flag.

- [ ] **Step 3: Parse the subcommand without changing plain `frogp models`**

Keep `handleModels([])` and `handleModels(["--json"])` byte-compatible. Dispatch `args[0] === "continuity"` to `handleModelsContinuity(args.slice(1))`.

Use one existing online-proxy helper pattern for PID, health, local access headers, timeout, and API errors. Do not read or synthesize offline config state.

- [ ] **Step 4: Implement deterministic human and JSON output**

Human output prints problem rows first. For each row print:

```text
[retired] Provider default · work/old
  Automatic: off
  Fallbacks: work/new
  Replace: frogp models continuity replace provider-default:work work/new
```

Use existing color helpers; respect `NO_COLOR`, non-TTY defaults, and JSON no-ANSI rules. Send all diagnostics to stderr in JSON mode.

- [ ] **Step 5: Implement set and replace POST calls**

Preserve repeated `--fallback` order. Require exactly one `--auto` value. `replace` takes exactly a reference id and replacement target. Print the server's safe error and exit 1 on non-2xx.

- [ ] **Step 6: Update localized CLI references**

Add the exact three commands, default-off semantics, automatic modes, ordinary-route-only boundary, and classifier/manual-only note to each localized CLI reference. Do not duplicate the full architecture.

- [ ] **Step 7: Run focused CLI tests**

```bash
bun test --isolate ./tests/cli-models.test.ts ./tests/model-continuity-api.test.ts
```

Expected: PASS.

- [ ] **Step 8: Commit**

```bash
git add src/cli.ts tests/cli-models.test.ts docs-site/content/docs/en/reference/cli.md docs-site/content/docs/ko/reference/cli.md docs-site/content/docs/zh-cn/reference/cli.md
git commit -m "feat: add model continuity CLI controls"
```

---

### Task 7: Models-page problem cards and policy editor

**Files:**
- Modify: `gui/src/pages/Models.tsx`
- Modify: `gui/src/styles.css`
- Modify: `gui/src/i18n/en.ts`
- Modify: `gui/src/i18n/ko.ts`
- Modify: `gui/src/i18n/zh.ts`
- Modify: `tests/gui-provider-ux-smoke.test.ts`
- Modify: `tests/gui-interaction-stability.test.ts`
- Modify: `docs-site/content/docs/en/guides/web-dashboard.md`
- Modify: `docs-site/content/docs/ko/guides/web-dashboard.md`
- Modify: `docs-site/content/docs/zh-cn/guides/web-dashboard.md`

**Interfaces:**
- Consumes: Task 5 GET/POST report/action API.
- Produces:
  - `parseModelContinuityReport(value: unknown): ModelContinuityReport`
  - `ModelContinuityPanel` rendered inside the existing Models page
  - Localized problem-first copy and accessible controls.

- [ ] **Step 1: Write failing report parser and static-render tests**

```ts
test("continuity parser rejects malformed enums and preserves server order", () => {
  expect(() => parseModelContinuityReport({ references: [{ status: "maybe" }] })).toThrow();
  expect(parseModelContinuityReport(STUB_CONTINUITY_REPORT).references.map(row => row.id)).toEqual([
    "provider-default:work",
    "classifier",
    "mix-agent:0",
  ]);
});

test("problem card leads with impact and action, not internal reference id", () => {
  const html = renderToStaticMarkup(
    React.createElement(ModelContinuityPanel, {
      report: STUB_CONTINUITY_REPORT,
      t: tKo,
      onSet: async () => true,
      onReplace: async () => true,
    }),
  );
  expect(html).toContain("기본 모델이 종료됐습니다");
  expect(html).toContain("영구 교체");
  expect(html).not.toContain("provider-default:work");
});

test("classifier row has no automatic selector", () => {
  const html = renderContinuityPanel(classifierOnlyReport());
  expect(html).toContain("자동 모드 심사");
  expect(html).not.toContain("자동 대응 범위");
});
```

- [ ] **Step 2: Write failing interaction tests**

Use the existing interaction test harness to assert:

- repeated fallback selects preserve order;
- save sends one `set` action and rolls the draft back on failure;
- permanent replacement requires an explicit confirmation and sends `expectedPrimary`;
- a stale 409 reloads the report and shows an actionable message;
- normal rows start collapsed;
- controls have labels and keyboard focus order.

- [ ] **Step 3: Run focused GUI tests and confirm failure**

```bash
bun test --isolate ./tests/gui-provider-ux-smoke.test.ts ./tests/gui-interaction-stability.test.ts
```

Expected: FAIL because the parser and panel do not exist.

- [ ] **Step 4: Load continuity data with the existing Models page requests**

Extend `load()` to fetch `/api/model-continuity` beside `/api/models` and catalog status. A failed continuity request must not hide the existing model list; show one local problem message and keep model visibility controls usable.

Export the parser and panel for tests. The parser accepts only the stable enums from Task 5 and defaults no fields silently except optional display metadata.

- [ ] **Step 5: Build one problem-first section**

Place it after the hero/catalog status and before model visibility controls. Render:

1. attention rows (`retired`, invalid/auth) as open cards;
2. active automatic-route status if present;
3. normal references in one collapsed disclosure.

Each open card shows user purpose, primary target, reason, fallback order, and one primary action. Put the raw reference id only in an existing developer-detail style disclosure.

Do not add a page, wizard, history table, raw JSON editor, provider health probe, or timer countdown.

- [ ] **Step 6: Implement policy save and permanent replacement**

For `automaticEligible:true`, provide up to three exact model selects populated from current selectable model rows. Preserve order. Automatic mode defaults to off. For ineligible rows, omit the selector and explain that only permanent replacement is available.

POST actions:

```ts
await fetch(`${apiBase}/api/model-continuity`, {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify(action),
});
```

After success, reload `/api/model-continuity`, `/api/models`, and featured models. On failure, retain the prior saved view and show the server's safe action message.

- [ ] **Step 7: Add focused CSS and translations**

Reuse existing `panel`, `Notice`, `btn`, `select-sm`, badge, and model-card styles. Add only layout rules that these components cannot express. Keep the first scan answer: status, impact, action.

Add matching keys in English, Korean, and Chinese. Buttons must predict results, for example:

- `Replace permanently`
- `영구 교체`
- `永久替换`

Avoid internal terms such as circuit, tombstone, adapter, or reference id in default copy.

- [ ] **Step 8: Update localized dashboard guides**

Describe where the section appears, what automatic modes do, why classifier/mixing/helper rows are manual-only, and how permanent replacement differs from temporary routing. Keep raw API details in the reference docs.

- [ ] **Step 9: Run focused GUI tests and build**

```bash
bun test --isolate ./tests/gui-provider-ux-smoke.test.ts ./tests/gui-interaction-stability.test.ts
bun run build:gui
```

Expected: both tests PASS and GUI build exits 0.

- [ ] **Step 10: Browser-drive the changed flow**

Create `/tmp/frogp-model-continuity-gui/config.json` with this isolated fixture:

```json
{
  "port": 3774,
  "defaultProvider": "umans",
  "providers": {
    "umans": {
      "adapter": "anthropic",
      "baseUrl": "https://api.code.umans.ai",
      "catalogProviderId": "umans",
      "apiKey": "test-only",
      "defaultModel": "umans-glm-5.1"
    }
  }
}
```

Build the GUI, then start `bun run src/cli.ts start` through the harness process manager with `FROGPROGSY_HOME=/tmp/frogp-model-continuity-gui` and `FROGP_NO_WATCHDOG=1`. Wait for port 3774. In a real browser:

1. open `http://127.0.0.1:3774/#models`;
2. confirm a retired problem card is visible before the normal model list;
3. set fallback order and automatic mode;
4. reload and confirm persistence;
5. trigger permanent replacement and confirm the card resolves;
6. confirm classifier/mixing/helper rows omit automatic controls;
7. confirm narrow viewport wrapping and keyboard-accessible controls.

Stop the managed process and remove only `/tmp/frogp-model-continuity-gui` after capture. Record observed results; do not claim visual verification from static markup alone.

- [ ] **Step 11: Commit**

```bash
git add gui/src/pages/Models.tsx gui/src/styles.css gui/src/i18n/en.ts gui/src/i18n/ko.ts gui/src/i18n/zh.ts tests/gui-provider-ux-smoke.test.ts tests/gui-interaction-stability.test.ts docs-site/content/docs/en/guides/web-dashboard.md docs-site/content/docs/ko/guides/web-dashboard.md docs-site/content/docs/zh-cn/guides/web-dashboard.md
git commit -m "feat: add model continuity controls to Models"
```

---

### Task 8: Public configuration contract, integrated smoke, and completion gates

**Files:**
- Modify: `structure/01_runtime.md`
- Modify: `structure/07_classifier-routing.md`
- Modify: `structure/10_remote-model-catalog.md`
- Modify: `structure/11_model-continuity.md`
- Modify: `docs-site/content/docs/en/reference/configuration.md`
- Modify: `docs-site/content/docs/ko/reference/configuration.md`
- Modify: `docs-site/content/docs/zh-cn/reference/configuration.md`
- Modify: `docs-site/content/docs/en/guides/troubleshooting.md`
- Modify: `docs-site/content/docs/ko/guides/troubleshooting.md`
- Modify: `docs-site/content/docs/zh-cn/guides/troubleshooting.md`
- Modify: `README.md`
- Modify: `README.ko.md`
- Modify: `README.zh-CN.md`
- Test: `tests/model-continuity-e2e.test.ts`

**Interfaces:**
- Consumes: all prior tasks.
- Produces: installed-proxy smoke evidence, public configuration/repair instructions, implemented SOT status.

- [ ] **Step 1: Write the failing end-to-end test**

Use temporary `FROGPROGSY_HOME`, a local mock primary upstream, a local mock fallback upstream, and the real `startServer` path. Freeze the circuit clock through the test seam from Task 4.

Scenarios:

```ts
test("retired and transient model continuity works through API, CLI, and data plane", async () => {
  // 1. Start with primary/old and fallback/new.
  // 2. GET inventory: primary owner is retired.
  // 3. POST set automatic:"retired".
  // 4. /v1/messages requests the old gateway alias; only fallback receives the call.
  // 5. Response metadata still names the requested alias.
  // 6. Change policy to transient, make primary return 503, then fallback 200.
  // 7. Next request inside 30s skips primary.
  // 8. Advance clock past 30s; primary is tried and succeeds.
  // 9. Make primary return 401; fallback receives no call.
  // 10. Run frogp models continuity --json against the live server and compare API enums.
});
```

Also assert the persisted config changes only after explicit `set`/`replace`; automatic requests never change the primary owner.

- [ ] **Step 2: Run the end-to-end test and confirm failure**

```bash
bun test --isolate ./tests/model-continuity-e2e.test.ts
```

Expected: FAIL until all runtime/API/CLI seams work together.

- [ ] **Step 3: Fix only integration defects exposed by the smoke**

Keep fixes within the approved boundaries. Do not add polling, persistent health state, retry-after parsing, helper/mixing automation, or classifier fallback. Add a narrow regression assertion for every integration defect before changing production code.

- [ ] **Step 4: Update the public configuration reference**

Document this exact shape in English, Korean, and Chinese:

```json
{
  "modelContinuity": {
    "anthropic/claude-old": {
      "fallbacks": ["anthropic/claude-new"],
      "automatic": "off"
    }
  }
}
```

State the four modes, maximum three targets, default off, ordinary-route-only automatic boundary, no inferred targets, 30-second memory-only circuit, and classifier manual-only rule.

- [ ] **Step 5: Update troubleshooting and README summaries**

Add one concise workflow to each troubleshooting guide:

```text
frogp models continuity
frogp models continuity set <provider/model> --fallback <provider/model> --auto retired
frogp models continuity replace <reference-id> <provider/model>
```

Add one short paragraph beside the existing remote-model-catalog paragraph in each root README. Keep READMEs at first-success summary level and link to the full CLI/config/dashboard docs.

- [ ] **Step 6: Convert the approved design into implemented SOT**

Update `structure/11_model-continuity.md` status from `Approved design. Not implemented.` to the exact implemented state. Reconcile `structure/01_runtime.md`, `07_classifier-routing.md`, and `10_remote-model-catalog.md` so they state:

- retired managed defaults are diagnosed rather than silently replaced;
- ordinary continuity uses exact opt-in targets;
- classifier remains single-target and continuity-automatic-ineligible; and
- remote catalog retirement is the only lifecycle authority.

Do not describe deferred mixing/helper automation as implemented.

- [ ] **Step 7: Run integrated smoke**

```bash
bun test --isolate ./tests/model-continuity-e2e.test.ts
```

Expected: PASS with primary/fallback call order, 401 stop, circuit expiry, API/CLI parity, and no automatic config mutation proven.

- [ ] **Step 8: Run the project completion gates**

```bash
bun run typecheck
bun test --isolate ./tests
bun run build:gui
```

Expected: all commands exit 0. Record test counts and any warnings exactly. Do not weaken or skip a gate.

- [ ] **Step 9: Review the final diff against the approved objective**

Confirm:

- every changed line supports diagnosis, permanent replacement, ordinary exact fallback, GUI/CLI surfaces, or required docs/tests;
- all call sites of changed exported symbols were migrated;
- no fallback path uses model-name/price/family inference or generic `fallbackProviders` as continuity;
- no automatic classifier, mixing-internal, web-search-helper, or image-helper fallback landed;
- no new dependency, worker, polling loop, persistence file, or raw secret/path/prompt exposure landed;
- direct retired aliases stay hidden from discovery but recognized for 410/explicit fallback;
- automatic requests leave persisted owner settings unchanged.

- [ ] **Step 10: Commit final integration and documentation**

```bash
git add structure/01_runtime.md structure/07_classifier-routing.md structure/10_remote-model-catalog.md structure/11_model-continuity.md docs-site/content/docs/en/reference/configuration.md docs-site/content/docs/ko/reference/configuration.md docs-site/content/docs/zh-cn/reference/configuration.md docs-site/content/docs/en/guides/troubleshooting.md docs-site/content/docs/ko/guides/troubleshooting.md docs-site/content/docs/zh-cn/guides/troubleshooting.md README.md README.ko.md README.zh-CN.md tests/model-continuity-e2e.test.ts
git commit -m "docs: publish model continuity workflow"
```

- [ ] **Step 11: Request final code review before merge**

Review the complete branch against `structure/11_model-continuity.md`. Resolve every verified HIGH/CRITICAL issue, rerun the affected focused test, then rerun all three completion gates. Do not push. Merge to `main` only after the human confirms the final verified branch.

# Model Continuity SOT

> **Status:** Approved design. Not implemented. No runtime, GUI, CLI, or config behavior described below is active until the implementation and verification gates land together.

## Goal

FrogProgsy must tell users when a configured model has been retired and let them replace every active model reference from the dashboard or CLI. Ordinary model requests may use an explicit fallback sequence when the user opts in. FrogProgsy must not infer replacements from model names, prices, families, or provider defaults.

This design separates two conditions:

- **Retired:** the selected managed catalog lists the exact provider/model in `retiredModels`.
- **Transient failure:** an ordinary upstream request fails before FrogProgsy receives a successful response body because of a connection failure, header timeout, HTTP 404/410/429, or HTTP 5xx.

A missing entry in a live provider `/models` response is not retirement evidence. Existing `validated` and `discovered` support labels continue to describe catalog provenance.

## Scope

The continuity inventory reports every model setting that currently affects execution or Claude Code model exposure:

- provider defaults;
- the long-context target;
- featured `subagentModels` entries;
- the auto-mode classifier target;
- model-mixing coordinator, agents, pipeline stages, panel, judge, synthesizer, and rules;
- web-search and image helper targets; and
- configured gateway aliases, including catalog-confirmed retired aliases needed by existing Claude Code sessions.

The inventory excludes model metadata and permission lists such as `disabledModels`, `userModels`, fixed allowlists, capability maps, and wire model ids. It also excludes typed fields that no runtime path reads. The feature must not activate dormant `shadowCompare.secondary` or `searchProviders.*.model` behavior.

All inventoried references support diagnosis and an explicit permanent replacement. Automatic fallback in the first implementation applies only to ordinary routed model requests. It does not apply to:

- the auto-mode classifier, which remains pinned to one explicit target;
- model-mixing internal coordinator, panel, judge, synthesizer, or pipeline calls;
- web-search or image helper calls; or
- `subagentModels` list positions, which control catalog priority but do not identify runtime request provenance.

These excluded execution paths still report retired targets and support permanent replacement.

## Configuration

The optional top-level `modelContinuity` map uses the exact ordinary route target as its key:

```json
{
  "modelContinuity": {
    "anthropic/claude-old": {
      "fallbacks": [
        "anthropic/claude-new",
        "codex/gpt-x"
      ],
      "automatic": "off"
    }
  }
}
```

`automatic` is one of:

- `off`: report failures; never select another model;
- `retired`: use the explicit sequence only when the managed catalog retires the primary target;
- `transient`: use the explicit sequence only after an eligible transient failure; or
- `all`: enable both conditions.

Absent configuration is `off`. A sequence contains at most three exact `provider/model` targets. Validation rejects an unconfigured provider, the primary target itself, duplicates, hidden models, retired fallback targets, and more than three targets. A provider-discovered target is allowed with a warning that the managed catalog has not validated it.

The existing `fallbackProviders` setting remains independent. It never contributes a continuity candidate. The existing effective-config behavior that silently replaces a retired managed provider default with the catalog default must be removed; only the user's continuity sequence may replace a retired target.

## Inventory and permanent replacement

`GET /api/model-continuity` returns a normalized inventory. Each row contains a stable reference id, owner kind, human-facing purpose, current target, retirement and authentication state, automatic-fallback eligibility, and any matching route policy.

Reference ids identify configuration owners for diagnosis and permanent replacement. They are not runtime fallback keys. The runtime cannot always infer whether a direct Claude Code request originated from a provider default, a featured subagent choice, or another setting that names the same model.

A permanent replacement request includes the reference id and the target observed by the caller. The server rejects the write when the current target differs. The server then uses the existing owner-specific validation, config save, and catalog refresh path. It must not perform arbitrary JSON-path mutation.

The dashboard adds one section to the existing Models page. Problems appear first. Each problem states the affected feature, current target, reason, and primary action. Eligible ordinary route targets also expose the ordered fallback sequence and automatic mode. Normal references remain collapsed. No new top-level page, history store, or background worker is added.

The CLI uses the running proxy as the source of truth:

```text
frogp models continuity [--json]
frogp models continuity set <provider/model> --fallback <provider/model>... --auto off|retired|transient|all
frogp models continuity replace <reference-id> <provider/model>
```

Human output states the problem, impact, and next executable command. JSON output uses stable enums shared with the management API.

The management API consists of:

- `GET /api/model-continuity`; and
- `POST /api/model-continuity` with `set` or `replace` actions.

## Retired aliases

The selected managed catalog supplies an immutable retired-target index keyed by configured catalog provider identity. Custom providers are never classified as retired by URL, adapter, model name, or provider name inference.

A catalog-confirmed retired gateway alias becomes a tombstone in the existing alias registry. FrogProgsy omits tombstones from `/v1/models` and the Claude Code picker. The router still recognizes a tombstone from an existing session:

- `off` or `transient` returns a typed HTTP 410 with the continuity action; and
- `retired` or `all` resolves the first valid explicit fallback.

Unknown or fabricated gateway aliases remain typed 404 errors. A tombstone does not make an arbitrary unknown alias routable.

## Ordinary request fallback

The ordinary `/v1/messages` attempt loop remains the only automatic fallback implementation. Existing helpers for same-provider key attempts, immutable request cloning, provider authentication, adapter selection, capability resolution, and request construction are reused.

The continuity implementation adds exact fallback routes after the primary target's allowed key attempts. It never adds `fallbackProviders` candidates. Each fallback attempt rebuilds the routed request from the immutable parsed request so provider- and model-specific authentication, adapter, capability, and wire-model rules apply to the selected target.

Transient fallback is limited to failures known before a successful upstream response body:

- connection failure;
- header timeout;
- HTTP 404 or 410;
- HTTP 429; and
- HTTP 5xx.

HTTP 400/401/402/403, context-limit errors, tool or schema errors, adapter parse errors, SSE error strings inside an HTTP 200 response, and any failure after client-visible text, thinking, or tool output do not trigger continuity fallback. FrogProgsy must not classify a free-form error message by substring.

A single in-memory map records a 30-second open circuit for an exact configured provider/model target. Lookups remove expired entries. A successful primary request clears its entry. No timer, persistence file, manual retry action, or health poller is required.

Claude Code-facing response metadata keeps the requested alias. Existing request-log fields keep the requested and routed targets and per-attempt results. The implementation adds only a structured `continuityReason`; it does not store prompts, responses, credentials, or upstream error bodies.

## Classifier invariant

The reserved auto-mode classifier alias remains pinned to one configured `autoModeClassifier` target. The continuity inventory reports retirement and offers a validated permanent replacement. It rejects automatic fallback for this reference. Generic provider fallback, long-context routing, model mixing, and continuity route fallback cannot replace or intercept the classifier.

This preserves the deterministic, verifiable, and overridable safety boundary in `07_classifier-routing.md`.

## Failure behavior

| Condition | Result |
| --- | --- |
| Primary target is catalog-retired; automatic mode is `off` or `transient` | Return typed 410 and report a replacement action. |
| Primary target is catalog-retired; automatic mode is `retired` or `all` | Select the first valid explicit fallback. |
| Eligible transient failure; automatic mode is `transient` or `all` | Open the primary circuit for 30 seconds and try the next explicit target. |
| Authentication, request, context, tool, schema, parse, or mid-stream failure | Stop; do not send the request to another target. |
| All explicit candidates fail | Return the last safe error response and record structured attempts. |
| A policy target is hidden, retired, unknown, or unavailable | Skip it in runtime resolution and report why it cannot be used. |
| Remote catalog is unavailable | Keep the existing cached/bundled catalog behavior; do not invent retirement. |

Automatic resolution never mutates the persisted primary setting. Only the explicit `replace` action changes the owner setting.

## Verification

The implementation is complete only when it proves these observable contracts:

1. **Inventory**
   - finds every in-scope active reference;
   - distinguishes execution targets, catalog-priority entries, and inactive typed fields; and
   - replaces the correct owner when the same target appears in multiple settings.
2. **Validation**
   - defaults to `off`;
   - preserves exact fallback order;
   - rejects duplicate, hidden, retired, unknown-provider, self, and over-limit candidates; and
   - rejects automatic classifier fallback.
3. **Retirement**
   - removes the managed-default implicit replacement;
   - hides tombstones from discovery while preserving typed 410 handling for existing sessions; and
   - uses an explicit fallback only under `retired` or `all`.
4. **Transient failure**
   - retries only connection/header-timeout and HTTP 404/410/429/5xx failures;
   - stops on HTTP 400/401/402/403 and context errors;
   - never mixes `fallbackProviders` into the continuity sequence; and
   - opens a 30-second circuit, retries the primary after expiry, and clears the circuit on success.
5. **Target reconstruction**
   - rebuilds authentication, adapter, capability, model id, and request body for each target; and
   - keeps the requested alias in Claude Code-facing metadata.
6. **Surfaces**
   - exposes matching management API and CLI JSON enums;
   - shows actionable problem-first GUI copy; and
   - keeps Korean, English, and Chinese message keys aligned.

Required completion commands:

```text
bun run typecheck
bun test --isolate ./tests
bun run build:gui
```

A browser-driven GUI check must exercise the problem card, policy save, and permanent replacement flows. A mock upstream smoke check must prove 404 to explicit fallback, 401 without fallback, and primary retry after the 30-second circuit expires.

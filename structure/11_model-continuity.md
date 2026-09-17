# Model Continuity SOT

> **Status:** Implemented. Runtime, management API, CLI, dashboard, public config, and ordinary data-plane behavior described below are active. Automatic model-mixing, web-search helper, image helper, classifier, and subagent fallback remain intentionally unimplemented.

## Goal

FrogProgsy must tell users when an active configured model needs attention and let them change or remove the exact affected setting from the dashboard or CLI. Saved but inactive settings and past-session aliases remain visible as diagnostics without being presented as required work. Ordinary model requests may use an explicit fallback sequence when the user opts in. FrogProgsy must not infer replacements from model names, prices, families, or provider defaults.

This design separates two conditions:

- **Retired:** the selected managed catalog lists the exact provider/model in `retiredModels`.
- **Transient failure:** an ordinary upstream request fails before FrogProgsy receives a successful response body because of a connection failure, header timeout, HTTP 404/410/429, or HTTP 5xx.

A missing entry in a live provider `/models` response is not retirement evidence. Existing `validated` and `discovered` support labels continue to describe catalog provenance.

## Scope

The continuity inventory reports saved model settings, their current applicability, and configured gateway aliases:

- every provider default, which is always active;
- valid long-context targets and every explicit `subagentModels` entry;
- the auto-mode classifier target, active only when classifier routing is enabled;
- all saved model-mixing coordinator, agent, pipeline, panel, judge, synthesizer, and rule targets, with applicability derived from the enabled combine/mode path;
- web-search and image helper targets, including their runtime default provider/model when omitted, active only when the helper is enabled;
- each saved continuity-policy primary plus each ordered fallback candidate, active only when its automatic mode is not `off`; a faulty candidate is attributed to its own target and exact owner/index instead of making a healthy policy primary look faulty; and
- configured gateway aliases, including catalog-confirmed retired aliases needed by existing Claude Code sessions. Aliases are diagnostic history, not active settings.

The inventory excludes model metadata and permission lists such as `disabledModels`, `userModels`, fixed allowlists, capability maps, and wire model ids. It also excludes typed fields that no runtime path reads. The feature must not activate dormant `shadowCompare.secondary` or `searchProviders.*.model` behavior.

All inventoried references support diagnosis. Each row explicitly carries `active`, `actionRequired`, and `removable`. `actionRequired` is true only when a currently applicable setting is not ready; summary counts distinguish unique affected models from affected setting locations. Invalid enabled targets stay in the report so users can repair or remove them. Hidden active targets still require attention, while hidden inactive targets remain diagnostic.

References with mutable configuration owners support an explicit permanent replacement. Optional owners may instead be removed: singleton blocks are deleted, indexed entries are spliced while preserving explicit empty arrays, helpers are disabled while unrelated helper options remain, and a continuity policy or one exact fallback candidate can be deleted without changing unrelated model settings, the policy mode, or sibling candidates. Required provider defaults must be replaced. Visibility and `subagentModels` priority remain independent settings.

Automatic fallback applies only to ordinary routed model requests. It does not apply to:

- the auto-mode classifier, which remains pinned to one explicit target;
- model-mixing internal coordinator, panel, judge, synthesizer, or pipeline calls;
- web-search or image helper calls; or
- `subagentModels` list positions, which control catalog priority but do not identify runtime request provenance.

These excluded execution paths still report saved targets and support explicit configuration edits.

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

Absent configuration is `off`. A policy is keyed by one exact primary target and contains at most three exact fallback `provider/model` targets. Validation rejects an unconfigured provider, the primary target itself, duplicates, hidden models, retired fallback targets, and more than three fallback targets. A provider-discovered target is allowed with a warning that the managed catalog has not validated it.
Policy validation may report missing authentication, but it does not reject a configured fallback solely from a management-time authentication snapshot: forwarded credentials are request-dependent. Automatic resolution performs normal authentication for each exact candidate and skips a candidate that is unusable for that request.

The existing `fallbackProviders` setting remains independent and never contributes a continuity candidate. Effective configuration keeps a retired managed provider default unchanged so the inventory can diagnose it. Only an explicit `replace` action mutates its owner; an opted-in exact continuity sequence may temporarily route an ordinary request elsewhere.

## Inventory and setting changes

`GET /api/model-continuity` returns a normalized inventory plus `{actionableModelCount,actionableReferenceCount}` summary counts. Each row contains a stable reference id, owner kind, human-facing purpose, current target, retirement and authentication state, `active`, `actionRequired`, `removable`, automatic-fallback eligibility, and any matching route policy. `continuity-policy-candidate` rows additionally carry `policyPrimary` and zero-based `policyFallbackIndex` so clients can edit the owning policy while grouping the warning under the candidate target.

Reference ids identify configuration owners for diagnosis, replacement, or removal. They are not runtime fallback keys. The runtime cannot always infer whether a direct Claude Code request originated from a provider default, a featured subagent choice, or another setting that names the same model.

Replacement and removal requests include the reference id and target observed by the caller. The server rejects a write when the current target differs. It then uses owner-specific validation, config save, and catalog refresh paths; it never performs arbitrary JSON-path mutation.
Owner semantics constrain changes. A provider's `defaultModel` may change only to another model at that same configured provider and cannot be removed; changing the global default provider remains the existing provider-management action. Owners that store both provider and model may replace both fields. A gateway alias has no mutable config owner and never becomes required work merely because its historical target retired.

The dashboard provides one section on the existing Models page. Required work is grouped by target and shows honest model and location counts. Each problem states the exact owner role/index, current target, reason, and a change or removal action. Eligible ordinary route targets also expose the ordered fallback sequence and automatic mode. Diagnostic and ready references remain collapsed. Successful continuity, visibility, and subagent-priority saves reload the report without coupling those settings together; a continuity change reconciles only its exact subagent owner and preserves unrelated unsaved first-shown-order edits. Visibility changes never mutate priority order. A saved priority name that is absent from available candidates remains visible as an unlisted saved reference but is not reintroduced as a selectable model. Absence from this list alone does not establish runtime unavailability; the continuity report separately diagnoses its resolved target.

The CLI uses the running proxy as the source of truth:

```text
frogp models continuity [--json]
frogp models continuity set <provider/model> --fallback <provider/model>... --auto off|retired|transient|all
frogp models continuity replace <reference-id> <provider/model>
frogp models continuity remove <reference-id>
```

Human output groups required work by model, lists affected locations, and prints executable change or removal commands. Inactive and past-session references appear only as diagnostics. JSON output uses stable enums shared with the management API.

The management API consists of:

- `GET /api/model-continuity`; and
- `POST /api/model-continuity` with `set`, `replace`, or `remove` actions.

## Retired aliases

The selected managed catalog supplies an immutable retired-target index keyed by configured catalog provider identity. Custom providers are never classified as retired by URL, adapter, model name, or provider name inference.

A catalog-confirmed retired gateway alias becomes a tombstone in the existing alias registry. FrogProgsy omits tombstones from `/v1/models` and the Claude Code picker. The router still recognizes a tombstone from an existing session:

- `off` or `transient` returns a typed HTTP 410 with the continuity action; and
- `retired` or `all` resolves the first valid explicit fallback.

Unknown or fabricated gateway aliases remain typed 404 errors. A tombstone does not make an arbitrary unknown alias routable.
Startup and runtime rebuilds reconcile tombstone status against the current selected catalog and configured provider identities. An alias entry that is no longer confirmed retired cannot remain authoritative merely because an older registry write marked it retired.
Tombstone aliases are reserved identities. Active alias generation must include those reservations in collision handling so a newly active route can never overwrite or rename an alias held by an existing retired-model session.

## Ordinary request fallback

The ordinary `/v1/messages` attempt loop remains the only automatic fallback implementation. Existing helpers for same-provider key attempts, immutable request cloning, provider authentication, adapter selection, capability resolution, and request construction are reused.

Continuity routes append exact fallback routes after the primary target's allowed key attempts. They never add `fallbackProviders` candidates. Each fallback attempt rebuilds the routed request from the immutable parsed request so provider- and model-specific authentication, adapter, capability, and wire-model rules apply to the selected target.

Transient fallback is limited to failures known before a successful upstream response body:

- connection failure;
- header timeout;
- HTTP 404 or 410;
- HTTP 429; and
- HTTP 5xx.

HTTP 400/401/402/403, context-limit errors, tool or schema errors, adapter parse errors, SSE error strings inside an HTTP 200 response, and any failure after client-visible text, thinking, or tool output do not trigger continuity fallback. For a non-success HTTP response, only an exact structured error `code` or `type` may identify a context-limit error; FrogProgsy must not classify a free-form error message by substring.

A single in-memory map records a 30-second open circuit for an exact configured provider/model target. Lookups remove expired entries. A successful primary request clears its entry. No timer, persistence file, manual retry action, or health poller is required.

Claude Code-facing response metadata keeps the requested alias. Existing request-log fields keep the requested and routed targets and per-attempt results. Request logs add only a structured `continuityReason`; they do not store prompts, responses, credentials, or upstream error bodies.

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

Focused unit, API, CLI, GUI, and end-to-end verification covers these observable contracts:

1. **Inventory**
   - finds every in-scope saved reference and evaluates current applicability;
   - separates required work from inactive and past-session diagnostics with honest model/location counts; and
   - changes or removes the correct owner when the same target appears in multiple settings.
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

A focused end-to-end smoke uses the real `startServer`, local primary and fallback upstreams, a temporary home, and a frozen circuit clock. It proves retired-alias direct fallback, transient 503 fallback, circuit skip and expiry retry, terminal 401 handling, API/CLI parity, requested-alias metadata, and no automatic persisted-owner mutation. Browser-driven GUI verification covers the problem card, policy save, and permanent replacement flows.

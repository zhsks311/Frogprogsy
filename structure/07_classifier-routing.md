# Auto-mode Classifier Routing SOT

This document defines FrogProgsy's Claude Code auto-mode review routing. It is intentionally version-gated to
**Claude Code 2.1.220**. Auto-mode is a safety boundary, so routing must be explicit, deterministic, observable,
and removable.

## Implementation status

Status: **implemented and committed in the same source revision as this document**. Public packaging, installation,
restart, and runtime state are separate release or local-environment facts and are not asserted here.

The previously merged per-home switch remains historical behavior of commit `930ced4`; this source replaces it
with one global switch.

The current behavior is:

- The user configures one explicit `autoModeClassifier` provider/model pair and one
  `autoModeClassifierEnabled` switch. The target may remain saved while the switch is off.
- Turning the switch on applies the reserved reviewer alias to every managed Claude Code home and every enrolled
  project. Turning it off restores the exact pre-injection value everywhere.
- Claude Code 2.1.220 sends both internal auto-mode review stages (`xml_s1` and `xml_s2`) with the exact reserved
  alias `claude-frogp-auto-classifier`. That alias is the only classifier identity FrogProgsy recognizes.
- In the verified dangerous-command scenario, the observed upstream sequence was
  `main model → reviewer → reviewer → main model`: the first and last calls belong to the normal main-model work
  loop, while the two middle calls are Claude Code's separate review stages. FrogProgsy does not create them.
- The reserved alias is pinned to the single configured target. Ordinary provider fallback, model-continuity
  automatic fallback, long-context routing, and model mixing cannot replace or intercept that reviewer. Multiple
  keys for the selected provider may be retried, but another provider/model is never substituted.
- Management writes fail closed. Incomplete, unknown, or disabled targets are rejected. Deleting, overwriting, or
  disabling the saved target is blocked. Static-catalog targets are also checked before server listen when review
  routing is enabled.
- A global switch transition updates all applied homes and enrolled projects before persisting the new setting. If
  one update fails, only files already changed by that transition are rolled back and the stored switch is left
  unchanged.
- Profile deletion removes only that profile's routing header from enrolled projects. When global review remains
  enabled, the reserved reviewer alias remains on those projects.
- Generated gateway aliases and model-mixing aliases cannot claim the reserved classifier id.
- Because Claude Code uses `ANTHROPIC_DEFAULT_SONNET_MODEL` for both auto-mode review and its built-in `sonnet`
  shortcut, a globally enabled session must switch its main model using an exact gateway catalog entry rather than
  `/model sonnet`.

## Verified client behavior

A local capture ran the installed Claude Code 2.1.220 binary against a loopback Anthropic Messages server in
`--permission-mode auto`. The main model was an exact FrogProgsy Codex gateway alias and the mocked action was
an unrequested `curl ... | sh` command.

Observed facts:

- Without an override, both auto-mode XML review stages use `claude-sonnet-5`.
- With `ANTHROPIC_DEFAULT_SONNET_MODEL=claude-frogp-auto-classifier`, both `xml_s1` and `xml_s2` use that exact
  reserved alias. The main request remains on its exact gateway model.
- The HTTP request body has no trustworthy `auto_mode` marker. FrogProgsy cannot safely identify review calls
  from body metadata, prompt text, stream shape, or a Sonnet/Haiku model name.
- A 404 from the reserved alias makes Claude Code fall back to the current main model. A 429 is retried by the
  client before the same main-model fallback. This is Claude Code behavior; it is not FrogProgsy provider
  fallback.
- `ANTHROPIC_DEFAULT_SONNET_MODEL` also controls Claude Code's built-in `sonnet` shortcut. While global review
  routing is enabled, main-model switches must use an exact gateway catalog model, not the built-in shortcut.
  Capturing an exact Anthropic gateway model confirmed that the main request stayed on that model while both review
  stages still used the reserved alias.
- Claude Code checks remote `tengu_auto_mode_config.modelByMainModel` / `model` before its local default-model
  logic. The environment override is therefore a verified 2.1.220 mechanism, not a universal guarantee against
  a future or remotely supplied client override.

The local capture files live under ignored `artifacts/`; they are evidence, not committed product state.

## Config shape

```ts
interface FrogConfig {
  autoModeClassifierEnabled?: boolean;
  autoModeClassifier?: {
    provider: string;
    model: string;
  };
}
```

There is one global switch and one review target. `ClaudeProfileRecord` has no classifier-routing flag. The retired
`classifierFallback`, provider-level `classifierModel`, and per-profile `routeAutoModeClassifier` fields are not
part of this contract. Startup removes the retired per-profile field without silently enabling the global switch.
The model-continuity inventory diagnoses and can permanently replace this owner, but marks it automatic-ineligible.
There is no ordered runtime classifier fallback.

## Routing contract

The reserved model id is exactly:

```text
claude-frogp-auto-classifier
```

`src/router.ts` handles it before ordinary gateway aliases:

1. Require `autoModeClassifierEnabled === true`.
2. Resolve the single configured `autoModeClassifier` target.
3. Reject an absent/incomplete target, missing provider, or disabled target.
4. Return `routeKind: "classifier"` and `classifierRoute: true`.
5. Protect that route from long-context routing and model mixing.
6. Build only the selected provider's key attempts. Never append `fallbackProviders` or `modelContinuity` targets.

No other id is inferred to be a classifier. In particular, ordinary Sonnet, Haiku, Opus, and default-provider
requests follow normal routing. Request prompt inspection and model-name guessing are prohibited.

## Global Claude Code enablement

Saving `autoModeClassifier` alone does not change Claude Code. Setting `autoModeClassifierEnabled: true` applies
one routing decision to every managed Claude Code home and every enrolled project:

```text
ANTHROPIC_DEFAULT_SONNET_MODEL=claude-frogp-auto-classifier
```

The key is applied consistently by settings injection, launcher environment construction, server start/refresh,
and project enrollment. Turning the global switch off restores the exact pre-injection value from each settings
backup. Native launch/restore removes only FrogProgsy's reserved value and preserves unrelated user values.

The management update is all-or-rollback across the files it changes. The new config is persisted only after every
home and project update succeeds. A failed update rolls back only the preceding successful writes; it does not
attempt to "roll back" a path that was never changed.

Because the value is process environment, changing the global switch does not mutate an already running Claude
Code process. Restart or resume the session after changing it.

## Main-model switching

Global review routing is compatible with changing the main model in the same Claude Code conversation only when
the new main model is selected by its exact FrogProgsy gateway catalog entry. For example, switching from an exact
Codex entry to an exact Anthropic provider/model entry keeps the main request on Anthropic and the review stages
on the reserved alias.

Do not use Claude Code's built-in `sonnet` shortcut while global review routing is enabled: the client resolves
that shortcut through the same environment variable and would select the reserved reviewer alias as the main
model. FrogProgsy must not guess whether such a request is a main request or a review request.

## Management validation

`GET /api/classifier-settings` returns `autoModeClassifierEnabled`, the one target, and visible provider/model
options.

`PUT /api/classifier-settings` accepts only both fields together:

```json
{
  "autoModeClassifierEnabled": true,
  "autoModeClassifier": {
    "provider": "codex",
    "model": "gpt-5.4-mini"
  }
}
```

`autoModeClassifier: null` is accepted only with `autoModeClassifierEnabled: false`; it disables review routing
and clears the target. Saving is rejected when provider/model is incomplete, the provider is missing, the model is
disabled, or a non-empty known catalog does not contain the model.

Provider deletion/overwrite and `disabledModels` updates are rejected when they would invalidate the saved target.

Changing the global switch immediately updates every managed home and enrolled project. If enabling the switch
temporarily injects gateway settings into a profile currently marked as Claude-direct, disabling it restores that
profile's full pre-toggle settings; already-injected homes and enrolled projects keep their gateway settings and
only remove the reserved alias. A transition is rejected before writing when Claude Code settings writes are
blocked. Partial failures restore the exact pre-update settings and backup file bytes and leave the persisted
switch unchanged. Startup rejects structurally invalid/disabled targets and unknown
targets for static provider catalogs when the global switch is enabled. Live-catalog targets are validated when
saved because startup does not perform a network catalog refresh.

## Verification gates

Automated tests cover:

- exact reserved-alias routing and all fail-closed target states;
- absence of Sonnet/Haiku prompt/model-name inference;
- no generic provider fallback, continuity automatic fallback, long-context override, or model mixing;
- global home/project injection, exact backup restore, native-env cleanup, and partial-update rollback;
- strict management payload validation, saved-target protection, retired per-profile field removal, and profile
  deletion while global review remains enabled.

Before changing this mechanism for a new Claude Code release, repeat the loopback capture and verify:

1. both review stages use the reserved alias;
2. an exact GPT main model remains GPT;
3. an exact Anthropic main-model switch remains Anthropic;
4. 404 and 429 behavior is recorded;
5. the built-in `sonnet` shortcut caveat still holds.

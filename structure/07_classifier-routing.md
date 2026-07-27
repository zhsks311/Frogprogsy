# Auto-mode Classifier Routing SOT

This document defines FrogProgsy's Claude Code auto-mode review routing. It is intentionally version-gated to
**Claude Code 2.1.220**. Auto-mode is a safety boundary, so routing must be explicit, deterministic, observable,
and removable.

## Implementation status — 2026-07-24

Status: **implemented, verified, and merged to `main` in commit `930ced4`**. This records the source
contract; it does not mean that any particular locally installed `frogp` package has already been rebuilt,
installed, or restarted.

The shipped behavior is:

- The user configures one explicit `autoModeClassifier` provider/model pair, then enables review routing
  separately for each managed Claude Code home with `routeAutoModeClassifier:true`. Configuring a target alone
  does not alter Claude Code.
- An opted-in home makes Claude Code 2.1.220 send both internal auto-mode review stages (`xml_s1` and `xml_s2`)
  with the exact reserved alias `claude-frogp-auto-classifier`. That alias is the only classifier identity
  FrogProgsy recognizes.
- In the verified dangerous-command scenario, the observed upstream sequence was
  `main model → reviewer → reviewer → main model`: the first and last calls belong to the normal main-model
  work loop, while the two middle calls are Claude Code's separate review stages. FrogProgsy does not create
  the two review calls.
- The reserved alias is pinned to the single configured target. Ordinary provider fallback, long-context
  routing, and model mixing cannot replace or intercept that reviewer. Multiple keys for the selected provider
  may be retried, but another provider/model is never substituted.
- Management writes fail closed: incomplete, unknown, or disabled targets are rejected; deleting, overwriting,
  or disabling the configured target is blocked; static-catalog targets are also checked before server listen.
- Profile opt-out and profile deletion remove FrogProgsy's reserved Sonnet override from the Claude Code home
  and its enrolled projects. The exact user-owned `ANTHROPIC_DEFAULT_SONNET_MODEL` value is backed up, refreshed
  when the user changes it, and restored instead of being discarded.
- Generated gateway aliases and model-mixing aliases cannot claim the reserved classifier id.
- Because Claude Code uses `ANTHROPIC_DEFAULT_SONNET_MODEL` for both auto-mode review and its built-in `sonnet`
  shortcut, an opted-in session must switch its main model using an exact gateway catalog entry rather than
  `/model sonnet`.

Landing verification for `930ced4`:

- real Claude Code 2.1.220 loopback E2E: `main-model → review-model → review-model → main-model`;
- `bun run typecheck`: passed;
- `bun test --isolate ./tests`: 1,385 passed, 1 skipped, 0 failed;
- `bun run build:gui`: passed.

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
- `ANTHROPIC_DEFAULT_SONNET_MODEL` also controls Claude Code's built-in `sonnet` shortcut. While profile routing
  is enabled, main-model switches must use an exact gateway catalog model, not the built-in shortcut. Capturing
  an exact Anthropic gateway model confirmed that the main request stayed on that model while both review stages
  still used the reserved alias.
- Claude Code checks remote `tengu_auto_mode_config.modelByMainModel` / `model` before its local default-model
  logic. The environment override is therefore a verified 2.1.220 mechanism, not a universal guarantee against
  a future or remotely supplied client override.

The local capture files live under ignored `artifacts/`; they are evidence, not committed product state.

## Config shape

```ts
interface FrogConfig {
  autoModeClassifier?: {
    provider: string;
    model: string;
  };
}

interface ClaudeProfileRecord {
  routeAutoModeClassifier?: boolean;
}
```

There is one review target. The retired `classifierFallback` and provider-level `classifierModel` fields are not
part of this contract. There is no ordered runtime classifier fallback.

## Routing contract

The reserved model id is exactly:

```text
claude-frogp-auto-classifier
```

`src/router.ts` handles it before ordinary gateway aliases:

1. Resolve the single configured `autoModeClassifier` target.
2. Reject an absent/incomplete target, missing provider, or disabled target.
3. Return `routeKind: "classifier"` and `classifierRoute: true`.
4. Protect that route from long-context routing and model mixing.
5. Build only the selected provider's key attempts. Never append `fallbackProviders`.

No other id is inferred to be a classifier. In particular, ordinary Sonnet, Haiku, Opus, and default-provider
requests follow normal routing. Request prompt inspection and model-name guessing are prohibited.

## Claude Code home opt-in

Saving `autoModeClassifier` alone does not change Claude Code. Each managed Claude Code home must explicitly set
`routeAutoModeClassifier: true`.

For an opted-in home, FrogProgsy owns and injects:

```text
ANTHROPIC_DEFAULT_SONNET_MODEL=claude-frogp-auto-classifier
```

The key is applied consistently by settings injection, launcher environment construction, server start/refresh,
and project enrollment that names the profile. Turning the flag off restores the exact pre-injection value from
the settings backup. Deleting an opted-in profile also removes the reserved alias from enrolled projects before
their routing metadata is cleared. Native launch/restore removes only FrogProgsy's reserved value and preserves
unrelated user values.

Because the value is process environment, changing the profile does not mutate an already running Claude Code
process. Restart or resume the session after changing it.

## Main-model switching

The opt-in is compatible with changing the main model in the same Claude Code conversation only when the new
main model is selected by its exact FrogProgsy gateway catalog entry. For example, switching from an exact Codex
entry to an exact Anthropic provider/model entry keeps the main request on Anthropic and the review stages on the
reserved alias.

Do not use Claude Code's built-in `sonnet` shortcut while the opt-in is enabled: the client resolves that shortcut
through the same environment variable and would select the reserved reviewer alias as the main model. FrogProgsy
must not guess whether such a request is a main request or a review request.

## Management validation

`GET /api/classifier-settings` returns the one target plus visible provider/model options.

`PUT /api/classifier-settings` accepts only:

```json
{
  "autoModeClassifier": {
    "provider": "codex",
    "model": "gpt-5.4-mini"
  }
}
```

`null` clears the target. Save is rejected when provider/model is incomplete, the provider is missing, the model
is disabled, or a non-empty known catalog does not contain the model. Clearing is rejected while any Claude Code
home has review routing enabled.

Provider deletion/overwrite and `disabledModels` updates are rejected when they would invalidate the configured target.

Enabling a profile is rejected unless the target is valid. Applied home/project settings are updated immediately;
failures are surfaced instead of leaving the stored flag and injected environment out of sync. Startup rejects
structurally invalid/disabled targets and unknown targets for static provider catalogs. Live-catalog targets are
validated when saved because startup does not perform a network catalog refresh.

## Verification gates

Automated tests cover:

- exact reserved-alias routing and all fail-closed target states;
- absence of Sonnet/Haiku prompt/model-name inference;
- no generic provider fallback, long-context override, or model mixing;
- profile/home/project injection, exact backup restore, and native-env cleanup;
- management save/delete validation and profile lifecycle reapplication.

Before changing this mechanism for a new Claude Code release, repeat the loopback capture and verify:

1. both review stages use the reserved alias;
2. an exact GPT main model remains GPT;
3. an exact Anthropic main-model switch remains Anthropic;
4. 404 and 429 behavior is recorded;
5. the built-in `sonnet` shortcut caveat still holds.

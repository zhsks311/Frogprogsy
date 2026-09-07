# Changelog

## Unreleased

### Added

- Label-driven release automation now prepares and cancels versions, publishes previews from accepted `develop` merge SHAs, and publishes stable releases from accepted `develop` to `main` merge SHAs after channel-specific exact-SHA gates.
- Maintainers can promote only the current exactly reconciled preview and recover partial publication only for the original prepared SHA without reusing a consumed version.
- Bun-global stable installs now detect npm `latest` after startup without blocking the proxy, expose one cached update status across CLI/API/dashboard, and keep installation, restart, Claude state, credentials, and telemetry under explicit user control.
- The Activity dashboard now shows a provenance-aware, coverage-labelled prompt-cache hit rate from Anthropic's separate read/creation/plain-input buckets and native OpenAI Chat/Responses cached-token details without double-counting OpenAI's inclusive input total, while separating failed requests from missing or unsupported cache usage.
- The model catalog now includes Codex GPT-6 Astra, API-key GPT-6 Astra and GPT-5.6 Sol/Terra/Luna, and Claude Fable 5.1 with route-specific limits. Codex GPT-5.4 and GPT-5.4-mini move to the retired list; existing defaults remain unchanged.

### Changed

- Normal npm releases now use tokenless Trusted Publishing. A short-lived bootstrap token remains limited to the first package publish, and optional `preview` dist-tag removal remains a manual maintainer action.
- A fake-upstream end-to-end test now locks OpenCode Zen's provider-discovered `x-preview-f-free` route as Discovered rather than Validated; real-provider validation still requires PR #55 and a dedicated bounded-spend Zen credential.

### Fixed

- Prepare release recovery now reuses or dispatches each missing exact-head CI and Package lifecycle run even when no new preparation commit was pushed, and rejects invalid run IDs before binding.
- OpenAI Chat routes now fail closed on truncated or stalled streams, preserve max-token and retry metadata, and keep parallel tool calls and failed tool results distinct in Claude Messages. Codex Responses streams now count lifecycle and keepalive frames as activity and preserve terminal frames without a trailing newline.
- Claude Fable 5.1 requests now use adaptive-thinking effort and supported tool choices, while API-key GPT-6 Astra requests omit unsupported sampling parameters. These two models require a 0.0.7 or newer client; catalog-only updates do not enable them on older installations.

## 0.0.3

### Added

- FrogProgsy now checks for validated model updates when the proxy starts. If the check fails, startup compares the last validated saved copy with the complete model data bundled in the installed release and uses the one with the higher catalog revision.
- `frogp models` now identifies catalog-validated and provider- or user-discovered models and shows whether the active model data is remote, saved, or bundled.
- Model continuity now diagnoses retired models in the CLI and Models dashboard, permanently replaces model references whose saved setting can be changed, and lets ordinary routes opt in to up to three exact fallbacks. Automatic fallback remains off by default; the auto-mode classifier stays on one configured target and supports manual replacement only.

### Changed

- Model updates take effect on the next proxy restart. API keys, the selected default, disabled models, and models added by the user remain unchanged.

### Fixed

- GitHub Pages, documentation, and remote model catalog URLs now use the repository's canonical case-sensitive path.

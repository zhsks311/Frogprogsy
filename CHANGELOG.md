# Changelog

## Unreleased

### Added

- Label-driven release automation now prepares and cancels versions, publishes previews from accepted `develop` merge SHAs, and publishes stable releases from accepted `develop` to `main` merge SHAs after channel-specific exact-SHA gates.
- Maintainers can promote only the current exactly reconciled preview and recover partial publication only for the original prepared SHA without reusing a consumed version.

### Changed

- Normal npm releases now use tokenless Trusted Publishing. A short-lived bootstrap token remains limited to the first package publish, and optional `preview` dist-tag removal remains a manual maintainer action.

### Fixed

- Release preparation can now push GitHub-verified version commits with a repository Deploy Key while retaining exact-head and fast-forward race protection.

## 0.0.3

### Added

- FrogProgsy now checks for validated model updates when the proxy starts. If the check fails, startup compares the last validated saved copy with the complete model data bundled in the installed release and uses the one with the higher catalog revision.
- `frogp models` now identifies catalog-validated and provider- or user-discovered models and shows whether the active model data is remote, saved, or bundled.
- Model continuity now diagnoses retired models in the CLI and Models dashboard, permanently replaces model references whose saved setting can be changed, and lets ordinary routes opt in to up to three exact fallbacks. Automatic fallback remains off by default; the auto-mode classifier stays on one configured target and supports manual replacement only.

### Changed

- Model updates take effect on the next proxy restart. API keys, the selected default, disabled models, and models added by the user remain unchanged.

### Fixed

- GitHub Pages, documentation, and remote model catalog URLs now use the repository's canonical case-sensitive path.

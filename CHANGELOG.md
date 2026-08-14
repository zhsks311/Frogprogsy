# Changelog

## Unreleased

## 0.0.3

### Added

- FrogProgsy now checks for validated model updates when the proxy starts. If the check fails, startup compares the last validated saved copy with the complete model data bundled in the installed release and uses the one with the higher catalog revision.
- `frogp models` now identifies catalog-validated and provider- or user-discovered models and shows whether the active model data is remote, saved, or bundled.
- Model continuity now diagnoses retired models in the CLI and Models dashboard, permanently replaces model references whose saved setting can be changed, and lets ordinary routes opt in to up to three exact fallbacks. Automatic fallback remains off by default; the auto-mode classifier stays on one configured target and supports manual replacement only.

### Changed

- Model updates take effect on the next proxy restart. API keys, the selected default, disabled models, and models added by the user remain unchanged.

### Fixed

- GitHub Pages, documentation, and remote model catalog URLs now use the repository's canonical case-sensitive path.

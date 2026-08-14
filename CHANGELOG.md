# Changelog

## Unreleased

### Added

- FrogProgsy now checks for validated model updates when the proxy starts. If the check fails, startup compares the last validated saved copy with the complete model data bundled in the installed release and uses the one with the higher catalog revision.
- `frogp models` now identifies catalog-validated and provider- or user-discovered models and shows whether the active model data is remote, saved, or bundled.

### Changed

- Model updates take effect on the next proxy restart. API keys, the selected default, disabled models, and models added by the user remain unchanged.

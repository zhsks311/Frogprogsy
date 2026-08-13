# Changelog

## Unreleased

### Added

- FrogProgsy now checks for validated model updates when the proxy starts. If the check fails, startup continues with the last valid saved copy or the complete model list bundled with the installed release.
- `frogp models` now identifies catalog-validated and provider- or user-discovered models and shows whether the active model data is remote, saved, or bundled.

### Changed

- Model updates take effect on the next proxy restart. API keys, the selected default, disabled models, and models added by the user remain unchanged.

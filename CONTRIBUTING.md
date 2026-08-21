# Contributing

Create ordinary changes from `develop` on a short-lived branch and open a reviewed pull request back to `develop`. Do not change `package.json.version` by hand. A maintainer assigns exactly one release selection label; ordinary work uses `release:none`.

Preview labels apply only to same-repository pull requests targeting `develop`. Stable and promotion labels apply only to the `develop` to `main` promotion pull request. Release automation may add a verified version commit and the `release:ready` label, but it never approves or merges a pull request. Review the new exact head and use a merge commit; squash and rebase merges cannot carry the required release history.

Maintainers must follow the complete [label-driven release procedure](structure/06_docs-and-release.md#release-strategy), including cancellation, exact-SHA gates, publication, and recovery.

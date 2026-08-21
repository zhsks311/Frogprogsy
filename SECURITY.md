# Security Policy

## Release automation boundary

The write-capable `Prepare release` workflow runs on `pull_request_target`, but executes only trusted workflow and release-policy code from the default branch. It must never check out, install, build, or execute pull-request code. Pull-request tests and builds run in separate workflows with read-only contents permission.

Normal npm publication uses tokenless Trusted Publishing after exact-SHA gates pass. The short-lived `NPM_BOOTSTRAP_TOKEN` is allowed only for the first package publish and must be revoked and deleted immediately afterward. Do not add a long-lived package-write token for normal publishing or npm `preview` dist-tag cleanup.

Treat any way to bypass release selection, preparation records, required checks, immutable version checks, provenance checks, or the trusted-workflow boundary as a security issue. Do not reproduce it against npm or other external systems. Provide the affected workflow, commit SHA, and a minimal local reproduction privately to the maintainers.

See the [maintainer release procedure](structure/06_docs-and-release.md#security-boundary) for permissions, rulesets, and recovery constraints.

# Label-driven release automation design

**Status:** Approved on 2026-08-13

## Goal

Let maintainers choose a stable or preview release with one pull-request label. Automation prepares the version, validates the exact commit, and publishes after a maintainer merges the pull request.

The release model has three independent paths:

1. Publish the next patch, minor, or major stable version without a preview.
2. Publish one or more preview candidates from `develop`.
3. Promote the current preview candidate to a stable version.

A preview is optional. Maintainers can abandon an active preview and choose another preview target or a direct stable release.

## Non-goals

- Automatic pull-request merge
- Publishing unmerged task-branch commits
- Publishing a preview catalog to the stable GitHub Pages URL
- Inferring SemVer intent from commit messages or changed files
- Reusing, overwriting, or deleting published package versions
- Running pull-request code with a write-capable `pull_request_target` token

## Release state

- `main` and npm `latest` define the stable baseline.
- `develop` contains the next release contents.
- npm `preview` points to the active public preview candidate.
- Published preview versions remain immutable after the npm `preview` dist-tag moves or is removed.
- A successful stable release reports whether npm `preview` still exists and prints the manual removal command.

New preparation stops if the version recorded on `main` and npm `latest` disagree. An explicit recovery
dispatch may still complete missing publication steps for an existing prepared SHA.

## Labels

| Label | Valid pull request | Result |
| --- | --- | --- |
| `release:none` | Any supported release PR | Do not prepare or publish a release. |
| `release:patch` | `develop` to `main` | Prepare the next patch stable version. |
| `release:minor` | `develop` to `main` | Prepare the next minor stable version. |
| `release:major` | `develop` to `main` | Prepare the next major stable version. |
| `release:preview-patch` | Same-repository branch to `develop` | Start or continue a patch preview. |
| `release:preview-minor` | Same-repository branch to `develop` | Start or continue a minor preview. |
| `release:preview-major` | Same-repository branch to `develop` | Start or continue a major preview. |
| `release:promote` | `develop` to `main` | Remove the prerelease suffix from the active preview. |
| `release:ready` | Automation only | Mark the current PR head as release-ready. |

Exactly one selection label may be active. Automation owns `release:ready`; a label added by a person does not bypass the release-state check.

At most one open pull request in the repository may carry a selection other than `release:none`.
Repository-wide reconciliation is serialized. A second selected PR fails release-state until the first
selection is merged, cancelled, or removed. Immediately before adding `release:ready`, automation reloads
all open PRs and confirms that the current PR still owns the sole preparation slot.

## Version calculation

Assume `main` and npm `latest` are `1.2.3`.

| Selection | Prepared version |
| --- | --- |
| `release:patch` | `1.2.4` |
| `release:minor` | `1.3.0` |
| `release:major` | `2.0.0` |
| `release:preview-patch` | `1.2.4-preview.1` |
| `release:preview-minor` | `1.3.0-preview.1` |
| `release:preview-major` | `2.0.0-preview.1` |

For each preview target, automation reads npm versions, immutable Git tags, and GitHub Releases, then chooses
the smallest positive `preview.N` absent from all three stores. `preview.1` is valid only when that target has
no consumed candidate. Consistent partial metadata is reconciled at the same version instead of consuming a
new number.

A reconciliation rerun preserves an unpublished prepared version when its preparation evidence still matches
the pull request, selection, base SHA, source head, stable baseline, and target. A label or source change
invalidates that evidence before automation calculates another candidate.

A different preview label selects a new stable target and its first unused `preview.N`. The npm `preview`
dist-tag moves only after publication succeeds; older preview versions remain installable by exact version.

A direct stable label may replace an active preview. It calculates the stable target from `main` and npm
`latest`, not from the abandoned prerelease version.

A new stable target must be absent from npm versions, immutable Git tags, and GitHub Releases. Existing
metadata permits only explicit recovery for the same prepared SHA; otherwise automation blocks before
writing a version commit.

`release:promote` never calculates a new SemVer target. It changes `X.Y.Z-preview.N` to `X.Y.Z` only after
the registry package, npm `preview` dist-tag, immutable Git tag, and GitHub Prerelease agree on the candidate.

## Stable release without preview

1. A maintainer applies `release:patch`, `release:minor`, or `release:major` to the `develop` to `main` pull request.
2. Trusted automation recalculates the target from `main` and npm `latest`.
3. Automation changes only the allowlisted version file on `develop`, pushes a preparation commit through the GitHub Actions ruleset bypass, and invalidates stale preparation evidence.
4. Read-only pull-request workflows test the new exact head.
5. The required release-state check passes and automation adds `release:ready`.
6. A maintainer merges the pull request with a merge commit.
7. Main-branch workflows validate that merge SHA, build the package, and deploy the Pages catalog.
8. The release workflow requires successful exact-SHA Cross-platform CI, Package lifecycle, and Pages results.
9. The workflow publishes npm `latest`, creates the immutable Git tag and GitHub Release, and runs registry
   smoke checks. If npm `preview` exists, it prints `npm dist-tag rm frogprogsy preview` for a maintainer.

## Preview release from develop

1. A maintainer applies one `release:preview-*` label to a same-repository pull request targeting `develop`.
2. Trusted automation calculates the candidate from the stable baseline and registry state.
3. Automation updates only the allowlisted version file on the pull request's source branch. It never writes to a fork.
4. Read-only pull-request workflows test the new exact head.
5. The release-state check passes and automation adds `release:ready`.
6. A maintainer merges the pull request into `develop` with a merge commit that has exactly two parents.
7. Develop-branch workflows require successful exact-SHA Cross-platform CI and Package lifecycle results,
   build one tarball, and validate its bundled model catalog schema, digest, revision, and source SHA.
8. The release workflow publishes that exact merge SHA to npm with dist-tag `preview`, creates an immutable
   Git tag and GitHub Prerelease, and runs registry smoke checks.

Preview publication never waits for Pages and does not update the stable GitHub Pages catalog. The runtime
keeps the newer bundled catalog when the stable remote catalog has an older revision.

## Publication gates by channel

| Channel | Source | Required gates |
| --- | --- | --- |
| `preview` | Current `develop` merge SHA | Cross-platform CI, Package lifecycle, one exact-SHA tarball, and bundled catalog schema/digest/revision/source-SHA validation. Pages is neither expected nor accepted as a substitute. |
| `latest` | Current `main` promotion merge SHA | Cross-platform CI, Package lifecycle, Pages deployment, one exact-SHA tarball, and package-to-Pages catalog source-SHA/revision/digest equality. |

For automatic publication, the workflow binds `expected-sha` to the triggering push event's `after` SHA and
requires that commit to contain valid merge and preparation evidence for the selected channel. A later branch
update does not invalidate or cancel the accepted immutable SHA. Manual recovery may target an older prepared
SHA only through the explicit recovery path.

Push-triggered CI and Package lifecycle concurrency is keyed by commit SHA, not branch, so a later
`develop` push cannot cancel a selected preview SHA. Publication is never cancelled in progress. Every
gate evaluates only the newest run attempt for its workflow and SHA; missing, queued, in-progress,
cancelled, failed, or superseded latest attempts fail closed.

## Preview promotion

1. The registry package, npm `preview` dist-tag, immutable preview tag, and GitHub Prerelease must identify
   one version and one preview source SHA.
2. Before preparation, the current `develop` HEAD must equal that preview source SHA exactly. Any intervening
   commit, including documentation, requires another preview or a direct stable selection.
3. A maintainer applies `release:promote` to the `develop` to `main` pull request.
4. Automation changes only `package.json.version` from `X.Y.Z-preview.N` to `X.Y.Z`, pushes the stable
   preparation commit to `develop`, and reruns exact-head checks.
5. The release-state check passes and automation adds `release:ready`.
6. A maintainer merges the pull request with a merge commit.
7. Main-branch workflows build, test, and deploy the Pages catalog for that merge SHA.
8. The release workflow publishes `X.Y.Z` to npm `latest`, creates the stable tag and GitHub Release, and
   runs registry smoke checks. If npm `preview` still exists, a maintainer removes it with the printed
   `npm dist-tag rm frogprogsy preview` command and npm authentication with 2FA.

Any commit after preview publication requires another preview before `release:promote` can pass. A maintainer
may instead choose a direct stable label, which explicitly abandons the preview path.

## Reconciliation

The prepare workflow reruns when a pull request opens, reopens, synchronizes, changes base, or changes release
labels. It also supports a manual recovery dispatch. Reconciliation runs are serialized across the repository
and are not cancelled in progress.

Preparation changes only the `version` field in `package.json`. A trusted artifact binds the proposed patch to:

- repository and pull-request number;
- selection label;
- base branch and base SHA;
- source branch and pre-preparation head SHA;
- current `main` SHA;
- stable baseline;
- target version;
- exact patch digest and `package.json` path.

The preparation commit records the target, PR, selection, stable baseline, and relevant SHAs in machine-readable
Git trailers. A preparation has one of three states:

- `pending`: the latest uncancelled preparation owned by the current PR and not yet merged;
- `cancelled`: a later cancellation trailer names and reverses that preparation;
- `merged/reconciled`: the preparation entered its target branch and publication either completed or remains
  eligible for explicit same-SHA recovery.

Cancellation considers only the current PR's pending preparation. It never reverses a preparation inherited
from an ancestor or already merged for another PR. The merged Git history, not mutable post-merge labels or
expiring artifacts, is the publication authority.

Before a push or `release:ready` change, automation reloads the PR, sole-slot ownership, and every bound field.
It accepts only the expected `package.json.version` change, pushes one fast-forward update, and leaves tests
to read-only workflows.

A changed head, label, base, stable baseline, or registry state removes `release:ready`. If the current PR
owns a pending preparation, automation first adds a cancellation commit that restores its prior version. It
may add a new preparation in the same fast-forward update. `release:none` or label removal cannot pass
release-state while that PR still owns a pending preparation.

After merge, the publisher examines only the source-side range `<merge>^1..<merge>^2`, requires a preparation
for the merged PR with no later cancellation in that range, and verifies the prepared version and exact-SHA
checks. It never derives the release channel or version from labels that can change after merge.

## Partial release recovery

New preparation stops when `main`'s `package.json.version`, npm `latest`, or that stable version's immutable
Git tag and GitHub Release disagree. A prerelease version on `develop` is not a stable-baseline mismatch.
Recovery for an already prepared SHA remains available through an explicit workflow dispatch:

| Observed state | Recovery |
| --- | --- |
| npm version, Git tag, and GitHub Release all absent | Rerun the exact prepared SHA and version. |
| npm version present with matching provenance; tag or GitHub Release absent | Do not republish. Create the missing metadata at the same SHA, rerun registry smoke, and reconcile dist-tags. |
| npm version absent; tag or GitHub Release already exists | Block same-version publication because no durable package digest exists. Keep immutable metadata and fix forward with a new version. |
| Stable publish succeeded but `preview` dist-tag remains | A maintainer runs the reported `npm dist-tag rm frogprogsy preview` command with npm authentication and 2FA, then records the resulting dist-tags. |
| Any store maps the version to another SHA, channel, or package digest | Block automation. A maintainer must repair mutable metadata without moving immutable objects or choose a new version and fix forward. |

Promotion recovery requires the registry version, npm `preview` dist-tag, Git tag, and GitHub Prerelease to
converge on the same preview version and source SHA. A consumed npm version is never reused for different
content.

## npm preview dist-tag cleanup

Normal publication remains tokenless. npm Trusted Publishing authorizes `npm publish` and `npm stage publish`,
not `npm dist-tag rm`. The workflow must not add a long-lived package-write token solely for cleanup. After
a stable release, it reports the current dist-tags and the exact manual removal command. See
[npm Trusted Publishing](https://docs.npmjs.com/trusted-publishers/) and
[`npm dist-tag`](https://docs.npmjs.com/cli/v11/commands/npm-dist-tag/).

## Security boundary

The write-capable workflow uses `pull_request_target`, but it executes only workflow and release-planning
code from the trusted default branch. It does not install dependencies, build, or run source from the pull
request.

Tests and builds run in ordinary `pull_request` and `push` workflows with read-only contents permission.
Publication runs only after those workflows report success for the selected immutable SHA.

GitHub Actions receives a ruleset bypass for preparation commits on `develop`. Keep all workflows with
`contents: write` small, pinned to trusted code, and isolated from pull-request execution.

## Required checks and merge policy

`main` accepts only a reviewed `develop` promotion merge commit. It requires:

- Develop promotion guard;
- Cross-platform CI on Linux, Windows, and macOS;
- Package lifecycle checks on Linux, Windows, and macOS;
- one exact-SHA package build;
- release-state for the current PR head.

`develop` accepts ordinary reviewed task branches and requires the existing core checks plus release-state.
For an unlabeled PR or `release:none`, release-state passes without version preparation. For a preview
selection, it passes only for the exact prepared head. Preview labels never merge a pull request automatically.

Every release-selected PR targeting `develop` or `main` must use a merge commit with exactly two parents.
Repository merge settings disable squash and rebase merging; rulesets continue to require reviewed PRs.

## First-package bootstrap

The existing one-time bootstrap remains manual. Label automation starts after the package exists and npm
Trusted Publishing is configured. Bootstrap still runs through the real GitHub Actions publish lane and never
falls back to a local `npm publish`.

## Documentation

`structure/06_docs-and-release.md` remains the maintainer source of truth for branch, version, preview
acceptance, publishing, and recovery procedures. Implementation must replace its current manual
`release:prepare` and main-only preview instructions with this label-driven workflow. Public README files
should link to that maintainer procedure rather than duplicate the state machine.

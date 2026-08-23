# Docs And Release SOT

## Public docs

The public documentation site lives in `docs-site/` and is built with Next.js + fumadocs
(`docs-site/next.config.mjs`, `docs-site/source.config.ts`). English is served at the site root,
Korean under `/ko`, and Simplified Chinese under `/zh-cn`; content trees live at
`docs-site/content/docs/{en,ko,zh-cn}/`.

Navigation is defined per directory in `meta.json` files inside the content trees. When adding a
public page, add it to all three locale trees and the relevant `meta.json` — partial-locale pages
are rejected by the parity guard below.

### Docs i18n parity policy

Documentation follows the same localization policy as the dashboard i18n (`gui/src/i18n`: `en` is
the source of truth; ko/zh are compile-checked against its keys). For docs, English is the source
of truth and `tests/docs-i18n-parity.test.ts` enforces, for every page across `en`/`ko`/`zh-cn`
and for the README triple (`README.md`/`README.ko.md`/`README.zh-CN.md`):

- identical file sets (no missing or extra pages per locale),
- identical frontmatter keys,
- identical heading-depth sequences (titles translate, structure does not),
- identical fence count + info-string sequence,
- byte-identical fence bodies for machine-content fences (`json`/`jsonc`/`ts`/`tsx`/`js`) —
  prose-ish fences (`text`/`txt`/`bash` diagrams and commented commands) may localize,
- identical multisets of high-precision decimal tokens, so numeric claims (eval deltas, CI bounds)
  cannot drift between locales.

Editing docs in one language only will fail `bun test`; translate (or structurally mirror) all
three locales in the same change.

## GitHub Pages

`.github/workflows/deploy-docs.yml` publishes the docs to:

```text
https://zhsks311.github.io/Frogprogsy/
```

Every `main` push triggers the workflow; there is deliberately no path filter. Manual dispatch is
accepted only for `refs/heads/main`, and both trigger paths fetch `origin/main` and require the checked-out
`HEAD` to equal its current tip before generating or deploying. The workflow generates
`catalog/v1/model-catalog.json` from `GITHUB_SHA` plus that commit's timestamp, validates its strict schema
and digest, and adds it to the same `docs-site/out` artifact as the documentation. If provider/model data
differs from the deployed catalog, `catalogRevision` must be greater than the deployed revision.

Local validation:

```bash
cd docs-site
bun install --frozen-lockfile
bun run build
```

## GitHub workflow map

| Workflow | Trigger | Purpose |
| --- | --- | --- |
| `.github/workflows/prepare-release.yml` | Pull-request changes and release-label changes for `main` or `develop`; guarded manual reconciliation | Read trusted policy from the default branch, reconcile the selected release transition, create GitHub-signed `package.json.version` preparation or cancellation commits on an ephemeral branch, move the target with one exact leased Deploy Key push, bind exact-head checks, and project the `Release state` status plus the automation-owned `release:ready` label. |
| `.github/workflows/ci.yml` | Every pull request targeting `main` or `develop`; relevant pushes to either branch; exact-ref manual dispatch by release preparation | Linux, Windows, and macOS quality gate. Every test process uses a temporary `FROGPROGSY_HOME`; tests run with Bun isolation. |
| `.github/workflows/package-lifecycle.yml` | Every pull request targeting `main` or `develop`; relevant pushes to either branch; exact-ref manual dispatch by release preparation | Build one Bun tarball, then install and exercise those exact bytes on Linux, Windows, and macOS. |
| `.github/workflows/publish-prepared-release.yml` | Pushes to `develop` or `main`; guarded manual recovery for an exact prepared SHA | Classify a two-parent merge from immutable preparation records, apply channel-specific gates, and dispatch the trusted release workflow. |
| `.github/workflows/release.yml` | Trusted dispatch from the prepared-release workflow; one-time bootstrap | Verify and publish one exact-SHA tarball through npm Trusted Publishing, reconcile immutable Git and GitHub metadata, and run registry smoke checks. |
| `.github/workflows/deploy-docs.yml` | Every push to `main`, or guarded manual dispatch from current `main` | Build and publish the documentation and model catalog to GitHub Pages. |

Docs-only pushes can skip runtime workflow path filters, but every `main` push publishes Pages. A prepared
merge changes `package.json`, so it also triggers CI and Package lifecycle. Missing exact-SHA runs fail
publication instead of being treated as skipped.

## Branch strategy

frogprogsy uses a two-branch promotion model:

| Branch | Role | Accepted changes |
| --- | --- | --- |
| `main` | Default branch and stable release history | A reviewed `develop` to `main` promotion. Its merge commit is the only `latest` source. |
| `develop` | Integration branch and preview release history | Reviewed short-lived task branches. A selected merge commit may publish `preview`. |
| Short-lived task branches such as `feat/*` and `fix/*` | One bounded task in one worktree | Branch from `develop`, then return to `develop` through review. |

The active flow is:

1. Start each ordinary change from current `develop` in a dedicated branch and worktree.
2. Merge reviewed task branches into `develop`; do not merge ordinary work directly into `main`.
3. A preview selection may publish the accepted task-branch merge SHA on `develop`.
4. A stable selection or exact preview promotion prepares the reviewed `develop` to `main` pull request.
5. Publish stable `latest` only from that promotion's accepted merge SHA on `main`.
6. Keep `main` as the default and deployment branch. There is no `dev` alias or third long-lived branch.

Repository settings and rulesets enforce the branch model:

- Allow merge commits and disable squash and rebase merging. A release-selected merge must have exactly
  two parents so the publisher can verify the source-side preparation history.
- Require reviewed pull requests for both long-lived branches. Automation prepares versions and reports
  readiness; it never approves or merges a pull request.
- Require `Release state`, Cross-platform CI, and Package lifecycle on `develop`.
- Require those checks plus `Develop promotion guard` on `main`. Stable publication also waits after merge
  for the exact-SHA Pages deployment and package-to-Pages catalog equality gates.
- Give GitHub Actions a narrowly scoped bypass on the `develop` ruleset so `Prepare release` can push its
  verified preparation or cancellation commit. Do not grant an equivalent general bypass on `main`.
- Permit the workflow-declared `GITHUB_TOKEN` scopes: `Prepare release` needs Actions, contents,
  pull-request, and commit-status writes; the prepared-release dispatcher needs Actions write plus contents
  and pull-request read; `Release` needs contents write, identity-token write, and Actions and pull-request
  read. Keep the repository's default token permission read-only.
- Create every label listed under [Release labels](#release-labels). Configure npm Trusted Publishing for
  owner `zhsks311`, repository `Frogprogsy`, and workflow `release.yml`.


## Root README

The root READMEs are the concise product entrypoint. They should explain what frogprogsy does, how to
install/start it, where Claude Code state is touched, and where the full docs live. Deep implementation
invariants belong in `structure/`, not the README.

## Local investigations and artifacts

`docs/` and `artifacts/` are gitignored, local-only investigation and verification output. Never
commit either directory. When an investigation becomes a maintained invariant, record it under
`structure/`; publish user-facing guidance through `docs-site/` and the localized root READMEs.

## Bun development package cycle

Development dependency installation, testing, GUI builds, tarball creation, global installation, updates,
and package-only removal use Bun. `package.json` pins the expected Bun toolchain through `packageManager`
and exposes `bun run dev:package`.

`dev:package build` generates the bundled catalog from the full tracked `HEAD` SHA and that commit's
timestamp before any GUI build or tarball pack. The generated file staged into the tarball is strict-schema
and digest checked after extracting the real packed member. An already-dirty worktree still records the
tracked SHA while preserving the manifest's existing dirty flag semantics.

The command runs the full local gates by default and writes an immutable tarball plus SHA-256 manifest
under the repository Git common directory. All linked worktrees share that directory. A build id contains
package version, abbreviated commit, completion timestamp, and tarball hash; `latest` means the most
recently completed successful build, with a deterministic build-id tie break. Updating `latest.json` is
serialized by an owner-token lock and an atomic rename, so concurrent worktrees cannot silently select an
older build.

`dev:package install --yes` installs either the shared latest manifest or an explicit `--build <id>` only
after size/hash verification. The installed package receives a local build receipt, and
`dev:package status` reports `current`, `outdated`, `untracked`, or `not-installed`. `reinstall --yes`
always installs the tarball produced by that invocation rather than re-resolving latest after the build.

The development script manages only Bun's global package/link state. It never invokes the product-level
uninstall command and never removes frogprogsy config, Claude homes, Keychain entries, grants, or other
credentials. Public registry publishing is a separate release concern.

## Release strategy

This file is the single maintainer source of truth for release policy. Workflow files enforce the policy;
localized READMEs contain only consumer installation and update guidance.

### Version and channel policy

| Channel | Version form | Source | Purpose |
| --- | --- | --- | --- |
| `preview` | `0.2.0-preview.1` | The accepted merge SHA on `develop` | Test a public candidate without moving the stable install channel. |
| `latest` | `0.2.0` | The accepted `develop` to `main` merge SHA | Publish the supported release installed by default. |

A published npm version, Git tag, or GitHub Release is immutable. Moving or removing the mutable npm
`preview` dist-tag does not delete older candidates; users can install them by exact version.

New preparation requires `main`'s `package.json.version`, npm `latest`, and the matching stable Git tag and
GitHub Release to agree. Automation stops on disagreement instead of calculating from uncertain state.

### Release labels

| Label | Eligible pull request | Meaning |
| --- | --- | --- |
| `release:none` | Any supported pull request to `develop` or `main` | Make no release preparation. Use it for ordinary work and cancellation. |
| `release:patch` | `develop` to `main` | Prepare the next patch stable version. |
| `release:minor` | `develop` to `main` | Prepare the next minor stable version. |
| `release:major` | `develop` to `main` | Prepare the next major stable version. |
| `release:preview-patch` | Same-repository branch to `develop` | Prepare the next unused patch preview. |
| `release:preview-minor` | Same-repository branch to `develop` | Prepare the next unused minor preview. |
| `release:preview-major` | Same-repository branch to `develop` | Prepare the next unused major preview. |
| `release:promote` | `develop` to `main` | Remove the prerelease suffix from the exactly reconciled current preview. |
| `release:ready` | Automation only | Mark the current prepared head after its bound checks pass. People must never add or remove this label. |

Every eligible pull request must carry exactly one selection label. Only one open pull request may have a
selection other than `release:none`; a competing selection keeps `Release state` failed. `release:ready`
is an automation-owned status marker, not a selection. People must not add or remove it; automation removes
stale readiness and adds it only after the current head passes bound checks.

Labels request transitions; they are not release authority after merge. The publisher reads verified
preparation and cancellation records from merged history. Changing a label after merge cannot change the
channel or version.

### Cancellation and reselection

To cancel, replace the selection with `release:none`. Removing the selection also starts cancellation, but
leave `release:none` on the reconciled PR. Automation removes `release:ready` and, when the PR owns a pending
preparation, creates a verified cancellation commit that restores the preceding version. It never reverses
an inherited or already merged preparation.

To reselect, replace the old selection with exactly one new selection. Automation cancels the current PR's
pending preparation before preparing the new target and may push both records in one fast-forward update.
A changed label, base, head, stable baseline, or registry snapshot invalidates stale evidence.

### Version calculation

Assume `main` and npm `latest` are `1.2.3`:

| Selection | First available target |
| --- | --- |
| `release:patch` | `1.2.4` |
| `release:minor` | `1.3.0` |
| `release:major` | `2.0.0` |
| `release:preview-patch` | `1.2.4-preview.1` |
| `release:preview-minor` | `1.3.0-preview.1` |
| `release:preview-major` | `2.0.0-preview.1` |

For a preview target, automation selects the smallest positive `preview.N` absent from npm versions,
immutable Git tags, and GitHub Releases. A consistent partial release can reconcile the same version only
for the same prepared SHA and bytes. Otherwise the version remains consumed.

A direct stable selection calculates from `main` and npm `latest`, even when it abandons an active preview.
`release:promote` never calculates a target: it removes `-preview.N` from the current candidate.

### Preview publication from `develop`

1. Apply one `release:preview-*` label to a same-repository pull request targeting `develop`.
2. `Prepare release` changes only `package.json.version` on the source branch, dispatches read-only checks
   for that exact head, and adds `release:ready` after they pass.
3. Review the updated pull request and merge it into `develop` with a merge commit. Automation does not
   merge it.
4. The `develop` push dispatcher verifies the two-parent merge and uncancelled preparation. It requires
   successful exact-SHA Cross-platform CI and Package lifecycle results, builds one tarball, and verifies
   the bundled catalog's schema, digest, revision, and source SHA.
5. The release workflow publishes that exact merge SHA to npm `preview`, creates immutable Git and GitHub
   prerelease metadata, and runs registry and provenance smoke checks.

Preview publication does not wait for Pages and does not update the stable Pages catalog. A later
`develop` push cannot cancel an accepted preview SHA; publication is keyed by SHA and is not cancelled.

For acceptance testing, replace only the global Bun package:

```bash
frogp stop
bun remove -g frogprogsy
bun add -g frogprogsy@preview
frogp refresh
```

Test from a new terminal. Verify the installed version, proxy lifecycle, dashboard, Claude profile
restoration, configured authentication and model visibility, and release-critical provider responses.
Reinstall `frogprogsy@latest` to verify rollback. Never overwrite a failed candidate; fix forward and select
the next preview.

### Stable release without a preview

1. Apply `release:patch`, `release:minor`, or `release:major` to the reviewed `develop` to `main` PR.
2. `Prepare release` recalculates from `main` and npm `latest`, changes only `package.json.version` on
   `develop`, and pushes a verified preparation commit through the narrow ruleset bypass.
3. Review the new exact head and merge it with a merge commit only after `Release state`, Cross-platform CI,
   Package lifecycle, and `Develop promotion guard` pass. Automation never merges the PR.
4. Main workflows validate that merge SHA and deploy Pages. Publication requires the newest successful
   exact-SHA CI, Package lifecycle, and Pages attempts, one tarball, and package-to-Pages catalog source SHA,
   revision, and digest equality.
5. The release workflow publishes npm `latest`, creates the immutable stable tag and GitHub Release, marks
   the Release as latest, and runs registry and provenance smoke checks.

### Exact preview promotion

At `release:promote` preparation time, the published npm preview and provenance, npm `preview` dist-tag,
immutable preview Git tag, GitHub prerelease, and current `develop` HEAD must identify one preview version
and source SHA.

Apply `release:promote` to the `develop` to `main` PR only after they agree exactly. Automation changes only
`package.json.version` from `X.Y.Z-preview.N` to `X.Y.Z`, then repeats the stable preparation, review,
merge, catalog, publication, and registry gates. Any intervening commit between preview publication and
promotion preparation, including documentation, requires another preview or a direct stable label.

### Publication gates

| Channel | Accepted SHA | Required gates |
| --- | --- | --- |
| `preview` | Accepted `develop` merge SHA | Cross-platform CI, Package lifecycle, one exact-SHA tarball, and bundled catalog schema, digest, revision, and source-SHA validation. Pages cannot substitute. |
| `latest` | Accepted `main` promotion merge SHA | Cross-platform CI, Package lifecycle, Pages deployment, one exact-SHA tarball, and package-to-Pages source-SHA, revision, and digest equality. |

Each gate reads only the newest run attempt for its workflow and SHA. Missing, queued, in-progress,
cancelled, failed, or superseded attempts fail closed. Automatic publication binds the triggering push's
immutable `after` SHA; a later branch update does not replace it.

### Recovery

Ordinary releases publish automatically after merge. Use manual recovery only for an existing prepared
merge SHA:

```bash
bun run release recover <full-lowercase-merge-sha> --source-branch develop|main
bun run release recover <full-lowercase-merge-sha> --source-branch develop|main --publish
```

The first command is a dry run. The second asks the trusted dispatcher to reconcile the same immutable SHA.
Recovery requires a recorded two-parent merge, valid uncancelled preparation, and containment in the named
branch.

| Observed state | Recovery |
| --- | --- |
| npm version, Git tag, and GitHub Release are absent | Publish the exact prepared SHA and version. |
| npm exists with matching provenance and bytes, the expected dist-tag already points to it, and Git or GitHub metadata is absent | Do not republish. Create only the missing immutable metadata and rerun registry smoke checks. |
| npm exists with matching provenance and bytes, but `preview` or `latest` does not point to the expected version | Fail closed. Trusted Publishing does not grant dist-tag management. A maintainer restores the exact tag with npm authentication and 2FA, then reruns recovery. |
| npm is absent but its Git tag or GitHub Release exists | Block same-version publication. Preserve immutable metadata and fix forward with a new version. |
| Any store maps the version to a different SHA, channel, provenance, or digest | Block automation. Repair only mutable metadata when safe or choose a new version. |

Restore a missing or incorrect expected dist-tag before rerunning the publish recovery command:

```bash
npm dist-tag add frogprogsy@<version> <preview|latest>
```

After `release:promote` has produced an immutable stable preparation and merge, stable recovery does not
depend on the current mutable `preview` pointer. It revalidates the stable preparation record, exact npm
stable bytes and provenance, and stable Git tag and GitHub Release metadata. Published versions are never
reused for different content.

### npm preview dist-tag cleanup

After a stable release, the workflow reports current dist-tags. If `preview` remains, a maintainer may
remove that mutable pointer with npm authentication and 2FA:

```bash
npm dist-tag rm frogprogsy preview
```

Stable-release cleanup remains separate and optional: removing a leftover `preview` pointer does not delete
a version. Normal publication remains tokenless because Trusted Publishing grants no dist-tag management
permission. Do not add a long-lived token for tag repair or cleanup.

### First-package bootstrap

Label automation starts after the npm package exists and Trusted Publishing is configured. Bootstrap the
first stable version once through GitHub Actions, never with local `npm publish`:

1. Create a short-lived granular npm token with the access needed to create the package and 2FA bypass only
   for this CI publish. Store it as `NPM_BOOTSTRAP_TOKEN`.
2. From a reviewed exact `main` merge SHA with the unused stable version, run:

   ```bash
   bun run release bootstrap <version> --expected-sha <full-lowercase-main-merge-sha> --publish
   ```

3. Configure npm Trusted Publishing for owner `zhsks311`, repository `Frogprogsy`, and `release.yml`.
4. Revoke the token, delete the secret, verify a normal OIDC release and provenance, then disallow token
   publishing on npm.

Normal releases receive no npm token. Bootstrap fails closed if the package exists or the secret is absent.

### Security boundary

`Prepare release` uses `pull_request_target` only to run trusted workflow and policy code from the default
branch. Its write-capable job never checks out, installs, builds, or executes pull-request code. Ordinary
pull-request tests and builds run separately with read-only contents permission.

Publication receives contents and identity-token writes only after exact-SHA gates pass. Keep write-capable
workflows small, pin third-party actions, and never add a long-lived-token fallback for Trusted Publishing.

## Release metadata invariants

| Surface | Required state |
| --- | --- |
| `package.json` | `version` equals the preparation target on the accepted merge SHA. |
| npm | `frogprogsy@<version>` is absent before first publication, then exists with the selected dist-tag and provenance. |
| Git tag | `v<version>` is absent before first publication, then points to the accepted merge SHA. |
| GitHub Release | `v<version>` is absent before first publication, then targets that SHA with the matching preview or stable kind. |

Preparation changes only `package.json.version`. Verified commit trailers bind the target, PR, selection,
stable baseline, and relevant SHAs. Publication trusts these records, the two-parent merge, tarball bytes,
and registry provenance rather than mutable labels or expiring artifacts.


## Cross-platform CI

`.github/workflows/ci.yml` is the ordinary quality gate for runtime/package changes. It pins the Bun
version declared by `packageManager` and runs on Linux, Windows, and macOS:

```bash
bun install --frozen-lockfile
bun x tsc --noEmit
bun test --isolate ./tests
bun build scripts/release.ts --target=bun --outdir=.tmp/ci-release-script-check
bun run src/cli.ts help
cd gui && bun install --frozen-lockfile && bun run build
```

`bunfig.toml` limits discovery to `tests/` and preloads a process-wide temporary
`FROGPROGSY_HOME`. The preload overrides inherited values and reasserts the temporary home plus
`NODE_ENV=test` before every test, so a developer's live config, PID, active port, and watchdog files
cannot affect the suite. `--isolate` additionally gives each test file a fresh global object, but
`process.env` remains process-wide; tests that mutate other environment variables still own their
explicit save/restore.

The GitHub-hosted macOS lane runs a separately opted-in, bounded Keychain smoke. It creates one
unique grant-scoped item, verifies product read/status/delete behavior including idempotent deletion,
and records only the scoped service/account needed by an `always()` cleanup step. It never targets
the native `Claude Code-credentials` service.

`.github/workflows/package-lifecycle.yml` builds one GUI-bearing tarball on Linux with gates skipped
because `ci.yml` owns those gates, uploads that immutable artifact, and downloads the same bytes in
all three OS jobs. Each job installs into an isolated Bun global root and uses temporary frogprogsy
and Claude homes to verify start, health, explicit restore, stop, restart, final byte-equivalent
restore, watchdog/proxy cleanup, and package-only removal.

The release workflow is publish-focused and receives only immutable inputs classified by the prepared-release
dispatcher. Before a dry run, recovery, or publication, it requires the channel-specific exact-SHA gates
described above. Missing runs fail closed, so release remains deployment of a verified commit rather than
a second CI pipeline.

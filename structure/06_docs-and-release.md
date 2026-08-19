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
| `.github/workflows/ci.yml` | Every `pull_request` targeting `main` or `develop`; `push` to `main` or `develop` when runtime/package paths change; or manual dispatch | Linux, Windows, and macOS quality gate. Every test process uses a temporary `FROGPROGSY_HOME`; tests run with Bun isolation. The GitHub-hosted macOS lane also runs the opt-in scoped Keychain grant lifecycle smoke. |
| `.github/workflows/package-lifecycle.yml` | Every `pull_request` targeting `main` or `develop`; `push` to `main` or `develop` when package/lifecycle paths change; or manual dispatch | Build one Bun tarball, then install and exercise those exact bytes on Linux, Windows, and macOS through start, explicit restore, stop, restart, final restore, and package-only removal. |
| `.github/workflows/release.yml` | Manual dispatch only | Bun validation/dry-run plus final Trusted Publishing workflow. Both lanes require the latest exact-`GITHUB_SHA` Cross-platform CI, Package lifecycle, and Pages runs to be completed successfully, then require the extracted npm tarball catalog to match the deployed Pages catalog's source SHA, revision, and digest. |
| `.github/workflows/deploy-docs.yml` | Every `push` to `main`, or guarded manual dispatch from current `main` | Build and publish the Next.js/Fumadocs site plus `catalog/v1/model-catalog.json` to one GitHub Pages artifact. |


Docs-only pushes can still skip runtime workflow path filters, but every resulting `main` commit publishes
Pages. Release preparation changes `package.json`, so the promoted release merge commit also triggers CI
and Package lifecycle; a missing exact-SHA run fails the release closed rather than being treated as skipped.

## Branch strategy

frogprogsy uses a two-branch promotion model:

| Branch | Role | Accepted changes |
| --- | --- | --- |
| `main` | Default branch and released or release-ready history | A reviewed `develop` → `main` promotion only. The promotion PR's merge commit is the only release source. |
| `develop` | Integration branch for the next release | Reviewed short-lived task branches. |
| Short-lived task branches such as `feat/*` and `fix/*` | One bounded task in one worktree | Branch from `develop`, then return to `develop` through review. |

The active flow is:

1. Start each ordinary change from current `develop` in a dedicated branch and worktree.
2. Merge reviewed task branches into `develop`; do not merge ordinary work directly into `main`.
3. When `develop` is release-ready, promote it through one reviewed `develop` → `main` pull request.
4. Use the resulting merge commit on `main` as the exact release SHA. Never release an unpromoted task
   or integration commit.
5. Keep `main` as the default and deployment branch. There is no `dev` alias or third long-lived branch.

Branch protection requires Cross-platform CI and Package lifecycle checks on pull requests targeting
either long-lived branch. Both workflows start for every such pull request, regardless of changed paths,
so required checks cannot remain pending after a path-filter skip. A `main` promotion pull request must
also pass the stable `promotion-guard` job, whose required-check context is `Develop promotion guard`.
It accepts only `develop` as the head branch for `main`; pull requests to `develop` may use ordinary
task branches.


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

This file is the single maintainer source of truth for release policy. `CLAUDE.md` and `AGENTS.md`
carry only the non-negotiable summary, `.github/workflows/release.yml` is the executable enforcement
layer, and the localized READMEs contain only consumer installation and update instructions. Do not
duplicate the full strategy across those surfaces.

### Version and channel policy

frogprogsy uses SemVer release versions and two registry channels:

| Channel | Version form | Purpose |
| --- | --- | --- |
| `preview` | prerelease version such as `0.2.0-preview.1` | Validate a candidate without moving the stable install channel. |
| `latest` | stable version such as `0.2.0` | Supported public release installed by default. |

GitHub Release metadata follows the same channel mapping: `preview` releases are marked as prereleases and
must not become **Latest**, while `latest` releases are non-prerelease and explicitly become **Latest**.

A published preview is immutable and is not republished as stable. After preview validation, publish
the corresponding stable version as a new release. Every changed package version is consumed even if
a later metadata step fails; recovery uses a new patch or prerelease number.

### Preview candidate validation

Use three distinct lanes; do not substitute one for another:

| Lane | Command / install source | What it proves |
| --- | --- | --- |
| Local development package | `bun run dev:package reinstall --yes` | The current worktree can build, package, install, and report an exact immutable local build. |
| Public preview candidate | `bun run release <version>-preview.<n> --tag preview --publish` followed by `bun add -g frogprogsy@preview` | The registry tarball, global installation, PATH, runtime lifecycle, migrations, and real integrations work without moving `latest`. |
| Stable release | `bun run release <version> --publish` | The validated candidate is available on the default supported channel. |

A preview is public and consumes its version permanently. It must contain no secrets or local-only artifacts.
Installing `frogprogsy` without a tag continues to resolve `latest`; testers must explicitly request
`frogprogsy@preview`.

Run a preview for changes that can behave differently only after packaging or installation, including global
bin/PATH changes, proxy start/stop/watchdog behavior, Claude settings backup and restoration, credential or
Keychain integration, model discovery, configuration migrations, and public CLI/API compatibility. A
documentation-only change that cannot alter the package or runtime does not require a preview.

The maintainer preview acceptance cycle is:

1. Prove the candidate locally with `bun run dev:package reinstall --yes` and
   `bun run dev:package status`.
2. On clean `develop`, prepare an unused prerelease such as `0.2.0-preview.1` with
   `bun run release:prepare 0.2.0-preview.1`, commit the version change, and include it in a reviewed
   `develop` → `main` promotion. After the promotion merge, require the latest exact-SHA CI, Package
   lifecycle, and Pages runs for that merge commit to complete successfully. From clean `main`, publish
   it with `bun run release 0.2.0-preview.1 --tag preview --publish`.
3. Stop the currently running proxy and replace only the global Bun package. Do not use the destructive
   product-level uninstall command:
   `frogp stop`, `bun remove -g frogprogsy`, `bun add -g frogprogsy@preview`, then `frogp refresh`.
4. Test from a new terminal so PATH resolution is real. Verify the installed registry version, proxy
   start/health/GUI, stop and restart, Claude profile backup/restoration, native Claude OAuth/connectors,
   configured provider authentication and model visibility, and at least one real response through each
   release-critical provider. Confirm package-only removal preserves `~/.frogprogsy`, Claude homes, Keychain
   items, grants, and credentials.
5. Reinstall `frogprogsy@latest` and confirm rollback to the supported channel works.
6. If validation fails, fix forward through a task branch and `develop`, prepare the next unused prerelease,
   and promote it to `main`; then publish `0.2.0-preview.2` (or the next unused prerelease). Never replace
   or retag the failed preview tarball.
7. If validation passes, prepare the stable SemVer on `develop`, include the version change in a new
   `develop` → `main` promotion, and publish that promoted merge commit as a separate release. Apart from
   the version metadata, the stable candidate must match the previewed contents; any product change
   requires another preview cycle. The stable release still reruns every exact-SHA gate and registry smoke
   check.

Retain the preview workflow URL, package integrity, tested operating systems, and acceptance results in the
release record. A passing local development package is not evidence that the public preview tarball was
installed, and a passing preview is not permission to bypass the stable release gates.

### Release sequence

1. Merge the release contents into `develop` through the normal task-branch and worktree path.
2. On clean `develop`, choose an unused version and run `bun run release:prepare <version>`. The helper
   checks that the version is unused and changes only `package.json`; it does not commit, push, create a
   pull request, or dispatch a workflow.
3. Commit the version change on `develop` and include it in a reviewed `develop` → `main` promotion.
   The promotion PR's merge commit is the only release source.
4. On clean `main`, run `bun run release <version> [--tag latest|preview]` as a dry-run. The requested
   version must exactly match `package.json`. The helper confirms that the version is unused, runs
   typecheck, requires `HEAD` to equal `origin/main`, then waits for the latest Cross-platform CI, Package
   lifecycle, and Pages runs for that exact SHA. Missing, queued, superseded, cancelled, or failed latest
   runs block release. The dry-run extracts `package/src/generated/model-catalog-v1.json` from the exact
   Bun-built tarball and requires it to match the deployed `catalog/v1/model-catalog.json` source SHA,
   revision, and digest.
5. From the same `main` SHA, run `bun run release <version> [--tag latest|preview] --publish`. The helper
   checks `origin/main == HEAD` again immediately before workflow dispatch. The real publish repeats the
   catalog gate. If `main` moved after the dry-run, repeat every exact-SHA gate and dry-run on the new
   release SHA.
6. Require the registry smoke, immutable `v<version>` tag, and matching GitHub Release to succeed.
7. Verify the published version and dist-tags with `bun pm view`; retain the workflow URL as the
   release receipt.

`scripts/release.ts` waits for exact-SHA gates, dispatches the release workflow, and watches it. Its
`release` path never changes `package.json` or runs `git add`, `git commit`, or `git push`. Direct local
registry publishing is not a supported shortcut. Manual dispatch must set `expected-sha` to the full
40-character release commit.
The workflow compares it with `GITHUB_SHA` before any registry work; `scripts/release.ts` supplies it
automatically.

### First-package bootstrap

Trusted Publisher configuration is attached to an existing npm package, so the first package version
is a separate, one-time bootstrap. It must still run in the real-publish GitHub Actions lane using a
short-lived npm credential; local `npm publish` is not permitted.

1. Create a granular npm token with the shortest available expiry, read/write access to **All
   Packages** (the package does not exist yet), and 2FA bypass only for this CI publish. Store it as
   the `NPM_BOOTSTRAP_TOKEN` GitHub Actions secret.
2. Run `bun run release <version> --publish --bootstrap`. Bootstrap is stable/`latest` only; the helper
   and workflow still require the exact-SHA CI gates and exact Bun-built tarball.
3. On npmjs.com, configure the package Trusted Publisher with owner `zhsks311`, repository
   `Frogprogsy`, workflow filename `release.yml`, and the `npm publish` action.
4. Revoke the granular token on npmjs.com, delete the `NPM_BOOTSTRAP_TOKEN` Actions secret, verify a
   normal OIDC release, and configure npm publishing access to disallow token publishing.

After the first normal OIDC release, confirm that npm shows provenance for the published tarball before
treating the Trusted Publisher migration as complete.

The workflow rejects bootstrap during dry-runs, after the package exists, or when the scoped secret is
missing. Normal releases receive no registry token and must fail closed rather than fall back from OIDC.

### Recovery policy

Do not unpublish, overwrite tarballs, force-move public tags, or reuse a consumed version. For a bad
stable release, fix forward with the next patch and publish it to `latest`. For a bad preview, publish
the next prerelease number. Metadata disagreement between the registry, Git tag, and GitHub Release
blocks automation until maintainers either repair the missing metadata at the same immutable commit
or choose a new version. The normal release workflow does not perform ad-hoc dist-tag rollback.

The Pages catalog is also recovered by fixing forward. Correct the bad catalog inputs through a task
branch and `develop`, increase `catalogRevision` when provider/model data changes, and promote the fix to
`main`. Wait for the new promotion merge commit's Pages deployment, then build and release only that exact
SHA. Do not manually replace the Pages artifact, deploy an older SHA, lower or reuse a revision for changed
data, or publish a tarball whose catalog does not match Pages.

## Release workflow

Package development and release preparation are Bun-first. `package.json` defines the `frogprogsy` package
and the `frogp` bin — and only that bin. The package must never declare a `claude` bin: installing it would
shadow the user's own Claude Code on `PATH` (`structure/02_config-and-claude-home.md`). Install verification
enforces this in one direction only: a successful new install requires that any Bun-global `claude` is *not*
frogprogsy-owned. Rollback verification does not apply that rule, because a restored older version legitimately
owns one. `prepublishOnly` generates the tracked-`HEAD` catalog before typecheck and GUI build.
`scripts/release.ts prepare` uses Bun for registry preflight and the `develop`-only version update; the
`release` path uses Bun for registry preflight, typecheck, and release orchestration without changing
tracked files. The workflow then creates one allowlisted, hash-recorded tarball through
`scripts/dev-package.ts`. Each
workflow run verifies the exact tarball it produced and compares its extracted strict catalog with the
exact-SHA Pages catalog before either dry-run or real publish. Dry-run validates the tarball with Bun,
while a real run passes that same verified path to the final `npm publish`. npm is otherwise confined to
the real-publish lane, where it first updates itself to the OIDC-capable version and then performs Trusted
Publishing. The one-time bootstrap uses the same lane and exact tarball with an explicitly selected
short-lived secret; no normal release receives that credential. This exception remains because tokenless
OIDC authentication and provenance are not currently documented for `bun publish`.

## Release metadata invariants

Every package release version must map cleanly across four surfaces:

| Surface | Required state |
| --- | --- |
| `package.json` | `version` equals the release workflow `version` input. |
| Package registry | `frogprogsy@<version>` does not exist before publish, then exists after publish with the requested dist-tag. |
| Git tag | `v<version>` does not exist before publish, then points at the exact release commit. |
| GitHub Release | `v<version>` does not exist before publish, then is created from the exact release commit. |

The release must fail before the final publish if the package registry, Git tag, or GitHub Release already
has the requested version. This prevents partial releases where a package is published but GitHub Release
creation fails afterward.

Do not force-move public version tags by default. If release metadata is already inconsistent, treat
the version as consumed and publish the next unused patch version instead. Only rewrite a public tag
after an explicit human decision that the public history rewrite is acceptable.

Manual preflight checks when debugging a release:

```bash
bun pm view frogprogsy@<version> version
git ls-remote origin refs/tags/v<version>
gh release view v<version>
```

If any of these commands reports an existing artifact for the requested version, stop before
publishing. For a non-destructive recovery, choose the next unused patch version and release that
version through `scripts/release.ts`.

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

The Release workflow remains manual and publish-focused. Before any dry-run or publish step, it
checks that the exact release commit (`GITHUB_SHA`) already has successful Cross-platform CI and
Package lifecycle runs. Missing runs fail closed. This makes release a deployment of a verified
commit rather than a second CI pipeline.

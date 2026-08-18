# Remote Model Catalog SOT

## Goal

Frogprogsy refreshes model data when the proxy starts, without requiring a new npm package. A user who restarts the proxy receives the latest validated catalog published from `main`.

A release still contains a complete catalog snapshot. The proxy must start and serve models when the network, GitHub Pages, or the remote catalog is unavailable.

## Scope

The catalog may describe only model-level data that the installed Frogprogsy already knows how to apply:

- provider and model IDs;
- managed default and retired model IDs;
- context limits and input modalities;
- supported reasoning levels and provider wire-value mappings;
- unsupported request parameters and tool-choice restrictions;
- reasoning-content preservation and escaped built-in tool names;
- a provider-specific wire model ID; and
- the minimum Frogprogsy version required by a provider or model record.

The remote catalog must not contain or override:

- provider base URLs;
- adapters or authentication modes;
- OAuth configuration, headers, API keys, or credentials;
- executable code; or
- user-selected providers, models, or credentials.

A model that needs a new adapter, transport, or request transformation requires a Frogprogsy release. Remote data cannot add that behavior.

## One generated artifact

One deterministic generator combines the maintained provider registry and generated Jawcode metadata into `model-catalog-v1.json`. A maintained positive integer, `catalogRevision`, changes whenever the generated model data changes. Reverting bad model data still increments this revision, so clients can accept an operational rollback. For a given source commit, revision, and generation timestamp, the generator produces the same bytes.

The generator serves two release paths:

1. a GitHub Release package includes the catalog generated for that release commit; and
2. the GitHub Pages deployment publishes the catalog generated from the latest qualifying `main` commit at:

```text
https://zhsks311.github.io/Frogprogsy/catalog/v1/model-catalog.json
```

The artifact contains a schema version, catalog revision, SHA-256 digest of the canonical provider/model data, source `main` commit SHA, generation time, minimum reader version, providers, and model records. Stable key and array ordering makes equal inputs produce equal model data. CI supplies the generation time and source SHA explicitly. Runtime validation rejects an invalid time or a time unreasonably later than the local clock.

The generator rejects duplicate provider/model IDs, invalid defaults, contradictory constraints, unknown fields, unsupported values, and sensitive transport or authentication fields.

## Publication

Every push to `main` triggers the GitHub Pages workflow, even when the changed paths are unrelated to the catalog. The workflow:

1. verifies that the checkout and source SHA are the current `main` commit;
2. generates the catalog from that commit;
3. validates its schema and internal consistency;
4. requires a higher `catalogRevision` when the generated model data differs from the deployed catalog;
5. builds the documentation site;
6. places the validated catalog under `docs-site/out/catalog/v1/`; and
7. deploys one Pages artifact.

Runs are serialized without canceling an in-progress deployment. If a newer `main` push makes an older run fail the current-SHA check, the newer push has its own run and publishes the latest catalog. Manual Pages deployment is also restricted to `refs/heads/main`; selecting another branch must fail before build or deployment. A failed generation or validation prevents publication. The previously deployed Pages artifact remains available.

To roll back bad data, maintainers restore the previous model records in a new `main` commit and increment `catalogRevision`. They do not republish older bytes with an older revision.

The package-lifecycle workflow runs the same generator before it creates the one shared release tarball. The release workflow requires a successful Pages deployment for that exact release SHA, extracts the bundled catalog from the tarball, and requires its revision and digest to equal the catalog served by Pages before dry-run or publish. It must not generate or maintain a second hand-written catalog.

## Startup refresh

The proxy selects its catalog before it reconciles providers and starts listening:

1. Load the catalog bundled with the installed release.
2. Load the last valid remote catalog from `<FROGPROGSY_HOME>/cache/model-catalog-v1.json`, if present and compatible.
3. Select the bundled or cached candidate with the higher `catalogRevision`. Equal revisions must have the same catalog digest; a conflict rejects the later, less-trusted candidate.
4. Fetch the fixed GitHub Pages URL once, with a two-second timeout.
5. Require a JSON content type. Check `Content-Length` when present, then stream the decoded body with a 2 MiB maximum before parsing. Reject more than 256 providers or 20,000 total model records.
6. Validate the envelope, digest, revision, compatibility range, generation time, IDs, bounds, and constraints.
7. A fetched catalog with a higher revision becomes selected and atomically replaces the cache. At the same revision, a matching digest may refresh cache metadata; a conflicting digest is rejected.
8. Use the selected valid catalog. If the fetch or validation fails, keep the existing cache. If no valid cache exists, use the bundled catalog.

Frogprogsy does not poll after startup. Opening the GUI does not fetch the catalog again. The next proxy restart checks for a newer catalog.

A remote failure may add one warning to startup and diagnostics, but it must not prevent startup. Logs and JSON output must not expose the absolute cache path or request secrets.

## Combining catalog, provider, and user data

The remote catalog does not replace a user's `config.json`. Frogprogsy keeps two separate values:

- the persisted user configuration, which owns credentials and user choices; and
- an effective in-memory configuration, which combines user choices with managed catalog data for the running process.

Each provider created from a built-in preset stores an immutable `catalogProviderId`. A renamed instance such as `anthropic-work` still points to the installed `anthropic` catalog record. A custom provider has no catalog ID. After migration, Frogprogsy must not infer catalog ownership from `baseUrl`, adapter, or the user-visible provider name.

For a catalog-managed provider with live discovery enabled, persisted `userModels` contains only explicit additions. `models` remains the full user-owned list for custom providers and for `liveModels:false` fixed allowlists. Login and service-add paths persist only transport/authentication choices, `catalogProviderId`, the selected default, and explicit user overrides; they must not seed managed model lists or capabilities into `config.json`.

The first version with this split performs one config-schema migration before normal startup. Because the old schema has no provenance, migration attaches a catalog ID only when the provider key equals a built-in ID and the immutable preset identity fields (`adapter`, normalized `baseUrl`, and canonical `authMode`) equal that built-in preset. For this comparison only, an absent legacy `authMode` means `key`, matching its existing runtime default. Credentials and model metadata do not participate in this match. Any ambiguous or renamed provider remains custom and is reported with an action to attach a built-in catalog explicitly.

For an attached provider with live discovery enabled, model IDs outside the bundled managed and retired sets become `userModels`; bundled values are removed from preset-owned fields while narrower user differences remain explicit overrides. A fixed allowlist remains unchanged. An old explicit addition already equal to a managed ID cannot be distinguished; after migration, every new explicit addition has durable `userModels` provenance.

Before mutation, Frogprogsy writes `<FROGPROGSY_HOME>/config.pre-model-catalog-v1.json` once with mode `0600`, then atomically saves `modelCatalogConfigVersion:1`. If backup or migration fails, startup keeps the original config, treats its providers as custom for that run, and reports the failure instead of partially migrating.

Startup reconciliation may change only the effective configuration. Management writes update the persisted user fields and then rebuild the effective value; they must never serialize remote catalog fields back into `config.json`.

Frogprogsy builds the effective model list from three inputs:

- the selected managed catalog: current remote, last valid cache, or bundled fallback;
- the provider's `/models` response for the current account; and
- explicit user settings.

The sources have different jobs:

- The provider response says which models the current account exposes and supplies any live metadata it reports.
- The managed catalog supplies validated compatibility rules and safe limits.
- User settings preserve the chosen default, explicit additions, disabled models, and fixed allowlists.

For providers with live discovery enabled, Frogprogsy combines live model IDs with managed fallback IDs and `userModels`. Field conflicts use explicit safe operations:

- context limits use the lowest known positive value;
- input modalities and reasoning levels use the intersection when both sources report them, or the one known value when only one source reports them;
- unsupported-parameter, tool-choice, and reasoning-content-preservation model sets use the union, so a restriction or preservation requirement wins;
- managed reasoning wire-value mappings are authoritative for keys they define; user mappings may add keys only for final supported reasoning levels and may not replace a conflicting managed value;
- `escapeBuiltinToolNames:true` wins over false or absent;
- a managed wire model ID applies only when the installed adapter supports that mapping; and
- user overrides may narrow values with a defined restrictive ordering but must not make a managed or live restriction more permissive.

`liveModels:false` remains a fixed user allowlist. Frogprogsy does not query `/models` or add managed model IDs to that list. A user's current default remains unchanged even when the selected managed catalog retires it; continuity inventory diagnoses the owner, explicit `replace` changes it, and an exact opt-in route policy may temporarily handle ordinary requests. `userModels` remain available until the user removes them, even if a later catalog adopts or retires the same ID.

The selected remote, cached, or bundled managed catalog is the only model-lifecycle authority. Only its exact `retiredModels` entries can retire a configured catalog-owned target. A missing live `/models` entry, model or provider name, URL, adapter, price, or family never supplies retirement evidence.

Startup reconciliation and provider creation keep registry-managed model data out of `config.json`. The merge rules instead produce the effective in-memory configuration.

## Model support status

GUI model management and `frogp models` expose two separate facts:

- **Validated**: the selected managed catalog contains compatibility data for this provider/model pair.
- **Discovered**: only the provider's live `/models` response or an explicit user addition supplied the model ID.

A discovered model remains selectable. Frogprogsy applies only protocol-wide behavior and metadata the provider actually returned. It must not guess image support, reasoning levels, context size, or model-specific request transformations.

The same surfaces report the catalog source:

- `remote`: fetched successfully during this start;
- `cached`: using the last valid remote catalog; or
- `bundled`: using the installed release snapshot.

They also report the source commit SHA and, when a remote fetch has succeeded, the last successful refresh time. Human output uses plain language; JSON output uses stable enum values and optional additive fields.

## Compatibility and validation

The catalog has two compatibility gates:

- `schemaVersion` determines whether the installed parser understands the document;
- `minFrogprogsyVersion` on the document, provider, or model record determines whether the installed runtime supports the described behavior.

Validation runs in two stages. First, a stable envelope and each record's stable `id` and `minFrogprogsyVersion` prefix are validated. Records requiring a newer runtime and providers unknown to the installed Frogprogsy are then skipped and reported. Second, the remaining compatible records receive strict unknown-field and value validation. Defaults and every cross-record reference are checked again after filtering.

Compatible selected records overlay the bundled catalog rather than deleting its safe baseline. A skipped too-new provider or model leaves the matching bundled record in place. If filtering makes a selected provider's default or references invalid, Frogprogsy rejects that selected provider record and retains its bundled provider record. Only a strictly validated, runtime-compatible retired list may remove a bundled model.

An unsupported document envelope is rejected as a whole. Unknown providers are not installed: provider URLs, adapters, and authentication remain installed code.

## Failure behavior

| Condition | Result |
| --- | --- |
| Pages cannot be reached or times out | Keep the last valid cache; otherwise use the bundled catalog. |
| HTTP status is not successful | Keep the last valid cache; otherwise use the bundled catalog. |
| JSON or schema is invalid | Reject the response without replacing the cache. |
| Document envelope requires a newer reader | Reject the response without replacing the cache. |
| Some model or provider records require a newer runtime | Skip those records, retain matching bundled records, revalidate references, and report the count. |
| Catalog revision decreases | Keep the higher-revision candidate. |
| Catalog generation time is invalid or too far in the future | Reject the response without replacing the cache. |
| Content type, decoded byte size, provider count, or model count exceeds its limit | Reject before JSON parsing or strict record validation. |
| Cache write is interrupted | The existing cache remains intact because replacement is atomic. |
| Remote data tries to change transport or authentication | Schema validation rejects the document. |

## Verification

The change is complete only when these checks pass:

1. **Generator tests**
   - fixed input produces byte-identical output;
   - changed model data without a higher revision fails publication;
   - duplicate IDs, invalid defaults, contradictory constraints, unknown fields, and forbidden sensitive fields fail generation;
   - the bundled artifact matches a fresh generation from the same inputs.

2. **Refresh tests**
   - a valid higher-revision remote catalog replaces the cache and becomes active;
   - timeout, network failure, non-success status, malformed JSON, incompatible schema, and invalid records preserve the last valid cache;
   - content-type, decoded-size, provider-count, and model-count limits reject the response before unbounded allocation;
   - too-new and invalid-after-filter records retain their matching bundled provider/model records;
   - equal revisions with different catalog digests reject the less-trusted candidate;
   - absence of both network and cache selects the bundled catalog;
   - interrupted writes do not corrupt the previous cache;
   - previous good model data republished under a higher revision replaces a bad cached catalog.

3. **Merge and migration tests**
   - live provider IDs, validated restrictions, and explicit additions combine with the specified field operations;
   - preset instances keep a stable `catalogProviderId` after renaming;
   - legacy key providers with omitted `authMode` migrate as canonical key providers;
   - managed reasoning mappings win key conflicts, preservation sets are unioned, and tool-name escaping uses `true` precedence;
   - login and service creation do not persist managed catalog fields;
   - config migration separates managed fields from `userModels` and leaves fixed allowlists unchanged;
   - user credentials, default selection, disabled models, and explicit additions remain unchanged;
   - `liveModels:false` remains unchanged and performs no live model request;
   - discovered and validated status remain deterministic.

4. **End-to-end smoke**
   - a local HTTP server serves a newer catalog;
   - starting Frogprogsy exposes its model through `/api/models`, `frogp models`, and the Claude catalog;
   - restarting without that HTTP server returns the same model from the valid cache;
   - starting with neither cache nor network uses the bundled catalog.

5. **Repository gates**
   - `bun run typecheck`;
   - `bun test --isolate ./tests`;
   - `bun run build:gui` because the GUI displays support and source status; and
   - package lifecycle checks for the exact built package;
   - every `main` push has a Pages run, and a superseded run cannot leave the latest SHA untriggered; and
   - release refuses a tarball whose bundled catalog revision or digest differs from the exact-SHA Pages catalog.

## Non-goals

- Refreshing while the proxy is already running.
- Downloading executable provider logic.
- Letting remote data change request destinations or authentication.
- Probing every model with a paid inference request.
- Declaring a provider-discovered model fully compatible without a maintained catalog record.

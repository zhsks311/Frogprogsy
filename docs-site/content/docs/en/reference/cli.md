---
title: CLI Commands
description: "Complete frogp command contract: setup, relay lifecycle, provider login, refresh, models, dashboard, recovery, update, and help."
---

This docs site is FrogProgsy's official full documentation surface. The README stays limited to first-success quickstart and project entry points; the complete command contract lives here.

`frogp` controls the local Claude Code relay. Commands fall into three groups:

- start or stop the local relay process;
- inject, refresh, or restore FrogProgsy-owned Claude Code settings, catalog entries, and cache entries;
- manage provider credentials, model visibility, dashboard access, and diagnostic output.

Help, status, plain models, model continuity reports, and version commands are read-only. `start`, `stop`, `restore`, `refresh`, `init`, `login`, `logout`, `uninstall`, and model continuity `set`/`replace` mutate local state.

## Basic syntax and common rules

```bash
frogp <command> [options]
frogp <command> --help
frogp help [command]
frogp --version
```

- Unknown commands return a failing exit code so scripts can trust command results. A close typo gets a `Did you mean: frogp <command>?` suggestion (the same suggestion engine also covers `frogp login` provider typos).
- `--help`, `-h`, or `help` after a command prints that command's usage. `frogp help <command>` prints the same usage.
- The default relay port is `10100`. `frogp start --port <port>` selects the listen port for that run.
- Claude Code injection points at the loopback relay. Restore paths remove only FrogProgsy-owned changes.

### Machine output and color

- `frogp status --json`, `frogp models --json`, and `frogp models continuity --json` are the machine-output modes. In JSON mode, stdout carries exactly one JSON document (plus trailing newline); all diagnostics go to stderr, and JSON never contains ANSI color codes.
- Human output may use a minimal ANSI palette. Color is enabled only for TTY output, disabled when `NO_COLOR` is set to a non-empty value (always wins), disabled for non-TTY/piped output by default, and forced by `FORCE_COLOR=1` unless `NO_COLOR` is also set to a non-empty value.
- Unknown options on `status`, `models`, and `models continuity` fail with exit code 1 and a usage hint on stderr.

## Setup and relay lifecycle

| Command | Mutates | Effect |
| --- | --- | --- |
| `frogp init` | config, optional Claude Code settings | Opens the provider and port setup wizard. Blank provider selection picks the documented default provider (`codex`); invalid input reprompts instead of falling into custom setup. All answers are validated before anything is written (all-or-nothing): EOF or an aborted wizard writes no config and exits non-zero. Optional Claude Code injection runs only after a validated yes. |
| `frogp start [--port <port>]` | PID guard, Claude Code catalog/cache, launcher shims | Starts the local relay, runs model discovery/catalog sync, and regenerates managed `claude`/profile launchers. If an existing PID guard matches an active relay, it exits and asks you to run `frogp stop` first. |
| `frogp refresh` | relay when needed, Claude Code catalog/cache, launcher shims | Ensures the relay is running (starting a detached one if needed), then re-syncs Claude Code config, catalog, model cache, and launchers for every configured Claude Code home. |
| `frogp stop` | process, Claude Code settings/catalog | Stops the proxy and restores native Claude Code state for every configured Claude Code home. Managed launchers stay installed and pass through to native Claude Code while the proxy is stopped. |
| `frogp restore` | Claude Code settings/catalog | Removes FrogProgsy-owned Claude Code settings/catalog entries for every configured Claude Code home while leaving a running proxy alone. Managed launchers stay installed and pass through to native Claude Code when no proxy is active. |
| `frogp uninstall` | config, Claude Code settings/catalog, launcher shims, installed package | Removes FrogProgsy local config, restores native Claude Code state, removes the config directory that contains managed launchers, and removes the global package. |
| `frogp status [--json] [--refresh-update]` | update cache only when explicitly refreshed | Prints relay health plus the shared stable-update snapshot. A healthy relay owns GET/POST update status; a stopped relay reads the local cache and only `--refresh-update` contacts npm. An unhealthy recorded PID never starts a second checker. Human output shows installed → latest and `frogp update` only for `available`. `--json` adds normalized `update` (`enabled`, `installKind`, `installedVersion`, `status`, `latestVersion`, `checkedAt`, `lastAttemptAt`, `stale`, `nextCheckAt`, `failure`) beside the fixed `watchdog` object and still prints exactly one document. |

## Provider and account

| Command | Mutates | Effect |
| --- | --- | --- |
| `frogp login --list` | none | Read-only provider discovery: prints the OAuth group (codex, xai, kimi), the API-key group, and the `openai` alias explanation, then exits 0. |
| `frogp login codex` | OAuth store, config | Creates an OpenAI Codex/ChatGPT OAuth lane. |
| `frogp login openai` | config | Saves an OpenAI API-key provider (`openai` is an alias for `openai-apikey`; ChatGPT-account login stays `codex`). |
| `frogp login xai` | OAuth store, config | Creates an xAI OAuth lane. |
| `frogp login kimi` | OAuth store, config | Creates a Kimi OAuth lane. |
| `frogp login <catalog-provider>` | config or OAuth store | Adds an API-key, OAuth, or local provider from the provider registry. A close typo gets a `Did you mean: frogp login <provider>?` suggestion. OAuth failures are reported as `Login failed for <provider>: <reason>` with retry guidance instead of a raw stack trace. |
| `frogp logout <provider>` | OAuth store | Removes the stored OAuth credential for that provider. Without an argument, or for a provider that is not logged in, it fails and lists the currently stored logins. It is not an API-key provider deletion command. |
| `frogp local-key list` | none | Lists relay access keys (id, label, request limit) and whether relay authentication is enabled. Never prints a key. |
| `frogp local-key add <label> [--limit <maxRequests>/<windowSec>]` | config | Creates a relay access key, enables `localAccess`, and prints the plaintext key once. Config keeps only its SHA-256 hash. Requires the proxy to be stopped, since a running proxy would rewrite the config from its start-time snapshot and drop the key. |
| `frogp local-key remove <id-or-label>` | config | Removes one relay access key; also requires the proxy to be stopped. Removing the last key disables relay authentication, which makes a non-loopback `hostname` refuse to start. |

Credential locations and exposure rules:

- OAuth credentials live in `~/.frogprogsy/auth.json`.
- API-key providers live in `~/.frogprogsy/config.json`.
- Prefer `${ENV_VAR}` or `$ENV_VAR` references over literal keys when editing by hand.
- Request logs, usage logs, and dashboard safe logs must not store API keys, OAuth tokens, prompt bodies, or account identities.

## Claude Code homes

| Command | Mutates | Effect |
| --- | --- | --- |
| `frogp claude list` | config migration if needed | Lists named Claude Code config homes with stable ids, target directories, injection state, and auth state. |
| `frogp claude add <name> --home <path>` | config | Adds a user-named home for a specific Claude Code config directory such as `~/.claude-work`. |
| `frogp claude rename <name-or-id> <new-name>` | config | Changes the display name while preserving the stable `cp_...` id used in headers, backups, model overlays, and status. |
| `frogp claude remove <name-or-id>` | config | Removes a non-final home. |
| `frogp claude inject|refresh|restore <name-or-id>` | target Claude Code home | Applies, refreshes, or restores only the selected home. Header injection preserves unrelated `ANTHROPIC_CUSTOM_HEADERS` entries. |
| `frogp claude reload-models <profile-id>` | target Claude Code home catalog/cache | Rebuilds the selected Claude Code home's gateway picker catalog/cache without auto-starting the proxy. If the proxy is down, it prints `frogp refresh` recovery guidance instead. |
| `frogp claude run <name-or-id> -- <claude args...>` | process env only | Low-level escape hatch that launches `claude` with `CLAUDE_CONFIG_DIR`, `ANTHROPIC_BASE_URL`, gateway discovery, and `X-Frogp-Claude-Profile` for that home. Normal use should be plain `claude` or generated aliases such as `claude-work`/`claude-personal`. |

Claude Code owns Claude subscription login. FrogProgsy never stores, imports, refreshes, logs, or displays Claude subscription OAuth tokens.

`frogp start`/`frogp refresh` generate launcher shims in `~/.frogprogsy/bin`: `claude` for the default home plus safe aliases derived from each profile name and home basename, for example `claude-work` and `claude-personal`. Put that directory before the native Claude Code binary in `PATH`, or use the package-provided `claude` bin when it wins PATH resolution. The launchers pin `FROGP_REAL_CLAUDE` to the real Claude Code executable so generated aliases do not recurse through frogprogsy or transient cmux shims. If the proxy is stopped, launchers keep only the selected Claude home env and pass through to native Claude Code.

## Models

| Command | Mutates | Effect |
| --- | --- | --- |
| `frogp models [--json]` | none | Online-only view of the running proxy's model list. Text output groups models by provider, marks catalog-backed compatibility as **Validated** and provider- or user-discovered IDs as **Discovered**, and shows whether the active model data is remote, a saved copy, or bundled with the installed release. `--json` prints the raw `GET /api/models` array unchanged, including stable `supportStatus` and `catalogSource` values. When the relay is stopped it fails with `frogp start` guidance; a recorded-but-unreachable relay points at `frogp status` / `frogp refresh`. It never synthesizes an offline model list. |
| `frogp models continuity [--json]` | none | Reads the running proxy's sorted model continuity report. Text puts affected references first and gives an executable next action. `--json` prints the `GET /api/model-continuity` document unchanged. |
| `frogp models continuity set <provider/model> --fallback <provider/model>... --auto off\|retired\|transient\|all` | config | Saves the ordered fallback targets and the automatic mode through the running proxy. Repeat `--fallback` to set the exact attempt order. |
| `frogp models continuity replace <reference-id> <provider/model>` | config and affected Claude Code model cache | Permanently replaces the model held by one reference from the current report. The reference id guards against changing a reference that moved after the report was read. |

Automatic continuity is **off by default**. `retired` moves only references whose primary model has retired, `transient` handles eligible temporary failures, and `all` enables both. Automatic continuity applies only to ordinary routed model requests. Classifier references are manual-only: you can replace one with the exact `replace` command, but classifier requests never use automatic continuity.

## Catalog and Claude Code cache

At proxy startup, FrogProgsy selects validated model data, then combines it with provider `/models` responses and explicit user settings. Restart the proxy to check for and activate newer model data. A failed check compares the last validated saved copy with the models bundled in the installed release and keeps the one with the higher catalog revision; it does not replace API keys, the selected default, disabled models, or models you added yourself. `frogp refresh` also re-syncs the resulting Claude Code-visible `provider/model` aliases and invalidates the model cache for every configured Claude Code home. `frogp claude reload-models <profile-id>` is narrower: it prepares one home's gateway picker catalog/cache without auto-starting the proxy.
`disabledModels` are excluded from the catalog and `/v1/models`; `subagentModels` are placed in the leading slots of Claude Code's subagent picker.
Claude Code refetches `/v1/models` when a session starts or resumes. Reopening an already-open `/model` screen does not hot reload the picker; start a new Claude Code session or resume so the models endpoint is fetched again. Dashboard/API model list reload is separate from Claude Code picker recovery.

## Dashboard

| Command | Mutates | Effect |
| --- | --- | --- |
| `frogp gui` | relay process when needed | Opens the local dashboard, auto-starting the proxy and waiting for it to become healthy first. The URL uses the actual active listen port. |

The dashboard is an operations surface for config, routes, safe request logs, and usage summaries. Use it with [Troubleshooting](/guides/troubleshooting/) when diagnosing failed requests.

## Recovery

| Command | Mutates | Effect |
| --- | --- | --- |
| `frogp restore` | Claude Code settings/catalog | Narrow clean restore path. |
| `frogp stop` | process + restore | Use when the relay should also be stopped. |
| `frogp uninstall` | config + restore + package | Use when removing FrogProgsy's local installation state. |

## Update, version, and help

| Command | Mutates | Effect |
| --- | --- | --- |
| `frogp update [--no-restart]` | installed package | Explicitly updates a Bun-managed install to validated stable `latest` and restarts the proxy (skip with `--no-restart`). Equal or older registry versions do not replace the package; source, unsupported, and development installs fail or provide their exact alternative. Automatic checks never call this command. |
| `frogp version` | none | Prints the installed frogprogsy version (also `--version` / `-v`). |
| `frogp help [command]` | none | Prints the full command map, or one command's usage. |
| `frogp <command> --help` | none | Prints command-specific usage. |

For eligible Bun-global stable installs, startup checks the fixed official npm stable dist-tag endpoint after
the listener is ready and uses a persisted cache window. It does not advertise preview, source,
development, or unsupported installs and never installs or restarts automatically. Set
`updateChecks.enabled` to `false` to disable ordinary checks; explicit status refresh and update remain
available.

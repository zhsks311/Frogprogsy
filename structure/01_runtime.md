# Runtime SOT

## Entrypoints

| Path | Responsibility |
| --- | --- |
| `src/cli.ts` | `frogp` / `frogprogsy` CLI: init, start, stop, restore, refresh, status, models, `models continuity`, `claude`, login/logout, gui, update, version, help, uninstall. Unknown commands and help topics get a closest-match suggestion. Owns human and JSON status/models rendering: `status --json` exposes a stable snapshot schema (fixed normalized `watchdog` fields only), `models [--json]` is an online-only view over `GET /api/models`, and `models continuity [--json]` uses the running proxy's continuity report. Continuity `set` saves exact route policy; `replace` permanently changes one validated owner. JSON modes print exactly one JSON document to stdout with diagnostics on stderr. |
| `src/server.ts` | Bun server for Claude-facing `POST /v1/messages`, `POST /v1/messages/count_tokens`, `GET /v1/models`, static GUI, and `/api/*` management endpoints, including `GET`/`POST /api/model-continuity`. The old OpenAI Responses inbound path returns `410`. |
| `src/cli-suggest.ts` | Side-effect-free typo suggestion helper (edit distance ≤ 2, order-stable ties) shared by command and `login` provider suggestions. |
| `src/cli-color.ts` | Dependency-free minimal ANSI palette for human output only: `NO_COLOR` always wins, non-TTY disables by default, `FORCE_COLOR=1` forces on; JSON output never uses it. |
| `src/init.ts` | Interactive setup wizard. Provider menu derives from `src/providers/registry.ts` via `src/providers/derive.ts`, but the default provider is the explicit `DEFAULT_INIT_PROVIDER_ID` constant (not registry order). Invalid input reprompts; the wizard is all-or-nothing — `saveConfig` runs only after every answer is validated, and EOF/aborts write nothing. |
| `src/config.ts` | `~/.frogprogsy/config.json`, defaults, PID path, env-value resolution, `websocketsEnabled()`. |
| `src/router.ts` | Provider/model selection before adapter dispatch. |
| `src/model-continuity.ts` | Exact continuity policy validation, retired-reference inventory, owner-specific permanent replacement, and the 30-second memory-only request circuit. |
| `src/types.ts` | Shared config, parsed request, adapter, and event types. |
| `src/reasoning-effort.ts` | Claude Code reasoning-level definitions (`low`/`medium`/`high`/`xhigh`), per-model effort mapping, and catalog effort sanitization. |

## Lifecycle

`frogp start` refuses a duplicate PID, starts the proxy, writes `~/.frogprogsy/frogp.pid`,
arms the default-on watchdog unless supervision is externally owned, injects settings and refreshes
models/cache for every configured Claude Code home, then serves until shutdown. Normal foreground shutdown
restores native Claude Code for configured homes.
`FROGP_EXTERNAL_SUPERVISOR=1` means Docker/systemd/Kubernetes already owns restart behavior, so
frogp skips its watchdog and avoids repeated restore/reinject churn across supervised restarts.

The bridge enforces a heartbeat stall deadline: after 5 minutes (150 ticks at the default 2 s
interval) of upstream silence with no real events, the stream is closed and the upstream request
cancelled. If the adapter generator ends without an explicit done/error event, the response is marked
`incomplete` rather than `completed` so Claude Code can distinguish a clean finish from a truncated stream.

The server exposes `POST /api/stop` which writes shutdown intent, restores every configured Claude Code home,
and exits the process. The GUI sidebar stop button calls this endpoint.

## Model continuity

`RuntimeConfigState` derives retirement only from the selected remote, cached, or bundled managed catalog's exact `retiredModels` entries. A managed default that retires stays configured so API, CLI, and the Models dashboard can diagnose it; startup never silently replaces it with a catalog default.

Automatic continuity is off by default and runs only in the ordinary `/v1/messages` attempt loop. An opted-in policy names one primary target plus at most three exact fallback `provider/model` targets in order. The router never infers targets from model names, prices, families, provider defaults, or `fallbackProviders`. A shared 30-second circuit lives only in the server process; it adds no polling, worker, or persistence.

The auto-mode classifier remains pinned to one configured target and is automatic-ineligible. Model-mixing internals, web-search and image helpers, and `subagentModels` are also diagnosis-and-permanent-replacement surfaces only; they do not use automatic continuity. Automatic attempts never mutate the persisted owner.

## Relay access control

Trust is per request, not per network position. `src/local-access.ts` owns relay authentication
(`config.localAccess`) and is the only place that decides whether a caller may use the relay:

- Keys are stored as `sha256:<hex>`; verification is a constant-time digest comparison. The plaintext
  exists only in the `frogp local-key add` / Docker-entrypoint output that created it.
- A key is presented in `x-frogp-local-key`, `x-api-key`, or `Authorization: Bearer` — the slot Claude
  Code already fills from `ANTHROPIC_AUTH_TOKEN`, so an existing client needs no new header.
- `requestLimit` is a per-key in-process sliding window (the relay is single-process); an exhausted
  window answers `429` with `Retry-After`. Windows do not survive a restart.
- `isLocalAccessSecret` marks a presented key as a relay-local credential, so `forward` authMode and the
  web-search/image fallbacks never relay it upstream as the caller's provider credential.
- Fail-closed startup (`startServer`): an enabled key list that cannot authenticate anything (empty,
  duplicate ids, malformed `secretHash`, non-positive `requestLimit`) refuses to start, and a
  non-loopback `hostname` without `localAccess` refuses to start — a published bind must authenticate,
  because `Origin`/`Host` are caller-controlled and cannot carry trust.
- When enabled, every `/api/*`, `/v1/*`, and `/usage` request is authenticated; `/healthz` and GUI assets are not.
- Same-machine tooling authenticates with a per-start token written to `~/.frogprogsy/local-access.token`
  (mode `0600`, `config.ts`), not with a configured key: reading it already implies access to the config
  directory that holds the provider credentials. The dashboard instead asks for a key and keeps it in
  sessionStorage, attached by a single `window.fetch` wrapper (`gui/src/local-key.ts`).
- `frogp local-key add`/`remove` refuse while a healthy proxy is running: the server keeps the config it
  loaded at start and rewrites the whole file on profile writes, which would drop the edit — and a created
  key's plaintext is unrecoverable.
- Per-key `providers`/`models` scopes exist in `LocalAccessKeyConfig` but no request path narrows a route
  to a key yet, so a key declaring them is rejected at startup instead of running unscoped.

## Providers and adapters

| Path | Responsibility |
| --- | --- |
| `src/providers/registry.ts` | Canonical provider presets for CLI, dashboard, OAuth, key providers, and metadata. |
| `src/providers/derive.ts` | Enrichment from provider presets into user config. |
| `src/oauth/` | Non-Anthropic OAuth providers, token storage, refresh, and auth-token resolution. Claude subscription auth remains pass-through through Claude Code homes. |
| `src/adapters/openai-responses.ts` | OpenAI/ChatGPT Responses upstream adapter. |
| `src/adapters/openai-chat.ts` | OpenAI-compatible Chat Completions bridge. |
| `src/adapters/anthropic.ts` | Anthropic Messages bridge. |
| `src/adapters/google.ts` | Gemini bridge. |
| `src/adapters/azure.ts` | Azure OpenAI bridge. |

Adapter output must stay in internal `AdapterEvent` form until `messages/bridge.ts` converts it back to
Anthropic Messages SSE for Claude Code.

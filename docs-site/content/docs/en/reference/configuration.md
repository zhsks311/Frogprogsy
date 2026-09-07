---
title: Configuration
description: "Complete FrogProgsy config.json contract: relay defaults, provider lanes, model catalog controls, reasoning/capability gates, capability fallbacks, and safe operations."
---

This docs site is FrogProgsy's official full documentation surface. The README stays limited to first-success quickstart; the field contract for `~/.frogprogsy/config.json` lives here.

FrogProgsy reads `~/.frogprogsy/config.json` on startup. The setup wizard and dashboard write this file, but it remains plain JSON and can be edited directly. If the file is missing or invalid, FrogProgsy falls back to a single Anthropic forward provider.

Public schema names used by the dashboard and docs are `ProviderConfig` and `WebSearchFallbackConfig`.

## Files and write rules

| Path | Role |
| --- | --- |
| `~/.frogprogsy/config.json` | Relay, provider, catalog, and capability fallback settings. |
| `~/.frogprogsy/auth.json` | OAuth provider access/refresh token store. |
| `~/.frogprogsy/claude-profiles/<cp_id>/claude-settings-backup.json` | Per-profile restore backup for FrogProgsy-owned Claude Code settings. |
| `~/.frogprogsy/model-aliases.json` | Claude Code-visible routed model alias map. |
| `~/.frogprogsy/cache/update-status-v1.json` | Strict mode-restricted stable-update attempt/success cache; contains no user or machine identifier. |

FrogProgsy writes config and backup files with temp-file + rename. Prefer `${ENV_VAR}` or `$ENV_VAR` references over literal API keys.

## Runtime type anchors

The JSON fields map to the runtime `ProviderConfig` objects under `providers.*` and the `WebSearchFallbackConfig` object under `webSearchFallback`. Keep those public type names stable when updating configuration examples.

## Top-level fields

| Field | Type | Default | Role |
| --- | --- | --- | --- |
| `port` | `number` | `10100` | Local relay listen port. |
| `hostname` | `string` | `"127.0.0.1"` | Bind hostname. Use `0.0.0.0` only when deliberately exposing the relay on all interfaces. |
| `localAccess` | object | — | Relay access keys. `{ enabled, keys }`; each key stores `id`, `secretHash` (`sha256:<hex>`), optional `label` and `requestLimit`. See [Relay access keys](#relay-access-keys). |
| `updateChecks` | object | enabled when absent | Stable npm metadata checks. Set exactly `{ "enabled": false }` to disable ordinary startup checks; explicit refresh and `frogp update` remain available. |
| `providers` | object | fallback provider | Named provider lanes. Each key becomes a route prefix. |
| `defaultProvider` | `string` | `"anthropic"` | Routing fallback lane when the requested model id has no provider prefix. |
| `subagentModels` | `string[]` | default GPT native list | Up to five routed/native model ids shown first in Claude Code's subagent picker. Setting `[]` is respected. |
| `disabledModels` | `string[]` | — | Routed models hidden from injected catalog and `/v1/models`. |
| `modelContinuity` | object | — (`off`) | Exact, opt-in fallback policies for ordinary routed model requests. See [Model continuity](#model-continuity). |
| `modelCacheTtlMs` | `number` | `300000` | Provider `/models` cache freshness window. |
| `stallTimeoutSec` | `number` | `90` | Seconds of upstream data silence before an incomplete/error close; minimum `1`. |
| `connectTimeoutMs` | `number` | `30000` | Upstream DNS/TCP/TLS/response-header timeout in milliseconds. |
| `webSearchFallback` | object | auto when a compatible forward/key provider exists | Hosted web-search helper settings. |
| `imageFallback` | object | auto when a compatible forward/key provider exists | Image-description helper settings for text-only lanes. |
| `autoModeClassifier` | object | — | One explicit `{ provider, model }` target for the reserved Claude Code 2.1.220 auto-mode review alias. |
| `modelMixing` | object | — | Model mixing behind the `frogp/mix` alias (route/fusion/pipeline). Disabled unless `enabled: true`. See [Model mixing fields](#model-mixing-fields). |
| `websockets` | `boolean` | `false` | Legacy ignored compatibility field; the Claude Messages data plane uses HTTP/SSE. |
| `syncResumeHistory` | `boolean` | `false` | Legacy ignored/no-op; FrogProgsy does not touch Claude Code history. |


Only canonical Bun-global stable installs use automatic checks. One persisted attempt suppresses another
ordinary check for the cache window; explicit refresh may bypass it. The endpoint, deadline, and response
limit are not configurable. No credential, prompt, provider config, Claude state, or telemetry is sent.
Cache failure leaves the proxy healthy and limits throttling to the current process.

## Model continuity

`modelContinuity` maps an exact ordinary route to up to three exact fallback targets, in attempt order:

```json
{
  "modelContinuity": {
    "anthropic/claude-old": {
      "fallbacks": ["anthropic/claude-new"],
      "automatic": "off"
    }
  }
}
```

`automatic` has four modes:

- `off`: report the problem and keep the request on the selected model;
- `retired`: use the saved fallbacks only when the managed catalog has retired the selected model;
- `transient`: use them only after an eligible connection, header-timeout, HTTP 404/410/429, or HTTP 5xx failure; and
- `all`: enable both retired-model and transient-failure handling.

Missing configuration defaults to `off`. Every key and fallback is an exact `provider/model`; FrogProgsy never infers targets from names, families, prices, provider defaults, or `fallbackProviders`. Automatic continuity applies only to ordinary routed model requests. The auto-mode classifier, model-mixing internals, web-search and image helpers, and `subagentModels` are manual-replacement-only.

A transient failure opens a 30-second, memory-only circuit for the exact primary target. FrogProgsy adds no health polling or persisted circuit state. Automatic attempts never rewrite the configured owner; only an explicit permanent replacement does that. See the [CLI reference](/Frogprogsy/reference/cli/#models) and [Models dashboard workflow](/Frogprogsy/guides/web-dashboard/#replacing-models-that-have-ended).

## Relay access keys

`localAccess` is request-scoped authentication for the relay. When `enabled` is `true`, every `/api/*`, `/v1/*`, and `/usage` request must present a configured key; `/healthz` and the dashboard assets stay open.

- Send the relay key in the dedicated `x-frogp-local-key` header by default. `x-api-key` and `Authorization: Bearer <key>` remain accepted for compatible clients, but a `forward` provider needs those slots for its real upstream credential. Keep that credential in place; do not replace it with the relay key.
- Config stores only `sha256:<hex>` of a key. The plaintext is printed once, when `frogp local-key add` creates it, and cannot be recovered afterwards.
- `requestLimit` is a per-key sliding window enforced in the relay process; an exhausted window answers `429` with `Retry-After`.
- A presented key is never relayed upstream, so a `forward` lane still forwards only a real caller provider credential.
- Same-machine tooling does not need the configured key: the running relay writes a per-start token to `~/.frogprogsy/local-access.token` (mode `0600`). The CLI sends that unrestricted token only to a loopback destination; wildcard binds are reached through loopback. The token is not stored in config and does not survive a restart.
- A non-loopback `hostname` requires at least one key. On the first Docker start, set `FROGP_LOCAL_ACCESS_KEY` through the container environment or secret configuration; the entrypoint stores only its hash and never prints the plaintext. A persisted volume with an existing enabled key restarts without the environment value.
- Per-key `providers`/`models` scopes are not enforced yet; a key that declares them is rejected at startup rather than silently unscoped.

```json
{
  "hostname": "0.0.0.0",
  "localAccess": {
    "enabled": true,
    "keys": [
      {
        "id": "lk_9f2c41ab",
        "label": "laptop",
        "secretHash": "sha256:2c26b46b68ffc68ff99b453c1d30413413422d706483bfa0f98a5e886266e7ae",
        "requestLimit": { "windowSec": 60, "maxRequests": 120 }
      }
    ]
  }
}
```

## Provider lane fields

Each `providers` key is a route namespace. For example, model `qwen/qwen3-coder` in provider `openrouter` is exposed to Claude Code as `openrouter/qwen/qwen3-coder`.

| Field | Type | Role |
| --- | --- | --- |
| `adapter` | string | One of `openai-chat`, `openai-responses`, `anthropic`, `google`, or `azure-openai`. `azure` is accepted as a legacy alias. |
| `baseUrl` | string | Upstream API base URL. |
| `authMode` | `"key" \| "oauth" \| "forward"` | Authentication mode. Defaults to `key`. |
| `apiKey` | string | Literal key or `${ENV_VAR}` / `$ENV_VAR` reference. |
| `headers` | object | Extra static upstream headers. Do not use this to bypass credential handling. |
| `defaultModel` | string | Provider-owned short model id used for provider/default fallback routing. |
| `models` | string[] | Seed/fallback model list; exact allowlist when `liveModels` is `false`. |
| `liveModels` | boolean | Whether start/sync fetches live `/models`; default `true`. |
| `contextWindow` | number | Provider-wide Claude-visible context cap. |
| `modelContextWindows` | object | Model-specific context cap. It caps downward and does not raise live metadata. |
| `modelCapabilities` | object | Provider/model capability map, for example `{ "model-a": { "input": ["text", "image"] } }`; `imageFallback` can be `reject` or `describe`. |
| `reasoningEfforts` | string[] | Provider-wide Claude Code-visible reasoning tiers: `low`, `medium`, `high`, `xhigh`. |
| `modelReasoningEfforts` | object | Model-specific visible reasoning tiers. Empty arrays hide effort choices. |
| `reasoningEffortMap` | object | Claude Code effort label to upstream wire value mapping. |
| `modelReasoningEffortMap` | object | Model-specific effort mapping. |
| `noReasoningModels` | string[] | Models that must not receive reasoning/thinking parameters. |
| `noTemperatureModels` | string[] | Models that reject caller temperature. |
| `noTopPModels` | string[] | Models that reject caller `top_p`. |
| `noPenaltyModels` | string[] | Models that reject presence/frequency penalties. |
| `autoToolChoiceOnlyModels` | string[] | Models whose forced/named tool choice must be lowered to `auto` or `none`. |
| `preserveReasoningContentModels` | string[] | Chat models that need assistant `reasoning_content` preserved in history. |
| `escapeBuiltinToolNames` | boolean | Anthropic-compatible gateways that need built-in tool names prefixed on the wire and stripped on return. |

## Auth modes

| Mode | Contract |
| --- | --- |
| `key` | Sends `apiKey` or its env reference upstream as Bearer/API-key material. Most API-key catalog providers use this mode. |
| `oauth` | Resolves and refreshes a stored OAuth token from `~/.frogprogsy/auth.json`, then sends it as Bearer auth. |
| `forward` | Copies only allowlisted upstream-compatible auth headers from the incoming Claude Code request. Used by Anthropic and OpenAI Responses lanes. |

## Auto-mode review routing

Claude Code 2.1.220 uses separate Sonnet 5 side queries for auto-mode safety review. FrogProgsy does not identify
those requests by a Sonnet/Haiku model name or by inspecting the prompt: the HTTP body has no trustworthy
auto-mode marker.

Configure one target:

```json
{
  "autoModeClassifier": {
    "provider": "codex",
    "model": "gpt-5.4-mini"
  }
}
```

Then enable **Route auto-mode reviews** on each Claude Code home that should use it. FrogProgsy makes that home
send both review stages with the exact `claude-frogp-auto-classifier` alias and routes only that alias to the
configured target. Generic provider fallback, long-context routing, and model mixing do not apply.

Provider and model are both required. Missing providers, disabled models, and models absent from a non-empty known
catalog are rejected. The target cannot be cleared while an opted-in home still depends on it.

Two client boundaries matter:

- A 404/429 or connection failure can make Claude Code retry and fall back to the current main model. This is
  Claude Code behavior, not a FrogProgsy fallback.
- The opt-in uses `ANTHROPIC_DEFAULT_SONNET_MODEL`, which also controls Claude Code's built-in `sonnet` shortcut.
  While enabled, switch the main model with an exact gateway catalog entry, not that shortcut. Restart or resume
  an existing Claude Code session after changing the home setting.

The route was verified against Claude Code 2.1.220 and must be re-verified when the client implementation changes.
Use `claude auto-mode defaults` / `claude auto-mode config` to inspect or tune Claude Code's policy itself.

## Model capability fields

FrogProgsy uses per-provider `modelCapabilities` to keep Claude Code catalog hints and image fallback behavior aligned.

```json
{
  "providers": {
    "ollama-cloud": {
      "adapter": "openai-chat",
      "baseUrl": "https://ollama.com/v1",
      "apiKey": "${OLLAMA_API_KEY}",
      "modelCapabilities": {
        "glm-5.2": { "input": ["text"], "imageFallback": "describe" },
        "qwen3-vl": { "input": ["text", "image"] }
      }
    }
  }
}
```

- `modelCapabilities.<model>.input` controls input modality hints shown in the Claude Code model picker/catalog.
- If an image request targets a text-only model and `imageFallback.enabled` is true, the helper can convert images to text descriptions.
- Unknown models are tried natively first; classify only models whose input behavior is known.

## Static catalog lane

Use `liveModels: false` when a provider catalog is too large or slow and Claude Code should see only pinned models.

```json
{
  "providers": {
    "openrouter": {
      "adapter": "openai-chat",
      "baseUrl": "https://openrouter.ai/api/v1",
      "apiKey": "${OPENROUTER_API_KEY}",
      "liveModels": false,
      "models": ["deepseek/deepseek-v4-flash", "qwen/qwen3-coder-plus"]
    }
  }
}
```

If `liveModels` is `false` and `models` is empty, the provider exposes no routed models.

## Capability fallback fields

`webSearchFallback` and `imageFallback` are helper paths inside the relay process, not separate daemons. Both can activate automatically when a compatible OpenAI Responses forward/key provider exists.

| Field | Applies to | Role |
| --- | --- | --- |
| `enabled` | both | Master switch. When omitted, compatibility with an available forward/key provider decides. |
| `model` | both | Helper model id. |
| `timeoutMs` | both | Helper fetch timeout in milliseconds. |
| `reasoning` | web search | Reasoning effort sent to the hosted-search helper; prefer light values such as `low` or `minimal`. |
| `maxSearchesPerTurn` | web search | Loop guard for hosted searches in one main-model turn. |

## Model mixing fields

`modelMixing` puts several providers/models behind the `frogp/mix` alias. It is disabled unless `enabled: true`, and it is never the auto-mode safety classifier. See the [Model Mixing](/guides/model-mixing/) guide for worked examples.

| Field | Type | Role |
| --- | --- | --- |
| `enabled` | boolean | Master switch. Default false; when off, routing is unchanged and `frogp/mix` is not advertised. |
| `aliasId` | string | Model id that triggers mixing. Default `frogp/mix`. |
| `mode` | string | `coordinator` (an LLM picks using `guidance`) or `rules` (deterministic table, no extra call). Default `coordinator`. |
| `combine` | string | `route` (pick one), `fusion` (panel + judge + synthesizer), or `pipeline` (thinker → worker → verifier). Default `route`. |
| `coordinator` | object | `{ provider, model }` used to choose in route/coordinator mode and as the default fusion judge/synthesizer. |
| `agents` | array | Roster of `{ provider, model, tasks?, difficulty?, role?, notes? }` the coordinator may choose from; also the default fusion panel. |
| `guidance` | string | Natural-language routing guidance the coordinator reads. |
| `fusion` | object | `{ panel?: [{provider,model}] (1–8), judge?: {provider,model}, synthesizer?: {provider,model}, contextMode?: "task"|"full", judgeContextMode?: "task"|"full", panelWebSearch?: {...}, multiround?: {...} }`. Judge/synthesizer default to `coordinator`; panel defaults to `agents`. `contextMode`, `judgeContextMode`, `panelWebSearch`, and `multiround` are experimental pending frozen-suite acceptance. |
| `fusion.contextMode` | `"task"` \| `"full"` | Experimental. Panel prompt context: `task` preserves the latest-user-message-only prompt bytes; `full` embeds the system prompt and full message history. Default `task`. |
| `fusion.judgeContextMode` | `"task"` \| `"full"` | Experimental. Judge prompt context: `task` or `full`, independent from `fusion.contextMode`. Default `task`, even when panel context is `full`. |
| `fusion.panelWebSearch` | object | Experimental. Default disabled; active only when `enabled: true`. Panel-only synthetic/internal web search: `{ enabled?, maxSearchesPerPanel?, maxTotalSearches?, timeoutMs?, tiers? }`. `tiers` may contain only `fallback_model`, `search_api`, and `no_key`. It applies only to fusion panel members, never to judge/synthesizer and never as a client-visible tool. |
| `fusion.multiround` | object | Experimental. Default disabled; active only when `enabled: true`. Bounded branch/refine/score loop: `{ enabled?, maxRounds?, branchFactor?, budgetCalls? }`. When enabled, defaults start at `maxRounds: 2`, `branchFactor: 2`, and `budgetCalls: 12`. `budgetCalls` is a hard cap for answer/scoring calls; exceeding it triggers a loud fallback instead of silent extra work. |
| `pipeline` | array | Ordered `[{ role: "thinker"|"worker"|"verifier", provider, model }]` chain (deduped, capped at 3). |
| `rules` | array | Deterministic table `[{ match?: { taskKeywords?, difficulty?, hint? }, provider, model }]` matched (case-insensitive substring) against the task text; first match wins. |
| `surfaceStages` | boolean | Stream intermediate stages as live `thinking` blocks. Default true (opt out with false). |
| `timeoutMs` / `stageTimeoutMs` / `panelTimeoutMs` | number | Per-call / buffered pre-final stage / buffered panel-member timeouts. Default 15000. `stageTimeoutMs` and `panelTimeoutMs` apply only to buffered panel/judge/pipeline pre-final calls; they do not bound the final streamed synthesizer, which is governed only by client abort and SSE idle handling. |

Every degraded path is loud (a warning is logged), never silent, and the Claude Code-facing model id stays `frogp/mix`.

## Full example

```json
{
  "port": 10100,
  "hostname": "127.0.0.1",
  "defaultProvider": "anthropic",
  "providers": {
    "anthropic": {
      "adapter": "anthropic",
      "baseUrl": "https://api.anthropic.com",
      "authMode": "forward",
      "defaultModel": "claude-sonnet-4-6"
    },
    "openai-forward": {
      "adapter": "openai-responses",
      "baseUrl": "https://api.openai.com/v1",
      "authMode": "forward",
      "defaultModel": "gpt-5.5"
    },
    "codex": {
      "adapter": "openai-responses",
      "baseUrl": "https://chatgpt.com/backend-api/codex",
      "authMode": "oauth",
      "defaultModel": "gpt-5.5"
    },
    "ollama-cloud": {
      "adapter": "openai-chat",
      "baseUrl": "https://ollama.com/v1",
      "apiKey": "${OLLAMA_API_KEY}",
      "defaultModel": "glm-5.2",
      "models": ["glm-5.2", "gpt-oss", "qwen3-coder"],
      "modelCapabilities": {
        "glm-5.2": { "input": ["text"], "imageFallback": "describe" },
        "gpt-oss": { "input": ["text"], "imageFallback": "reject" },
        "qwen3-coder": { "input": ["text", "image"] }
      },
      "noReasoningModels": ["gpt-oss"]
    }
  },
  "subagentModels": ["anthropic/claude-sonnet-4-6", "ollama-cloud/glm-5.2"],
  "disabledModels": ["ollama-cloud/experimental-model"],
  "autoModeClassifier": {
    "provider": "codex",
    "model": "gpt-5.4-mini"
  },
  "webSearchFallback": {
    "enabled": true,
    "model": "gpt-5.5",
    "reasoning": "low",
    "maxSearchesPerTurn": 3,
    "timeoutMs": 30000
  },
  "imageFallback": {
    "enabled": true,
    "model": "gpt-5.5",
    "timeoutMs": 30000
  }
}
```

## Safe restore expectations

`frogp restore`, `frogp stop`, and `frogp uninstall` remove only Claude Code settings/catalog entries that FrogProgsy wrote. They do not delete unrelated Claude Code settings, history, or credentials. If state is tangled, follow the clean restore path in [Troubleshooting](/guides/troubleshooting/).

# Provider model audit: 2026-11-17

This inventory records provider-owned evidence collected on 2026-11-17. Public discovery does not prove account entitlement or a successful inference call. Credential-gated and legacy-route limitations below are explicit holds, not retirement evidence. No user credentials or native Claude settings were changed.

## Applied decisions and remaining gates

The registry/catalog update applies the current model data for Codex, OpenAI API key,
Claude, Google, Kimi OAuth, Kimi Code key, Umans, Neuralwatt, DeepSeek, Moonshot,
Z.AI, Ollama Cloud, Mistral, MiniMax global and Xiaomi. OpenRouter uses its exact
provider-owned full snapshot. Cerebras drops explicitly removed Shared Gemma;
adding Qwen remains gated on reasoning replay compatibility. All other entries retain
account/environment discovery or their existing route pending the evidence below.

The reports below distinguish observed facts from recommendations. A recommendation
is not a claim that its model or runtime change was implemented. In particular,
xAI API-key docs do not establish OAuth entitlement, MiniMax CN's new hostname is
not substituted, OpenCode legacy transport is not silently migrated, and Azure/
Parallel discovery fixes are separate runtime work. Neuralwatt's legacy GLM 5.2
default remains selectable without claiming public entitlement. Old GPT fallback IDs
are retained because this audit does not establish their retirement on the Codex route.

## Maintained routes

## Summary

Read-only audit completed. No credentials, inference calls, edits, builds, or tests.

**Strongest evidenced updates:** Umans lifecycle/model replacement; DeepSeek Flash replacement; Cerebras Shared Inference replacement; Kimi coding-plan additions; Moonshot additions/restrictions; Z.AI Flash addition; Neuralwatt/Ollama public inventory refresh; Xiaomi retirement/replacement; global MiniMax M3.1 Flash.

**Important holds:** xAI OAuth availability is not established by API-key documentation; MiniMax CN documentation now specifies a different hostname; OpenCode’s new cross-protocol gateway documentation does not prove identical behavior on the registry’s legacy Chat URLs.

## Files / architecture

All paths relative to the assigned worktree.

- `structure/10_remote-model-catalog.md:90-133`: explicit membership, route-specific verification, retirement versus unmanaged, output limits as notes only.
- `src/providers/registry.ts:68-128`: shared Kimi, Moonshot, Neuralwatt, Umans constants.
- `src/providers/registry.ts:170-237`: xAI.
- `src/providers/registry.ts:321-345,875-898`: Kimi OAuth / API-key entries.
- `src/providers/registry.ts:383-539`: Umans, OpenCode Go, Neuralwatt.
- `src/providers/registry.ts:631-762`: DeepSeek, Cerebras, Moonshot, Z.AI.
- `src/providers/registry.ts:773-874`: Ollama Cloud, Mistral, MiniMax global/CN.
- `src/providers/registry.ts:899-912`: OpenCode Zen, Xiaomi.
- `src/adapters/openai-chat.ts:239-267`: catalog restrictions shape sampling, penalties, effort, tool choice; `stop` is forwarded unconditionally.
- `scripts/generate-model-catalog.ts:4`: delegates generation to `src/model-catalog-generator`.

Registry membership/metadata feed the generated catalog. Transport/authentication remain installed-runtime responsibilities. Endpoint migrations, missing request transformations, and new reasoning dialects cannot be fixed by remote model data.

## Report

Notation: **T** = text input; **TI** = text/image input. Effort values below are provider wire values unless explicitly described as catalog values. No absence-based retirements.

### 1. xAI — OAuth provider

Sources: [models](https://docs.x.ai/developers/models), [4.7](https://docs.x.ai/developers/models/grok-4.7), [4.6](https://docs.x.ai/developers/models/grok-4.6), [reasoning](https://docs.x.ai/developers/model-capabilities/text/reasoning), [retirements](https://docs.x.ai/developers/migration/may-15-retirement), [multi-agent](https://docs.x.ai/developers/model-capabilities/text/multi-agent).

- API documentation confirms **`grok-4.7`, `grok-4.6`**: **500,000**, TI, `low/medium/high/xhigh`, default high, thinking cannot be disabled.
- Reasoning models reject presence/frequency penalties **and `stop`**. Catalog can represent penalties, but not the stop restriction; current Chat adapter forwards stop.
- Existing `grok-4.5`: 500,000; `grok-4.3` and dated 4.20 reasoning/nonreasoning: 1,000,000; `grok-build-0.1`: 256,000 remain on current pricing.
- Explicit additional retired API slugs: **`grok-4-1-fast-reasoning`, `grok-4-fast-reasoning`, `grok-4-0709`**, effective May 15. They redirect rather than necessarily failing.
- Current multi-agent documentation names **`grok-4.20-multi-agent`**; pricing names **`grok-4.20-multi-agent-0309`**. These do **not** establish the registry’s `grok-4.20-multi-agent-beta-latest` alias. Documented examples use Responses.
- `/v1/models`: **401** without authentication.
- **Recommendation:** do not silently promote API-key metadata into this OAuth entry. Exact OAuth entitlement/model inventory remains unknown. Grok Build documentation identifies `cli-chat-proxy.grok.com` for inference, not the registry’s `api.x.ai/v1`; common branding/account login is insufficient proof. Keep proposed 4.6/4.7 additions conditional on OAuth-route evidence. No invented beta-alias retirement.

### 2. `kimi` — OAuth

Source: [Kimi Code model configuration](https://www.kimi.com/code/docs/en/kimi-code/models.html).

The provider documents official signed-in clients separately from third-party API keys, but publishes one Kimi Code model table:

| Exact ID | Maximum context | Input | Effort |
|---|---:|---|---|
| `k3.1-pro` | 1,048,576, plan-gated | TI | low/high/max |
| `k3.1-pro-highspeed` | 1,048,576, plan-gated | TI | low/high/max |
| `k3` | 1,048,576, plan-gated | TI | low/high/max |
| `k3-256k` | 262,144 | TI | low/high/max |
| `kimi-for-coding` | 1,048,576 | TI | low/high/max |
| `kimi-for-coding-highspeed` | 262,144 | TI | No adjustable effort |

- `kimi-for-coding` now means **K2.8 Preview**, not the prior non-adjustable model.
- K3.1 Pro rejects disabled thinking. Other listed families route thinking-off requests to K2.8 Preview without thinking.
- Official mappings: `xhigh/max/ultra→max`, `medium/high→high`, `minimum/light/low→low`.
- 1M context for K3/K3.1 requires Pro or higher/new plans, Allegretto or higher/legacy plans; lower eligible tiers do not automatically receive 1M.
- **Recommendation:** add both K3.1 IDs; change `kimi-for-coding` from no-effort to adjustable effort; correct documented upper bounds while preserving plan caveats. Official-client documentation supports product-level membership, **not this account’s entitlement or observed OAuth response**.
- Public coding `/models`: **401**. Output caps/sampling/tool-choice restrictions not established by this page. No retirements announced.

### 3. `kimi-code` — API key

Same [provider page](https://www.kimi.com/code/docs/en/kimi-code/models.html), independently explicit third-party configuration:

- Exact registered base URL **`https://api.kimi.com/coding/v1`** is documented for China; overseas base is different.
- All six IDs and fields in the preceding table apply explicitly to third-party API-key requests.
- **Supported changes:** same additions/context/effort corrections as above, without borrowing Moonshot API limits.
- Preserve `kimi-for-coding-highspeed` as non-adjustable, despite always-on thinking.
- `/models` **401**; account access unknown. No retirement evidence.

### 4. Umans

Sources: [public models](https://api.code.umans.ai/v1/models), [public metadata](https://api.code.umans.ai/v1/models/info), [Messages-route documentation and retirements](https://app.umans.ai/offers/code/docs).

**Complete current public inventory:**

| Exact ID | Context | Input | Wire effort | Output note |
|---|---:|---|---|---:|
| `umans-coder` | 1,048,576 | TI | none/low/high/max | 393,216 |
| `umans-flash` | 262,144 | TI | none/low/high/max | 262,144 |
| `umans-deepseek-v4.1-flash` | 1,048,576 | TI | none/low/high/max | 393,216 |
| `umans-deepseek-v4.1-flash-1017` | 1,048,576 | TI | none/low/high/max | 393,216 |
| `umans-glm-5.3` | 1,048,576 | T | low/high/max; mandatory | 131,072 |
| `umans-kimi-k3.1-pro` | 1,048,576 | TI | none/low/high/max | 131,072 |

- `umans-coder`/`umans-flash` now both target DeepSeek V4.1 Flash.
- Kimi sampling fields are fixed server-side; retain/add no-temperature and no-top-p restrictions for **the new exact Kimi ID**.
- `xhigh→max` is the appropriate existing catalog normalization; remove unsupported advertised `medium` where the live per-model ladder excludes it.
- Messages route accepts explicit thinking budgets and also `reasoning_effort`; do not switch Umans to Anthropic-native adaptive effort merely because its metadata lists effort tiers.

**Explicit retirements:**
- `umans-kimi-k3`: November 9; ID redirects to K3.1 Pro.
- `umans-glm-5.2`, `umans-kimi-k2.7`: September 10.
- `umans-deepseek-v4-pro-0813`: September 14.
- `umans-glm-5.3-flash`, `umans-deepseek-v4-flash-0731`, `umans-qwen3.6-35b-a3b`: November 1; temporary routing grace does not negate retirement.

**Recommendation:** update membership and all above metadata; retire the explicitly named old IDs. Existing `umans-coder` default can remain.

### 5. OpenCode Go — legacy Chat boundary

Sources: [exact registered `/models`](https://opencode.ai/zen/go/v1/models), [Go documentation](https://opencode.ai/docs/go/), [current gateway protocol guarantees](https://opencode.ai/docs/console/harnesses).

**Exact public inventory, 32 IDs:**

```text
deepseek-v4.1-flash deepseek-v4-pro glm-5.2 glm-5.3 grok-4.7
muse-spark-1.2-contributor muse-spark-1.3-contributor glm-5.3-flash
gpt-5.6-luna gpt-6-luna claude-haiku-5-5 hy3 hy4-preview
kimi-k2.7-code kimi-k3 mimo-v2.6-flash mimo-v2.6-pro
minimax-m3 minimax-m3.1-flash longcat-2.0 step-5-preview beam-free
qwen3.8-max qwen3.8-flash qwen3.7-plus kimi-k3.1-pro
iceman-contributor-free gemini-4-argon hy4 longcat-2.5-free
hy4-flash-free qwen4-max
```

Selected directly advertised **Chat-native** metadata:

| IDs | Context | Input | Effort |
|---|---:|---|---|
| `deepseek-v4.1-flash` | 1,000,000 | TI | low/high/max |
| `deepseek-v4-pro` | 1,000,000 | T | high/max — **not low** |
| `glm-5.2` | 1,000,000 | T | high/max |
| `glm-5.3` | 1,000,000 | T | low/high/max |
| `glm-5.3-flash` | 1,000,000 | TI | low/high/max |
| `hy3` | 256,000 | T | none/low/high |
| `hy4-preview` | 1,024,000 | T | none/high |
| `kimi-k2.7-code` | 262,144 | TI | Not published |
| `kimi-k3` | 1,048,576 | TI | **max only** |
| `kimi-k3.1-pro` | 1,048,576 | TI | low/high/max |
| `mimo-v2.6-flash`, `mimo-v2.6-pro` | 1,048,576 | TI | Not published |
| `minimax-m3.1-flash` | 1,000,000 | TI | low/medium/high/xhigh/max |
| `longcat-2.0` | 1,000,000 | T | Toggle only |
| `step-5-preview` | 1,000,000 | TI | low/medium/high |
| `beam-free` | 1,048,576 | T | low/medium/high/xhigh/max |
| `iceman-contributor-free` | 262,144 | T | Not published |
| `hy4`, `hy4-flash-free` | 1,048,576 | TI | none/high |
| `longcat-2.5-free` | 1,000,000 | TI | Toggle only |

Restrictions:
- GLM rows, MiMo rows, M3.1 Flash: tool choice lists **auto only**.
- K2.7 Code: auto/none; K3/K3.1: auto/none/required.
- All three Kimi rows publish `temperature:false`, `top_p:false`; LongCat 2.5 publishes temperature false.
- DeepSeek and several other Chat-native rows explicitly use `reasoning_content`.
- Go requires stable session identity, suitable client user-agent, coding-agent traffic. Privacy/region settings can block DeepSeek or contributor models; free Go models may be temporary.
- `mimo-v2.5`/`mimo-v2.5-pro` remain named in Go documentation despite omission from live inventory: **do not retire them from absence**.

**Boundary:** public JSON now advertises inference URLs under `/inference/go/...`. Current documentation says **all paid/Go text models work across protocols through translation**, so a native Responses/Messages entry is **not proof of Chat incompatibility**. However, equivalence of legacy `/zen/go/v1/chat/completions` to that new gateway was not established. Do not blindly import all 32 as validated on the legacy route or change the base URL through catalog data. No explicit Go retirement notices found.

### 6. OpenCode Zen

Sources: [exact registered `/models`](https://opencode.ai/zen/v1/models), [current model/endpoints documentation](https://opencode.ai/docs/zen/), [harness restrictions](https://opencode.ai/docs/console/harnesses).

- Public inventory works and includes models with native Chat, Responses, Messages, and Gemini APIs.
- New gateway explicitly translates **paid text models** across those APIs; do not exclude paid Claude/GPT/Gemini solely because the native API differs.
- **Free-tier Chat models are OpenCode-client-only; other harnesses receive HTTP 403 even with a key.** This includes free rows visible in `/models`; public discoverability ≠ Frogprogsy usability.
- Decision models use `/systemone`, not text generation.
- Registry has no maintained Zen inventory/default. **Recommendation:** do not create a blanket validated inventory from the public response. Exact legacy Chat translation, session behavior, and model-specific translated restrictions remain unknown. New `/inference/openai/v1` transport is a separate runtime change, not catalog data.
- No retirement inferred from list differences.

### 7. Neuralwatt

Sources: [public `/models`](https://api.neuralwatt.com/v1/models), [metadata contract](https://portal.neuralwatt.com/docs/api/models), [tracking aliases](https://docs.neuralwatt.com/guides/tracking-aliases.md).

Response explicitly says **`scope:"public"`**. Public/customer catalogs differ.

The following pairs were independently present; `(+ -flex)` means both exact base ID and its `-flex` ID were observed.

| IDs | Context | Input | Distinct wire levels |
|---|---:|---|---|
| `qwen-3.8-27b` (+ `-flex`) | 262,128 | TI | none/low/medium/xhigh |
| `nw-small` (+ `-flex`) | 262,128 | TI | none/low/medium/xhigh |
| `mimo-v2.6-pro` (+ `-flex`) | 1,048,560 | TI | none/high |
| `deepseek-v4.1-flash` (+ `-flex`) | 1,048,560 | TI | none/low/high/xhigh/max |
| `nw-flash` (+ `-flex`) | 1,048,560 | TI | none/low/high/xhigh/max |
| `glm-5.3` (+ `-flex`) | 1,048,560 | T | low/high/max; mandatory |
| `glm-5.3-flash` (+ `-flex`) | 1,048,560 | TI | low/high/max; mandatory |
| `qwen3.6-35b` (+ `-flex`) | **262,128** | TI | none/high |
| `qwen3.6-35b-fast` | **262,128** | TI | none only |
| `gemma-4-31b` | 262,128 | TI | none/max |
| `kimi-k3.1-pro` (+ `-flex`) | 1,048,560 | TI | none/low/**medium**/high/max |
| `nw-large` (+ `-flex`) | 1,048,560 | TI | none/low/medium/high/max |

- Also present: `deepseek-v4.1-flash-speed`, same limits/efforts, **explicit private-preview description**. Do not promote it as generally available.
- All observed rows have `deprecated:false`.
- Output notes: Qwen3.8/nw-small 131,072; MiMo/DeepSeek/nw-flash 393,216; Gemma 16,384; other rows publish null, documented as **no separate output cap**, not a guessed numeric cap.
- Exact alias mappings matter: Qwen3.8 `high→xhigh`; GLM `xhigh→max`, `medium→high`; K3.1 `xhigh→max`, but **medium remains medium**. DeepSeek accepts xhigh directly—do not import another provider’s mapping.
- **Immediate safe correction:** raise both maintained Qwen3.6 contexts from 131,056 to **262,128**.
- Live `nw-large` targets K3.1, while narrative alias documentation still says K3: use live metadata.
- Docs still list `kimi-k3`/`kimi-k3-fast` although public live inventory omits them. **No retirement conclusion.**
- Old GLM5.2/K2.7/DeepSeek4 rows absent from public inventory have unconfirmed current public availability. Neutral unmanaged handling is possible where no current documentation confirms them; never retire on this basis.
- Flex requests may wait for capacity. Preserve this limitation rather than presenting them as ordinary latency-equivalent aliases.

### 8. DeepSeek

Sources: [pricing/lifecycle](https://api-docs.deepseek.com/quick_start/pricing/), [Chat contract](https://api-docs.deepseek.com/api/create-chat-completion/).

- Current exact IDs: **`deepseek-flash`**, `deepseek-v4-pro`.
- `deepseek-flash` serves **DeepSeek-V4.1-Flash-1017**, accepts TI. Pro remains T.
- Both publish **1M context** and `none/low/high/max`; default high.
- Compatibility mapping explicitly says **native `xhigh→high`**, so catalog xhigh must map to **`max`** to select maximum effort.
- `max_tokens` maximum explicitly **393,216**: correct existing **384,000 output source notes**.
- Penalties unsupported. Temperature/top-p behavior depends on thinking/tool mode; do not replace with broad unconditional restrictions.
- **Explicit retired underlying models:** `deepseek-v4-flash` and `deepseek-v4-flash-vision-exp`; their names still redirect to current Flash.
- **Recommendation:** replace managed `deepseek-v4-flash` with `deepseek-flash`; retire the explicitly named old IDs; preserve Pro default; add Flash TI and reasoning-content preservation.
- `/models`: **401**. The reviewed current pages say “1M,” not an exact integer context expansion; do not import Umans/Neuralwatt’s numeric bounds.

### 9. Cerebras — Shared Inference only

Sources: [catalog](https://inference-docs.cerebras.ai/models/overview.md), [Qwen](https://inference-docs.cerebras.ai/models/qwen-3.8-27b.md), [GPT OSS](https://inference-docs.cerebras.ai/models/openai-oss.md), [reasoning](https://inference-docs.cerebras.ai/capabilities/reasoning.md), [deprecations](https://inference-docs.cerebras.ai/support/deprecation).

- Current shared IDs: **`gpt-oss-120b`, `qwen-3.8-27b`**.
- Qwen: TI; **65,536 free / 131,072 paid** context; **32,768 / 40,960** output.
- Qwen accepts `none/low/medium/high`; **high selects native xhigh**. Do not advertise wire xhigh.
- GPT OSS: `low/medium/high`, default medium; none unsupported. Its page reports rounded 65k/131k context and 32k/40k output.
- Qwen reasoning is returned as **`message.reasoning` / `delta.reasoning`**, not `reasoning_content`; `clear_thinking:false` preserves history; hidden format unsupported. Current generic Chat adapter search only showed `reasoning_content` handling—do not claim full reasoning replay compatibility via catalog metadata alone.
- **`gemma-4-31b` explicitly removed from Shared Inference September 3**; remains Dedicated. Dedicated Kimi/GLM families require assigned endpoint IDs and must not enter shared membership.
- **Recommendation:** retire shared Gemma, add Qwen, retain GPT OSS default. Account tier unknown; do not silently choose paid context as universally available.
- `/models`: **403**.

### 10. Moonshot API

Sources: [models/lifecycle](https://platform.kimi.ai/docs/models), [exact route](https://platform.kimi.ai/docs/api/overview.md), [parameter reference](https://platform.kimi.ai/docs/api/models-overview.md), [K3.1](https://platform.kimi.ai/docs/guide/kimi-k3-1-pro-quickstart.md).

- Add **`kimi-k3.1-pro`, `kimi-k3.1-pro-highspeed`**.
- K3 family: TI, documented **1M context**, `low/high/max`, default max; always thinking, no `thinking` parameter.
- Fixed temperature 1, top-p .95, penalties 0, n=1: add the new IDs to existing restrictions.
- Preserve full assistant `reasoning_content`; K3 tool choice supports auto/none/required.
- Access requires successful top-up, minimum $1; no payment performed.
- **`kimi-k2.5`: explicitly deprecated** in discontinued-model table.
- `kimi-k2.7-code`, `kimi-k2.7-code-highspeed`, `kimi-k2.6`: unavailable to users registered on/after November 1, but existing users retain access; **expected** retirement late December, not retired now.
- `kimi-k2.6` also rejects required tool choice; registry currently restricts only the K2.7 pair.
- **Recommendation:** add K3.1 pair, correct K2.6 restriction, remove K2.5 from current membership based on explicit lifecycle evidence. Do not label grandfathered K2.6/K2.7 retired or change user defaults.
- `/models`: **401**. Exact new integer context/output beyond the published “1M” remains unverified here; do not copy Kimi Code plan limits.

### 11. Z.AI Coding Plan

Sources: [latest coding-plan guide](https://docs.z.ai/devpack/latest-model), [legacy guide](https://docs.z.ai/devpack/using5.1).

- **`glm-5.3-flash`** explicitly supported on registered **`/api/coding/paas/v4`**, all Max/Pro/Lite plans.
- Add TI; **1,000,000** context explicitly configured for OpenAI-compatible tools.
- Existing `glm-5.3` also receives explicit **1,000,000** context evidence, filling its current hole; T.
- Effort ladder low/high/max, default max. medium→high, xhigh→max, disabling thinking→low.
- **`glm-5.3-flash[1m]`** is documented in the **Claude Code** setup. Its literal acceptance on the registered Chat route is **not established**; do not automatically add it there.
- Older guide confirms `glm-5.1`, `glm-5`, `glm-4.7`; no new retirement evidence.
- `/models`: **401**. GLM5.2 exact coding-route context and Flash output cap remain unknown; do not borrow standard API/other hosts.

### 12. Ollama Cloud

Sources: [exact `/v1/models`](https://ollama.com/v1/models), [same cloud’s `/api/tags`](https://ollama.com/api/tags).

**Important:** normal reader initially misclassified `/v1/models` as an Ollama library page; **`:raw` returned the actual JSON**, including extended model metadata.

Current usable chat IDs and context:

- **1,048,576:** `beam`, `deepseek-v4-pro:0813`, `deepseek-v4.1-flash`, `deepseek-v4.1-flash:1017`, `glm-5.2`, `glm-5.3`, `glm-5.3-flash`, `inkling-2-small`, `kimi-k3`, `kimi-k3.1-pro`, `mimo-v2.6-flash`, `mimo-v2.6-pro`, `mistral-large-4`, `muse-spark-open`.
- **262,144:** `gemma4:31b`, `kimi-k2.6`, `kimi-k2.7-code`, `nemotron-3-super`, `nemotron-3-ultra`.
- **131,072:** `gpt-oss:120b`, `gpt-oss:20b`.
- **512,000:** `minimax-m3` — **not upstream MiniMax’s 1M**.
- **1,000,000:** `minimax-m3.1-flash`.

TI except: beam, DeepSeek Pro, GLM5.2/5.3, GPT OSS pair, Nemotron pair are T.

Published effort metadata:
- low/high/max: DeepSeek pair, DeepSeek Pro, GLM5.3/Flash, K3.
- low/medium/high/max: K3.1, Inkling.
- low/medium/high/xhigh/max: beam.
- low/medium/high/xhigh: Muse.
- low/medium/high: GPT OSS pair.
- high/max: GLM5.2.
- medium thinking-toggle marker: Gemma, K2.6/K2.7, MiMo pair, Nemotron pair.
- empty effort arrays: MiniMax pair, Mistral Large 4.
- Some lists also contain none; retain exact per-model distinctions.

**Caution:** extended metadata is Codex-shaped. Context/modalities are explicit, but verify that effort literals are accepted as Chat `reasoning_effort` before claiming wire mappings; a thinking-toggle marker is not automatically a genuine effort tier.

- **Exclude `clef:27b`:** decision-only in tags, `visibility:"hide"`, `supported_in_api:false`.
- Old unlisted registry IDs: `deepseek-v4-flash:0731`, `qwen3.5:397b`, `deepseek-v4-pro:preview`, `minimax-m2.7`, `mistral-large-3:675b`, `glm-5.1`, `deepseek-v4-flash:preview`, `nemotron-3-nano:30b`.
- **Recommendation:** add evidenced current chat IDs and context/modalities; neutral unmanaged treatment for unconfirmed old IDs, **not retirement**. Output limits/tool restrictions unknown.

### 13. Mistral

Sources: [Codestral](https://docs.mistral.ai/models/codestral-25-08), [catalog](https://docs.mistral.ai/models), [lifecycle](https://docs.mistral.ai/inference/model-lifecycle).

- Maintained `codestral-2508` is still **GA**, 128k, Chat/function calling supported; no retirement change warranted. Exact alias mapping/modality enumeration was not exposed in rendered page; do not guess hidden `+1` alias.
- Provider-owned new Chat candidates:
  - [`mistral-large-4`](https://docs.mistral.ai/models/mistral-large-4-0): GA November 5; TI; 1M.
  - [`zai-glm-5-3`](https://docs.mistral.ai/models/zai-glm-5-3): GA; T; 1M; output 128k.
  - [`zai-glm-5-3-flash`](https://docs.mistral.ai/models/zai-glm-5-3-flash): GA; multimodal; 1M; output 128k.
  - [`deepseek-v4-1-flash-1017`](https://docs.mistral.ai/models/deepseek-v4-flash-1017): **Public Preview**, explicitly TI; 1M; output 128k.
- These are exact Mistral IDs, not upstream spellings. Numeric expansion of rounded limits, effort literals, sampling/replay restrictions remain unknown from reviewed pages.
- `zai-glm-5-2` retired October 31. Large3/Medium3.5 are deprecated but retirement is **April 30, 2027**, not current retirement.
- `/models`: **401**.
- **Recommendation:** preserve Codestral membership/default; optional additions only with above evidenced fields and explicit preview status, without importing upstream metadata.

### 14. MiniMax global

Sources: [OpenAI route contract](https://platform.minimax.io/docs/api-reference/text-openai-api), [subscription route](https://platform.minimax.io/docs/token-plan/other-tools), [lifecycle](https://platform.minimax.io/docs/faq/models).

- Add **`MiniMax-M3.1-Flash`**: **1,000,000**, TI.
- Wire effort **low/medium/high/xhigh/max**; catalog should advertise supported four-level contract without incorrectly mapping genuine xhigh to max.
- Thinking is mandatory; none/disabled →400. `reasoning_split:false` unsupported; `service_tier` unsupported.
- Preserve returned reasoning content across tool turns.
- Both M3.1 Flash and M3 fix temperature=1/top-p=.95; add conservative sampling restrictions. Penalties ignored.
- M3 has no adjustable effort, but thinking can be disabled.
- **Lifecycle conflict:** same FAQ table already labels M2.5/M2.7 retired, while its explicit schedule says:
  - new users blocked October 19;
  - **pay-as-you-go existing users supported until November 18**;
  - **M/Token Plan requests redirected to M3.1 Flash since October 19**.
- **Recommendation:** do not prematurely mark all API-key M2.7 requests retired as of this audit. Provider accepts both key classes; catalog cannot represent that credential-dependent distinction. Record transition/conflict; add M3.1 and restrictions now, do not rewrite user defaults.
- `/models`: **401**. New output maximum not established by the reviewed exact Chat page.

### 15. MiniMax CN — separate result

Sources: [CN OpenAI contract](https://platform.minimaxi.com/docs/api-reference/text-openai-api), [CN lifecycle](https://platform.minimaxi.com/docs/faq/models), [CN subscription configuration](https://platform.minimax.cn/docs/token-plan/other-tools).

- Independently confirms `MiniMax-M3.1-Flash`, `MiniMax-M3`, 1,000,000, TI, and the same effort/sampling/thinking restrictions.
- Independently publishes the same October 19 / November 18 lifecycle schedule and internally premature retired table.
- **Critical route difference:** current CN documentation redirects to `platform.minimax.cn` and configures **`https://api.minimax.cn/v1`**. Registry still uses **`https://api.minimaxi.com/v1`**.
- Exact old-host `/models`: **401**. This establishes authentication gating, **not current model availability or host equivalence**.
- **Recommendation:** retain CN evidence separately; do not copy global availability or automatically change hostname through catalog data. New model metadata on the old registered CN host remains conditional on documented hostname continuity. New hostname requires transport/runtime treatment.
- The 524,288 context in CN OMP examples is explicitly a **client recommendation**, not the published API maximum.

### 16. Xiaomi — Anthropic route

Sources: [exact Anthropic contract](https://mimo.mi.com/docs/en-US/api/chat/anthropic-api-post), [models](https://mimo.mi.com/docs/en-US/quick-start/summary/model), [explicit retirement](https://mimo.mi.com/docs/en-US/updates/deprecate).

- Exact registered Messages route confirmed: `https://api.xiaomimimo.com/anthropic/v1/messages`.
- Add **`mimo-v2.6-pro`, `mimo-v2.6-flash`**.
- Both multimodal; published context **1M**, output maximum **131,072**.
- `mimo-v2.6-pro-ultraspeed` is an exact accepted ID, but **custom/contact-sales availability**; exclude from general managed additions.
- Thinking enabled/disabled, default enabled; no effort ladder documented. Do not invent levels.
- Thinking mode fixes temperature=1/top-p=.95; this is conditional, not unconditional lack of sampling support.
- Tool choice **auto only**; other types are removed by server. Preserve previous thinking blocks during tool use.
- **`mimo-v2.5-pro` explicitly retired October 21, 10:00 UTC+8; old ID errors after cutoff.** Also explicitly retired `mimo-v2.5`; earlier V2 Pro/Omni/Flash retired June 30.
- **Recommendation:** retire maintained V2.5 Pro; replace managed default with documented successor V2.6 Pro for new installations, preserving existing user choices; add V2.6 Flash and auto-tool restriction.
- `/anthropic/v1/models`: **404**. Exact numeric expansion of “1M” and Anthropic image content-block details were not fully exposed by the reviewed collapsed reference; do not borrow Neuralwatt/OpenCode values.

### Delivery guardrails

- Keep defaults unchanged except where replacing an explicitly retired bundled default is necessary; never overwrite user selections.
- Do not add every observed ID to `verifiedJawcodeModels`: verification is provider/route-specific.
- Preserve unknown fields rather than using upstream-family defaults.
- Output limits above are **source notes only**, not runtime caps.
- Authentication failures and public inventory omissions establish neither retirement nor account entitlement.

## Gateway and environment-defined routes

## 요약

24개 provider 모두 조사했다. 파일 수정·빌드·테스트·인증 정보 조회·추론 요청은 하지 않았다.

- **공개 `/models` JSON 확인:** huggingface, nvidia, venice, nanogpt, synthetic, alibaba, zenmux, vercel-ai-gateway, kilo.
- **인증 없는 조회 실패:** groq·together·fireworks/firepass·gitlab-duo 401, qianfan 403, github-copilot 400, qwen-portal 404.
- **확실한 경로 문제:** `parallel`은 API가 아닌 웹 콘솔 주소다. Azure 모델 조회 구현도 현재 공식 v1 경로와 다르다.
- **다른 인증·프로토콜 자료를 가져오면 안 되는 항목:** Fire Pass, Alibaba Coding Plan, Qwen Portal, GitHub Copilot, GitLab Duo, Cloudflare Anthropic.
- **전체 서비스 목록 일괄 편입은 권고하지 않는다.** 아래 확인된 모델도 계정 사용 권한과 Frogprogsy 전체 호환성을 증명하지 않는다. 누락·401·404를 모델 은퇴로 분류할 근거는 없다.

## 전체 provider 조사표

`C`=컨텍스트 토큰, `입력`=Claude Code에 해당하는 text/image, `E`=공급자가 공개한 effort 값. 별도 기재하지 않은 모델별 제한은 **미확인**이다. 대형 공개 목록의 모델 예시는 **관측된 일부 레코드**이며, 전체 편입 제안이 아니다.

| Provider / registry 위치 | 정확한 등록 경로와 공개 조회 결과 | 공식 근거·관측 모델·제한 | 권고 |
|---|---|---|---|
| **groq** `registry.ts:541` | `https://api.groq.com/openai/v1`; [`/models`](https://api.groq.com/openai/v1/models) **401** | [공식 목록](https://console.groq.com/docs/models), [GPT-OSS 120B](https://console.groq.com/docs/model/openai/gpt-oss-120b). `openai/gpt-oss-120b`: C **131072**, 입력 text, E **low/medium/high**, tools 지원. 목록의 `openai/gpt-oss-20b`도 C 131072. `llama-3.1-8b-instant`, `llama-3.3-70b-versatile`는 **Enterprise** 표시. `qwen/qwen3.8-27b`는 Preview, C 131072. Whisper·Orpheus·분류 모델도 같은 서비스 목록에 포함됨. | GPT-OSS 120B는 개별 관리 후보 근거가 있다. Enterprise·Preview 조건을 숨기거나 음성 모델까지 Chat 모델로 편입하지 말 것. |
| **azure-openai** `626` | `https://{resource}.openai.azure.com/openai`; 실제 resource 미제공으로 조회하지 않음 | [공식 Models API](https://learn.microsoft.com/en-us/rest/api/microsoft-foundry/azureopenai/models)는 **`{endpoint}/openai/v1/models`**. 인증 필요. [배포 개념](https://learn.microsoft.com/en-us/azure/ai-foundry/model-inference/concepts/endpoints): 요청은 사용자가 만든 deployment 이름을 사용. 해당 resource의 ID/C/입력/E 미확인. | 전역 OpenAI 모델 ID를 정적으로 넣지 말 것. 현 `buildModelsRequest`가 만드는 `/openai/models`와 공식 v1 경로의 차이는 **런타임 수정 검토 대상**, 원격 카탈로그로 해결 불가. |
| **ollama local** `627` | `http://localhost:11434/v1`; 공개 서비스가 아니므로 로컬 서버 조회하지 않음 | [공식 OpenAI 호환 문서](https://docs.ollama.com/openai): `/v1/models` 지원, 로컬 API key 무시. 모델 설치·설정별 ID/C/입력/E. `reasoning_effort`는 모델별 이름과 호환 alias를 처리하고 `/api/show`에서 지원값 확인. 문서상 `tool_choice` 미지원, 이미지 URL 미지원·base64 지원. | 설치되지 않은 라이브러리 모델을 편입하지 말 것. 로컬 모델 설정을 유지. 도구 선택 제한은 서버 버전도 함께 확인해야 함. |
| **vllm** `628` | `http://localhost:8000/v1`; 로컬 서버 조회하지 않음 | [공식 서버 문서](https://docs.vllm.ai/en/v0.21.0/serving/openai_compatible_server/): OpenAI Chat 서버, 선택적 API key. Chat은 **chat template 있는 생성 모델**에 한함. 모델별 C/입력/E는 실행 옵션·모델·parser에 의존. embedding 등 별도 task 존재. | 지원 아키텍처 목록을 설치 모델 목록으로 대체하지 말 것. 사용자 서버의 `/v1/models`와 실행 설정이 필요. |
| **lm-studio** `629` | `http://localhost:1234/v1`; 로컬 서버 조회하지 않음 | [공식 `/models`](https://lmstudio.ai/docs/developer/openai-compat/models): 서버에 보이는 모델 반환. JIT loading을 켜면 **다운로드된 미로드 모델도 포함** 가능. ID/C/입력/E는 사용자 설치·로드 설정별. | 발견=이미 메모리에 로드됨으로 설명하지 말 것. 전역 정적 모델 목록 추가 불가. |
| **together** `676` | `https://api.together.xyz/v1`; [`/models`](https://api.together.xyz/v1/models) **401** | [현재 호환 문서](https://docs.together.ai/docs/inference/openai-compatibility)는 **`https://api.together.ai/v1`**을 지정. [서버리스 목록](https://docs.together.ai/reference/models): `moonshotai/Kimi-K3.1-Pro` C **1048576**, text/image·tools; `openai/gpt-oss-120b` C 131072; `zai-org/GLM-5.3` C **1048575**; `Qwen/Qwen3.7-Max` C **미기재**. 서버리스와 dedicated 목록이 다름. `.xyz` 동일 계약은 이번 공식 문서 조사로 확인되지 않음. | `.ai` 자료를 `.xyz`에 조용히 적용하지 말 것. 먼저 기존 호스트의 공식 동등성 또는 preset 경로 변경을 검토. 모든 모델에 1M 같은 공통값 금지. |
| **fireworks** `677` | `https://api.fireworks.ai/inference/v1`; [`/models`](https://api.fireworks.ai/inference/v1/models) **401** | [정확한 Chat 경로 예제](https://docs.fireworks.ai/guides/querying-text-models), [모델 페이지](https://fireworks.ai/models/fireworks/glm-5p3-flash): `accounts/fireworks/models/glm-5p3-flash`, serverless Ready, C 표기 **1040k**, text/image, function calling. E 미확인. Dedicated는 `accounts/<account>/deployments/<deployment>`라는 별도 ID. | 확인된 serverless 모델만 개별 후보. `1040k`를 근거 없이 1048576으로 바꾸지 말 것. 계정별 deployment 전체 편입 금지. |
| **firepass** `678` | Fireworks와 같은 base; 위 무인증 `/models` **401**은 **Fire Pass 권한 목록을 입증하지 않음** | [Fire Pass 공식 문서](https://docs.fireworks.ai/firepass): **`accounts/fireworks/routers/kimi-fast-latest`**, 현재 Kimi K3 Fast, C **1040000**, text/image, 최대 출력 131072. **`fpk_` 전용 key**, 선택된 pass route만 허용. 개인·비운영 코딩 전용, 신규 구독 중단 상태, 기존/프로모션 사용자 대상. Responses·`auto`·Nexus Auto 사용 불가. E 미확인. | 가장 명확한 제한형 후보. 일반 Fireworks 모델 목록을 복제하지 말 것. 출력 상한은 catalog v1 실행 제한이 아닌 참고값. |
| **huggingface** `723` | `https://router.huggingface.co/v1`; [`/models`](https://router.huggingface.co/v1/models) **공개 JSON** | [공식 호환 문서](https://huggingface.co/docs/inference-providers/index)가 정확한 base 확인. 관측 `Qwen/Qwen3.8-27B`: 입력 text/image. **같은 ID의 provider별 C가 65536·262144·1000000으로 다름**; tools/structured-output도 provider별. provider suffix·`:fastest`·`:cheapest` 선택 가능. E 미확인. | Hugging Face Hub 전체 모델이나 동일 이름의 최대 C를 공통값으로 사용하지 말 것. 선택한 provider 경로별 근거가 필요. |
| **nvidia** `724` | `https://integrate.api.nvidia.com/v1`; [`/models`](https://integrate.api.nvidia.com/v1/models) **공개 JSON**, 32개 레코드 관측 | [공식 LLM API](https://docs.api.nvidia.com/nim/reference/llm-apis)가 `/v1/chat/completions` 확인. 공개 응답에는 `openai/gpt-oss-20b`, `nvidia/nemotron-3-ultra-550b-a55b`, `z-ai/glm-5.3-flash` 등과 **embedding·video detector·안전 분류 모델**이 함께 있음. 응답 자체에는 C/입력/E 없음. 공식 목록과 live 목록도 다름. | `/models` 전체를 Chat 호환으로 승격하지 말 것. 문서/live 교집합에서 개별 모델 명세를 확인. 목록 차이는 은퇴 근거 아님. |
| **venice** `725` | `https://api.venice.ai/api/v1`; [`/models`](https://api.venice.ai/api/v1/models) **공개 JSON** | [공식 목록 API](https://docs.venice.ai/api-reference/endpoint/models/list): 기본은 text, `type=all`은 다른 생성 유형까지 포함. 관측 `gemini-4-carbon`, `gemini-4-argon`, `gemini-4-hydrogen`: C **1000000**, text/image, function calling true, `supportsReasoning=true`지만 **`supportsReasoningEffort=false`**, 다중 이미지 false. `pareto`: C 1000000, text/image, beta, reasoning false. | reasoning boolean으로 E를 만들지 말 것. 기본 text 목록과 전체 서비스 목록을 구분. 공개 명세로 확인한 필드만 후보에 사용. |
| **nanogpt** `764` | `https://nano-gpt.com/api/v1`; [`/models`](https://nano-gpt.com/api/v1/models) 및 [`?detailed=true`](https://nano-gpt.com/api/v1/models?detailed=true) **공개 JSON** | [공식 문서](https://docs.nano-gpt.com/api-reference/endpoint/models): 기본 응답은 ID만, 상세 응답에 C·입력·E·subscription 조건. 상세 관측 `particle-ai/particle-1`: C **1048576**, text/image, tools, E **none/minimal/low/medium/high/xhigh/max**, subscription 제외, strict schema 보장 안 됨. 문서의 `minimax/minimax-m3.1-flash`: C **1000000**, text/image, E **low/medium/high/xhigh/max**, 항상 thinking, temperature=1·top_p=.95 고정, forced tool choice·JSON response format 미지원. | 기본 목록만 보고 메타데이터가 없다고 결론 내리지 말 것. 상세·provider별 경로와 구독 포함 여부를 분리. 지원 E 중 Claude Code가 표현할 수 있는 값만 취급. |
| **synthetic** `765` | `https://api.synthetic.new/openai/v1`; [`/models`](https://api.synthetic.new/openai/v1/models) **공개 JSON**, 12개 레코드 | [Chat 계약](https://dev.synthetic.new/docs/openai/chat-completions), [현재 모델 문서](https://dev.synthetic.new/docs/api/models). 7개 고정 ID와 5개 alias의 정확한 메타데이터는 아래 별도 표. 문서는 모델 상세 정보의 기준으로 이 `/openai/v1/models`를 명시. Infinite는 일부 구독만, **streaming 필수**. | 고정 `hf:` ID는 개별 관리 후보 근거가 충분. alias는 대상이 바뀌므로 고정 모델로 취급 금지. `infinite:`는 현 일반 요청 전체에 안전한 기본 후보가 아님. |
| **qwen-portal** `766` | `https://portal.qwen.ai/v1`; [`/models`](https://portal.qwen.ai/v1/models) **404** | [Qwen 공식 인증 문서](https://qwenlm.github.io/qwen-code-docs/en/users/configuration/auth): Qwen Account OAuth 구독, QwenCloud API, Alibaba ModelStudio를 **별개 인증·서비스**로 구분. 해당 portal base의 현재 key-mode Chat 계약·모델 ID/C/입력/E는 확인되지 않음. 공식 저장소/문서와 별도 검색도 확인했으나 exact route 근거를 확보하지 못함. | `coder-model`·`vision-model` 같은 타사 설정의 이름이나 QwenCloud 모델을 가져오지 말 것. key preset의 제품·인증 경로부터 검토. 404로 provider/모델 은퇴 판정 금지. |
| **qianfan** `767` | `https://qianfan.baidubce.com/v2`; [`/models`](https://qianfan.baidubce.com/v2/models) **403** | [공식 discovery](https://cloud.baidu.com/doc/qianfan-api/s/Dmba8k71y), [Chat 계약](https://cloud.baidu.com/doc/qianfan-api/s/3m7of64lb), [연결된 모델 표](https://cloud.baidu.com/doc/qianfan/s/rmh4stp0j). 정확한 `ernie-5.5-flash-preview`, `ernie-light-dt-1.0`, `deepseek-v4.1-flash-1017`, `glm-5.3-flash` 등 C 표기 **1M**. API key 필요. `/models`에는 `type`, `context_length`, `architecture`가 정의됨. DeepSeek `thinking_budget` 안내는 있지만 E 열거값은 미확인. | 일반 Qianfan 경로이며 Coding Plan 자료를 대입하지 말 것. `1M` 단위의 정확한 정수 확인 전 임의 숫자 금지. `glm-5`, `kimi-k2.6`의 “곧 중단” 표시는 확인했지만 즉시 retired 처리는 부적절. |
| **alibaba** `768` | `https://coding-intl.dashscope.aliyuncs.com/v1`; [`/models`](https://coding-intl.dashscope.aliyuncs.com/v1/models) **공개 JSON**, 6개 | [정확한 국제 Coding Plan 문서](https://www.alibabacloud.com/help/en/model-studio/coding-plan)와 일치: **`kimi-k2.5`, `qwen3.5-plus`, `glm-5`, `MiniMax-M2.5`, `qwen3.6-plus`, `qwen3.7-plus`**. Qwen 세 개와 Kimi는 vision 명시. C/E는 조회 응답·이 문서에서 미확인. **`sk-sp-` 전용**, 일반 API key/base와 혼용 불가. 대화형 코딩 도구용; 자동 스크립트·앱 backend 금지. | 이 6개 외 최신 Qwen·GLM·MiniMax를 추가할 근거 없음. 회원 전용 권한과 사용 조건 유지. 일반 Qwen Code 문서의 중국/국제 혼합 목록보다 이 exact-route 문서·응답을 우선. |
| **parallel** `769` | 등록 base `https://platform.parallel.ai`; [`/models`](https://platform.parallel.ai/models)는 **로그인 HTML로 redirect** | [Chat 공식 API](https://docs.parallel.ai/api-reference/chat-api-beta/chat-completions)는 **`https://api.parallel.ai/v1beta/chat/completions`**. [현재 quickstart](https://docs.parallel.ai/chat-api/chat-quickstart)는 Responses 문서로 redirect하며 **`https://api.parallel.ai/v1/responses`**, ID `parallel`, E low/medium/high를 설명. 이것은 등록된 웹 콘솔 Chat 경로와 다름. | **현재 base에 모델 추가 금지.** 먼저 제품·Chat/Responses 경로 수정 필요. Responses의 `parallel` 모델을 현 Chat preset에 넣지 말 것. |
| **zenmux** `770` | `https://zenmux.ai/api/v1`; [`/models`](https://zenmux.ai/api/v1/models) **공개 JSON** | [공식 quickstart](https://docs.zenmux.ai/guide/quickstart)에서 정확한 Chat base 확인. 관측 `qwen/qwen4-max`: C **1000000**, text/image; `tencent/hy4-flash`: C **1048576**, text. reasoning은 boolean만 관측되어 E 미확인. 같은 목록에 `bytedance/doubao-seedance-2.5-flash` 등 **video output 모델** 포함. Builder Plan은 개인 개발용, 운영 사용 금지. | text output 및 모델별 도구 호환성을 구분. 전체 JSON 또는 reasoning=true를 그대로 관리 목록·E로 바꾸지 말 것. |
| **litellm** `771` | `http://localhost:4000/v1`; 사용자 서버 미조회 | [공식 discovery](https://docs.litellm.ai/docs/proxy/model_discovery): `/v1/models`는 구성·key/team allowlist·wildcard·discoverable 설정에 따라 달라짐. wildcard 조회는 **deployment 자체 credential**을 사용하며 호출자가 전달한 upstream key의 권한을 반영하지 않을 수 있음. ID/C/입력/E는 개별 설치별. | LiteLLM 지원 provider 전체 카탈로그를 복제하지 말 것. listing과 개별 호출자의 실제 권한을 동일시하지 말 것. |
| **vercel-ai-gateway** `897` | `https://ai-gateway.vercel.sh/v1`; [`/models`](https://ai-gateway.vercel.sh/v1/models) **공개 JSON** | [정확한 Chat 문서](https://vercel.com/docs/ai-gateway/sdks-and-apis/openai-chat-completions/chat-completions). 관측 `alibaba/qwen-3-32b`: C **128000**, 입력 text, tools, `reasoning_options`: toggle 및 E **none/low/medium/high**. `alibaba/qwen3-coder`: C **262144**, text, tools. 응답은 `type`, `modalities`, `supported_parameters`, `reasoning_options` 제공. | provider-wide 모델 목록을 그대로 편입하지 말고 language/text-output 및 개별 지원 필드를 확인. AI SDK specification v2/v3/v4를 Chat 호환성 등급으로 오해하지 말 것. |
| **kilo** `911` | `https://api.kilo.ai/api/gateway`; [`/models`](https://api.kilo.ai/api/gateway/models) **공개 JSON** | **등록 경로 직접 근거 있음:** [공식 제품 페이지](https://kilo.ai/gateway)의 `kilo.chat(...)` 예제가 이 base 사용. [API reference](https://kilo.ai/docs/gateway/api-reference)는 별도 `https://ai-gateway.kilo.ai/api/v1` 사용. 관측 `anthropic/claude-opus-5.5`: C **1000000**, text/image, tools, `opencode.reasoning_options` E low/medium/high/xhigh/max. `kilo-auto/free`: C 256000, text, **prompt 학습 가능 경고**. | 문서의 다른 host만 보고 등록 base가 틀렸다고 판정하면 안 됨. `opencode` 내부 옵션을 현 Chat wire의 `reasoning_effort`와 자동 동일시하지 말 것. Auto route를 고정 모델/안전 기본값으로 승격 금지. |
| **cloudflare-ai-gateway** `912` | `https://gateway.ai.cloudflare.com/v1/{account-id}/{gateway}/anthropic`; 계정·gateway가 없으므로 조회하지 않음 | [공식 Anthropic 경로](https://developers.cloudflare.com/ai-gateway/usage/providers/anthropic)와 일치. `/anthropic/v1/messages`의 provider key는 **`x-api-key`**; Bearer는 대체 불가. Cloudflare 인증은 별도 `cf-aig-authorization`. BYOK·stored key·Unified Billing에 따라 접근 달라짐. exact gateway 모델 목록/C/입력/E 미확인. | Cloudflare의 전체 모델 검색 목록이나 OpenAI-compatible 별도 API의 `anthropic/...` ID를 이 native Anthropic 경로에 넣지 말 것. |
| **github-copilot** `913` | `https://api.githubcopilot.com`; [`/models`](https://api.githubcopilot.com/models) **400** | [GitHub 공식 지원 모델 문서](https://docs.github.com/en/copilot/reference/ai-models/supported-models)는 **plan·IDE/CLI·정책별 가용성**을 명시. 표시 이름은 제공하지만 등록된 key-mode Chat 경로의 정확한 wire ID·C·입력·E를 보장하지 않음. 공식 문서 및 exact endpoint 관련 별도 검색으로 일반 공개 Chat API 계약을 확인하지 못함. | UI의 GPT/Claude 목록을 slug로 변환해 편입 금지. 인증·integration·계정별 모델 조회 없이 메타데이터 승격 불가. 1M도 해당 클라이언트 선택 기능을 이 경로에 복사하지 말 것. |
| **gitlab-duo** `914` | `https://cloud.gitlab.com/ai/v1/proxy/openai/v1`; [`/models`](https://cloud.gitlab.com/ai/v1/proxy/openai/v1/models) **401** | [GitLab 공식 외부 에이전트 예제](https://docs.gitlab.com/user/duo_agent_platform/agents/external_examples/)는 동일 base를 확인하지만 **`wire_api="responses"`**, 모델 예제 `gpt-5.3-codex`, **`AI_FLOW_AI_GATEWAY_TOKEN`와 추가 gateway headers** 사용. 일반 PAT로 Chat을 호출할 수 있다는 근거 아님. C/입력/E 미확인. | 이 Responses 예제 모델을 등록된 **openai-chat + key** 경로에 승격하지 말 것. PAT dashboard 링크도 인증 계약 증거가 아니다. |

## Synthetic: 관측한 12개 ID 전체

출처: [해당 경로의 공개 응답](https://api.synthetic.new/openai/v1/models), [공식 모델 문서](https://dev.synthetic.new/docs/api/models).

| 정확한 ID | C | 입력 | 응답이 열거한 E |
|---|---:|---|---|
| `hf:openai/gpt-oss-120b` | 131072 | text | none, low, medium, high |
| `hf:zai-org/GLM-4.7-Flash` | 196608 | text | none, low, medium, high |
| `hf:zai-org/GLM-5.3` | 524288 | text | low, high, max |
| `hf:zai-org/GLM-5.3-Flash` | 524288 | text, image | low, high, max |
| `hf:deepseek-ai/DeepSeek-V4.1-Flash-1017` | 524288 | text, image | none, low, high, xhigh, max |
| `hf:moonshotai/Kimi-K3.1-Pro` | 524288 | text, image | low, high, max |
| `hf:Qwen/Qwen3.8-27B` | 262144 | text, image | low, medium, xhigh |
| `syn:large:text` | 524288 | text, image | none, low, high, xhigh, max |
| `syn:small:text` | 196608 | text | none, low, medium, high |
| `syn:large:vision` | 524288 | text, image | low, high, max |
| `syn:small:vision` | 524288 | text, image | none, low, high, xhigh, max |
| `infinite:small:vision` | 524288 | text, image | none, low, high, xhigh, max |

모두 응답에서 tools·JSON mode·structured output·reasoning 및 최대 출력 65536을 광고한다. **`syn:large:text`도 image를 받는다. 이름으로 modality를 추론하면 틀리는 실제 사례다.** `none/max`를 Claude Code 지원 단계로 새로 노출하거나, 빠진 medium/high를 임의 보충하면 안 된다.

## 코드에서 확인한 공통 주의점

- **`src/providers/registry.ts`**
  - 위 24개는 모두 transport/auth preset만 있는 단일 레코드다. 현재 명시적 managed `models`, 기본 모델, `officialModelSources`, 검증된 모델별 메타데이터가 없다.
- **`src/oauth/index.ts:94-115` — `buildModelsRequest`**
  - Anthropic: `${baseUrl}/v1/models?limit=1000`, key mode에서 `x-api-key`.
  - 나머지: `${baseUrl}/models`, Bearer.
  - **Azure 전용 discovery 경로·API version 처리가 없다.**
- **`src/adapters/azure.ts:5-29`**
  - Azure 추론은 Responses adapter를 감싸며 `api-key`, 구형 경로의 `api-version`을 처리한다. discovery와 서로 다른 처리다.
- **`src/claude-catalog.ts:518-541` — live 메타데이터 파서**
  - C는 `max_context_window`, `context_window`, `metadata.limits.max_context_length`, `max_model_len`만 읽는다.
  - 이번 여러 공개 응답의 **`context_length`**, `architecture.input_modalities`, `model_spec.capabilities`, `reasoning_parameters.efforts`, `reasoning_options`는 여기서 처리하지 않는다.
  - 따라서 **“upstream 공개 응답에 메타데이터 있음”과 “Frogprogsy가 현재 적용함”은 다르다.**
- **`src/claude-catalog.ts:575-639`**
  - key가 없으면 `/models` 요청 자체를 건너뛴다. 이번 무인증 공개 조회 성공을 현재 앱의 무인증 자동 discovery 성공으로 설명하면 안 된다.
- **`structure/10_remote-model-catalog.md`**
  - 전송 경로·인증·adapter 변경은 원격 catalog 범위 밖.
  - 공개 모델 목록은 계정 권한·전체 호환성 검증과 다름.
  - `unmanagedModels`와 retirement를 구분해야 한다.

### 전달용 공개 응답 스냅샷

도구가 보관한 결과: Hugging Face `artifact://28`, Venice `artifact://29`, NanoGPT 기본 목록 `artifact://34`, Synthetic `artifact://31`, ZenMux `artifact://27`, Vercel `artifact://26`, Kilo `artifact://30`. 이는 조사 결과이며 저장소 변경물이 아니다.

**최종 권고:** 현재 discovery-only 성격을 유지하면서 공식 출처와 경로 주의사항을 기록하는 것이 안전하다. 관리 모델을 늘린다면 Fire Pass의 정확한 router, Alibaba 국제 Coding Plan의 6개 ID, Synthetic 고정 ID처럼 **해당 경로의 직접 근거가 있는 모델부터 개별 검토**한다. Parallel/Azure 경로 문제와 GitLab/Qwen/Copilot 인증·프로토콜 문제를 모델 데이터 추가로 덮어서는 안 된다.
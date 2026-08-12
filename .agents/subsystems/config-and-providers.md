# Subsystem: Config & Providers

Configuration resolution and the LLM provider layer. Files: `src/config/{schema,defaults,loader,model-presets}.ts`, `src/providers/{interface,factory,openai-compatible,anthropic,resilient}.ts`, plus per-model knobs `src/pipeline/{temperature,max-output}.ts` and error types `src/utils/errors.ts`.

Start here: [`../index.md`](../index.md) for context, [`../AGENTS.md`](../AGENTS.md) for non-negotiables. Related: [model presets](model-presets.md), [review pipeline](review-pipeline.md), [GitHub integration](github-integration.md).

## Config precedence (highest wins)

1. **Explicit Action inputs** (`action/index.ts`): `model`, `model_params`, `base_url`, `user_agent`, `language`, `fail_on`, `experimental` override the loaded repo config after `loadConfig`. An explicit `model` input is a **global override**: it pins `config.model` and all four `config.models.*` stages, bypassing `modelPreset`/`models` precedence entirely.
2. **App env vars** (`src/index.ts` → `webhooks.ts`): `applyModelOverride` pins `config.model` and all four `config.models.*` stages from `MODEL`/`FISCALCR_MODEL` (same global override semantics) before provider construction; `appCtx.provider ?? config.provider`, `appCtx.userAgent ?? config.userAgent`; `baseUrl` env always wins (no config fallback in App mode).
3. **Repo config** `.fiscalcr-review.yml` (path overridable via `config_path` input), fetched through the GitHub API.
4. **Built-in defaults** — `DEFAULT_CONFIG` in `src/config/defaults.ts`, mirrored by zod schema `.default()` values.

- `src/config/schema.ts` — `reviewConfigSchema` (zod) is the **canonical** config definition. Shape: top-level `language` (en/zh-TW/zh-CN/ja/ko), `provider` (openai-compatible/kimi/openai/anthropic), `model` (legacy single-model fallback), `models` (per-stage `intent`/`fastPath`/`groupReview`/`synthesis`, `.strict()` so legacy `big`/`small` keys fail fast), `modelPreset` (preset selector), `modelPresets` (custom preset name → partial stage map), `baseUrl`, `userAgent`, `temperature`, `modelParams` (provider-native fields; `reasoning_effort`/`verbosity` typed, others passthrough), `experimental`; `review.{auto,aspects,minSeverity,maxAnnotations,failOn,incremental,comments}`; `files.{include,exclude,maxFileSize}`; `rules[]` (custom repo rules); `prompt.{systemAppend,reviewFocus}`; `pipeline.{enabled,concurrency,groupTokenBudget,relatedContextBudget,maxGroups,fastPathThreshold,minConfidence,maxRetries,callTimeoutMs,maxOutputTokens}`. `modelForRole(config, role)` (same file) resolves a stage model.
- `DEFAULT_EXCLUDE_PATTERNS` is a shared const used both by the schema default and `DEFAULT_CONFIG` specifically so the two cannot drift.
- `src/config/defaults.ts` — `DEFAULT_CONFIG`, a fully-populated `ReviewConfig` mirroring schema defaults. **Changing one without the other is a bug.**

## Loader (`src/config/loader.ts`)

`loadConfig(octokit, owner, repo, configPath)`:

- Fetches the file via `repos.getContent` (base64), `YAML.parse`, then `reviewConfigSchema.safeParse`.
- **Invalid config → throws `ConfigError`** (fails fast by design, per README).
- **Missing (404) → `DEFAULT_CONFIG`**.
- **Other API errors → rethrown** (never silently defaulted).

## Model presets & stage routing

Full preset semantics — built-in stage maps, `provider-default` mapping, custom merge behavior, validation details, and the change recipe — live in the dedicated [model presets](model-presets.md) guide. Overview:

`src/config/model-presets.ts` holds the built-in presets and their resolvers; `schema.ts` exposes `modelForRole(config, role)`, which every pipeline call site uses.

- **Stage keys** (`ModelRole`): `intent` (Pass 1), `fastPath` (fast-path combined call), `groupReview` (Pass 2 per-group reviews), `synthesis` (Pass 3 synthesis).
- **`modelPreset` selector** — optional; accepts a built-in name (`provider-default`, `kimi`, `openai`, `anthropic`) or any name defined under `modelPresets`. Omitted → no preset (legacy behavior: `models.<stage>` else top-level `model`).
- **`provider-default` is a selector, not a map**: `resolvePresetName` delegates to `presetForProvider(config.provider)` (`kimi` → kimi preset, `openai` → openai, `anthropic` → anthropic). `openai-compatible` (or an unknown provider) has **no preset**, so every stage falls back to the top-level `model`.
- **Built-in stage maps** (`MODEL_PRESETS`):

| Preset      | `intent`                  | `fastPath`              | `groupReview`            | `synthesis`              |
| ----------- | ------------------------- | ----------------------- | ------------------------ | ------------------------ |
| `kimi`      | `kimi-for-coding-highspeed` | `kimi-for-coding`     | `kimi-for-coding`        | `kimi-for-coding`        |
| `openai`    | `gpt-5-mini`              | `gpt-5-mini`            | `gpt-5`                  | `gpt-5`                  |
| `anthropic` | `claude-haiku-4.5`        | `claude-haiku-4.5`      | `claude-sonnet-4.5`      | `claude-sonnet-4.5`      |

- **`modelPresets` custom maps** — preset name → partial per-stage object (`intent`/`fastPath`/`groupReview`/`synthesis`). An entry under a built-in name merges over that built-in (user stages win, via `resolveStageMapFor`); a new name defines a fresh preset whose unset stages fall back to the top-level `model`.
- **Precedence** (`modelForRole`): explicit `models.<stage>` > selected preset's merged stage model > top-level `model`. The Action `model` input and App `MODEL`/`FISCALCR_MODEL` pin all stages globally (see precedence above), above everything here.
- **Validation**: unknown `modelPreset` names fail via `superRefine` (a `ConfigError`); unknown stage keys inside `models` and `modelPresets` entries are rejected by `.strict()` (the old `big`/`small` roles fail loudly instead of silently disappearing); empty names are rejected (`min(1)`).
- **Presets are YAML-only**: there is no Action input or App env var for preset selection (README).
- **Consumers**: `runFastPath` → `modelForRole(config, 'fastPath')`; `pass1-intent.ts` → `'intent'`; `pass2-review.ts` → `'groupReview'`; `pass3-synthesis.ts` → `'synthesis'`. Provider construction (`webhooks.ts`, `action/index.ts`) uses `modelForRole(config, 'groupReview')` — the group-review stage dominates the token budget.
- **Tests**: preset resolution/validation in `test/unit/config-loader.test.ts` (built-in selection, `provider-default` mapping, `openai-compatible` fallback, `models.*` over preset, custom + merge-over-built-in presets, unknown preset/stage-key rejection); stage routing in `test/unit/fast-path.test.ts`, `test/unit/orchestrator-pipeline.test.ts`, `test/unit/pass3-synthesis.test.ts`.

## Provider layer

### Interface (`interface.ts`)

```ts
interface LLMProvider {
  chatCompletion(params: ChatCompletionParams): Promise<LLMCompletionResponse>;
}
```

`ChatCompletionParams`: `messages`, `responseFormat` (`json_object` | `text`), `maxTokens`, `temperature`, `timeoutMs`. `LLMCompletionResponse`: `content`, `usage { input, output, cached }`, `finishReason` (`'length'` signals truncation at the token cap).

### Factory (`factory.ts`)

`createLLMProvider({ apiKey, model, baseUrl?, provider, userAgent?, modelParams?, retry? })`:

- `parseProvider` validates the name against `["openai-compatible", "kimi", "openai", "anthropic"]`; unknown → `ConfigError`.
- `openai-compatible` requires an explicit `baseUrl` (else `ConfigError`).
- `kimi` is a preset: default base URL `https://api.kimi.com/coding/v1` when none given.
- `openai` is a preset: default base URL `https://api.openai.com/v1` and
  `max_completion_tokens`.
- `anthropic` is a preset: default base URL `https://api.anthropic.com/v1` and
  uses the native `/messages` API adapter.
- All providers are wrapped in `ResilientProvider`.

### OpenAI-compatible adapter (`openai-compatible.ts`)
- `fetch POST {baseUrl}/chat/completions` with `Authorization: Bearer`, `User-Agent: fiscalcr/1.0` (or the configured `userAgent`; when a custom UA is set the `X-Client-Name: fiscalcr` header is omitted so the request carries one identity).
- Request body conditionally includes `temperature` (omitted when undefined — some models reject any non-default temperature), `max_tokens`, `response_format`.
- Timeout via `AbortController` (default 300s, per-call `timeoutMs` override).
- Non-2xx → `LLMApiError` carrying status, endpoint body snippet, and parsed `Retry-After` (seconds or HTTP-date).
- Usage mapped from `prompt_tokens` / `completion_tokens` / `cached_tokens`.

### Anthropic adapter (`anthropic.ts`)

- `POST {baseUrl}/messages` with `x-api-key` and `anthropic-version: 2023-06-01`.
- Moves `system` messages to the top-level `system` field; only user/assistant
  messages are sent in the Messages API conversation.
- Converts `input_tokens`, cache reads/writes, and `output_tokens` into the
  normalized usage contract; `max_tokens` maps to `finishReason: 'length'`.
- Anthropic has no shared `response_format` field, so JSON calls receive an
  explicit JSON-only system instruction.

### Resilient decorator (`resilient.ts`)

Retry-with-backoff wrapper around any provider:

- Retryable: `LLMApiError` with status 429 or >= 500; `AbortError`/`TimeoutError` (our timeout); `TypeError` (fetch network failure). **Other 4xx (auth, bad request) never retried.**
- Backoff: exponential `1s * 2^attempt` with full jitter (50–100% of the window), capped at `maxBackoffMs` (default 30s); honors `Retry-After` when the API supplied it (still capped).
- Default `maxRetries` 3 (matches `pipeline.maxRetries` config surface, which flows through `config.retry` in the Action entry).

## Per-model knobs (config-adjacent)

- `src/pipeline/temperature.ts` — `reviewTemperature(config, preferred, model)`: explicit `config.temperature` wins; models that pin their own temperature (`kimi-for-coding`, `kimi-for-coding-highspeed`, `kimi-k3`) and OpenAI reasoning models (name prefix `o1`–`o9`/`gpt-5`) get no `temperature` field at all (server default); otherwise `preferred` (0.3). `model` is the stage model actually used for the call (from `modelForRole`), defaulting to the legacy `config.model` for callers that predate stage routing.
- `src/pipeline/max-output.ts` — `reviewMaxOutputTokens(config, model)`: explicit `pipeline.maxOutputTokens` wins; Kimi models (by provider or model-name prefix) get 65536; everything else 32768. Short caps truncate structured JSON mid-generation.
- `src/utils/tokens.ts` — `estimateTokens` (~4 chars/token, ~2 for CJK) and `calculateCost` (single flat pricing table — a documented rough estimate across providers).

## Invariants

- Schema (`schema.ts`) and `defaults.ts` never drift; `DEFAULT_EXCLUDE_PATTERNS` exists to enforce this for the one shared list.
- Invalid repo config fails fast; missing config defaults; unrelated API errors propagate.
- Stage models resolve through `modelForRole` (`models.<stage>` > preset stage > top-level `model`); unknown preset names and unknown stage keys fail fast, never silently ignored.
- Provider names are validated at construction; `openai-compatible` without `baseUrl` is a `ConfigError`, not a runtime 404.
- Retry only on transient errors (429/5xx/timeout/network); auth and bad-request errors fail immediately.
- JSON-format review calls always set `response_format: json_object` and a max-token cap so truncation is detectable and salvageable.

## Relevant tests

- `test/unit/config-loader.test.ts` — load from custom path, missing → defaults, non-404 rethrow; `modelPreset`/`modelPresets` resolution and validation (built-in selection, `provider-default` mapping, `openai-compatible` fallback, `models.*` over preset, custom + merge-over-built-in presets, unknown preset/stage-key rejection).
- `test/unit/fast-path.test.ts`, `test/unit/orchestrator-pipeline.test.ts`, `test/unit/pass3-synthesis.test.ts` — stage-model routing (`fastPath`/`intent`/`groupReview`/`synthesis`) end to end.
- `test/unit/provider-factory.test.ts` — provider validation, baseUrl requirement, kimi preset.
- `test/unit/openai-compatible-provider.test.ts` — request shaping, error surfacing.
- `test/unit/anthropic-provider.test.ts` — Messages API adapter.
- `test/unit/resilient-provider.test.ts` — retry classification, backoff, Retry-After.
- `test/unit/temperature.test.ts`, `test/unit/max-output.test.ts` — per-model knob resolution.
- `test/unit/tokens.test.ts` — token estimation + cost math.

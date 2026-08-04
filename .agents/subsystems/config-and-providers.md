# Subsystem: Config & Providers

Configuration resolution and the LLM provider layer. Files: `src/config/{schema,defaults,loader}.ts`, `src/providers/{interface,factory,openai-compatible,resilient}.ts`, plus per-model knobs `src/pipeline/{temperature,max-output}.ts` and error types `src/utils/errors.ts`.

Start here: [`../index.md`](../index.md) for context, [`../AGENTS.md`](../AGENTS.md) for non-negotiables. Related: [review pipeline](review-pipeline.md), [GitHub integration](github-integration.md).

## Config precedence (highest wins)

1. **Explicit Action inputs** (`action/index.ts`): `model`, `base_url`, `user_agent`, `language`, `fail_on`, `experimental` override the loaded repo config after `loadConfig`.
2. **App env vars** (webhooks.ts / index.ts): at provider construction, `appCtx.provider ?? config.provider`, `appCtx.model ?? config.model`, `appCtx.userAgent ?? config.userAgent`; `baseUrl` env always wins (no config fallback in App mode).
3. **Repo config** `.fiscalcr-review.yml` (path overridable via `config_path` input), fetched through the GitHub API.
4. **Built-in defaults** — `DEFAULT_CONFIG` in `src/config/defaults.ts`, mirrored by zod schema `.default()` values.

## Schema & defaults

- `src/config/schema.ts` — `reviewConfigSchema` (zod) is the **canonical** config definition. Shape: top-level `language` (en/zh-TW/zh-CN/ja/ko), `provider` (openai-compatible/kimi), `model`, `baseUrl`, `userAgent`, `temperature`, `experimental`; `review.{auto,aspects,minSeverity,maxAnnotations,failOn,incremental,comments}`; `files.{include,exclude,maxFileSize}`; `rules[]` (custom repo rules); `prompt.{systemAppend,reviewFocus}`; `pipeline.{enabled,concurrency,groupTokenBudget,relatedContextBudget,maxGroups,fastPathThreshold,minConfidence,maxRetries,callTimeoutMs,maxOutputTokens}`.
- `DEFAULT_EXCLUDE_PATTERNS` is a shared const used both by the schema default and `DEFAULT_CONFIG` specifically so the two cannot drift.
- `src/config/defaults.ts` — `DEFAULT_CONFIG`, a fully-populated `ReviewConfig` mirroring schema defaults. **Changing one without the other is a bug.**

## Loader (`src/config/loader.ts`)

`loadConfig(octokit, owner, repo, configPath)`:

- Fetches the file via `repos.getContent` (base64), `YAML.parse`, then `reviewConfigSchema.safeParse`.
- **Invalid config → throws `ConfigError`** (fails fast by design, per README).
- **Missing (404) → `DEFAULT_CONFIG`**.
- **Other API errors → rethrown** (never silently defaulted).

## Provider layer

### Interface (`interface.ts`)

```ts
interface LLMProvider {
  chatCompletion(params: ChatCompletionParams): Promise<LLMCompletionResponse>;
}
```

`ChatCompletionParams`: `messages`, `responseFormat` (`json_object` | `text`), `maxTokens`, `temperature`, `timeoutMs`. `LLMCompletionResponse`: `content`, `usage { input, output, cached }`, `finishReason` (`'length'` signals truncation at the token cap).

### Factory (`factory.ts`)

`createLLMProvider({ apiKey, model, baseUrl?, provider, userAgent?, retry? })`:

- `parseProvider` validates the name against `["openai-compatible", "kimi"]`; unknown → `ConfigError`.
- `openai-compatible` requires an explicit `baseUrl` (else `ConfigError`).
- `kimi` is a preset: default base URL `https://api.kimi.com/coding/v1` when none given.
- Both resolve to `OpenAICompatibleProvider`; the result is always wrapped in `ResilientProvider` (comment: adding non-compatible providers like Anthropic is straightforward).

### OpenAI-compatible adapter (`openai-compatible.ts`)

- `fetch POST {baseUrl}/chat/completions` with `Authorization: Bearer`, `User-Agent: fiscalcr/1.0` (or the configured `userAgent`; when a custom UA is set the `X-Client-Name: fiscalcr` header is omitted so the request carries one identity).
- Request body conditionally includes `temperature` (omitted when undefined — some models reject any non-default temperature), `max_tokens`, `response_format`.
- Timeout via `AbortController` (default 300s, per-call `timeoutMs` override).
- Non-2xx → `LLMApiError` carrying status, endpoint body snippet, and parsed `Retry-After` (seconds or HTTP-date).
- Usage mapped from `prompt_tokens` / `completion_tokens` / `cached_tokens`.

### Resilient decorator (`resilient.ts`)

Retry-with-backoff wrapper around any provider:

- Retryable: `LLMApiError` with status 429 or >= 500; `AbortError`/`TimeoutError` (our timeout); `TypeError` (fetch network failure). **Other 4xx (auth, bad request) never retried.**
- Backoff: exponential `1s * 2^attempt` with full jitter (50–100% of the window), capped at `maxBackoffMs` (default 30s); honors `Retry-After` when the API supplied it (still capped).
- Default `maxRetries` 3 (matches `pipeline.maxRetries` config surface, which flows through `config.retry` in the Action entry).

## Per-model knobs (config-adjacent)

- `src/pipeline/temperature.ts` — `reviewTemperature(config)`: explicit `config.temperature` wins; models that pin their own temperature (`kimi-for-coding`, `kimi-for-coding-highspeed`, `kimi-k3`) get no `temperature` field at all; otherwise 0.3.
- `src/pipeline/max-output.ts` — `reviewMaxOutputTokens(config)`: explicit `pipeline.maxOutputTokens` wins; Kimi models (by provider or model-name prefix) get 65536; everything else 32768. Short caps truncate structured JSON mid-generation.
- `src/utils/tokens.ts` — `estimateTokens` (~4 chars/token, ~2 for CJK) and `calculateCost` (single flat pricing table — a documented rough estimate across providers).

## Invariants

- Schema (`schema.ts`) and `defaults.ts` never drift; `DEFAULT_EXCLUDE_PATTERNS` exists to enforce this for the one shared list.
- Invalid repo config fails fast; missing config defaults; unrelated API errors propagate.
- Provider names are validated at construction; `openai-compatible` without `baseUrl` is a `ConfigError`, not a runtime 404.
- Retry only on transient errors (429/5xx/timeout/network); auth and bad-request errors fail immediately.
- JSON-format review calls always set `response_format: json_object` and a max-token cap so truncation is detectable and salvageable.

## Relevant tests

- `test/unit/config-loader.test.ts` — load from custom path, missing → defaults, non-404 rethrow.
- `test/unit/provider-factory.test.ts` — provider validation, baseUrl requirement, kimi preset.
- `test/unit/openai-compatible-provider.test.ts` — request shaping, error surfacing.
- `test/unit/resilient-provider.test.ts` — retry classification, backoff, Retry-After.
- `test/unit/temperature.test.ts`, `test/unit/max-output.test.ts` — per-model knob resolution.
- `test/unit/tokens.test.ts` — token estimation + cost math.

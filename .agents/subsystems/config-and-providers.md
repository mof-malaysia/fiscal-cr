# Subsystem: Config & Providers

Configuration loading, precedence, provider construction, and request policy.

Sources:

- Config: `src/config/{schema,defaults,loader,provider-models,overrides}.ts`
- Providers: `src/providers/{interface,factory,endpoints,prompt-cache,openai-compatible,anthropic,resilient,auth,federation}.ts`
- Model-ID parsing: `src/utils/model-ids.ts`
- Entrypoints: `action/{index,config,review-config}.ts`, `src/github/webhooks.ts`

See [provider models](provider-models.md) for stage resolution and [review
pipeline](review-pipeline.md) for call behavior.

## Config precedence

Highest priority wins:

1. **Action inputs**: `provider`, `model`, `model_params`, `base_url`,
   `user_agent`, `language`, `fail_on`, and `experimental`.
2. **App environment**: `MODEL_PROVIDER`, `MODEL`, `FISCALCR_MODEL`, `BASE_URL`,
   `FISCALCR_BASE_URL`, and `LLM_USER_AGENT`.
3. **Repo YAML**: `.fiscalcr-review.yml` (`config_path` can change it in Action
   mode).
4. **Defaults**: `DEFAULT_CONFIG` in `src/config/defaults.ts`.

Action loads policy at the PR head SHA and provider routing from the trusted
base SHA. App and Action model overrides pin the four core stages; provider
overrides apply before `provider-default` resolution. App base URL and user
agent values override repo values only when set.

`src/config/schema.ts` is canonical. It validates providers, models, stage overrides,
review policy, visualization, files, rules, prompts, and pipeline limits.
`defaults.ts` mirrors it. `DEFAULT_EXCLUDE_PATTERNS` is shared by both files.
`modelParams` validates known fields and passes other provider-native fields
through.

## Loader

`loadConfig(octokit, owner, repo, configPath = ".fiscalcr-review.yml", ref?)`:

- fetches base64 content through `repos.getContent`
- parses YAML and applies `reviewConfigSchema`
- throws `ConfigError` for invalid config
- returns `DEFAULT_CONFIG` for a missing file or non-regular content
- rethrows other API errors

## Model routing

`modelForRole` resolves `intent`, `fastPath`, `groupReview`, `synthesis`, and
`visualize`. It is the only stage-model resolver. See [provider
models](provider-models.md) for precedence, release defaults, and overrides.

## Provider layer

### Interface

```ts
interface LLMProvider {
  chatCompletion(params: ChatCompletionParams): Promise<LLMCompletionResponse>;
}
```

`ChatCompletionParams` carries messages, response format, token cap,
temperature, and timeout. Responses normalize content, token usage, and
finish reason (`length` signals truncation).

### Factory

`createLLMProvider({ apiKey? | federation?, model, baseUrl?, provider, userAgent?, modelParams?, promptCache?, retry? })`:

- validates against `PROVIDERS` (`src/config/schema.ts`), the single
  provider list; `SUPPORTED_PROVIDERS` re-exports it
- requires `baseUrl` for `openai-compatible`
- takes per-provider behavior from `PROVIDER_DEFAULTS`: base URL
  (`endpoints.ts`), token-cap field, API-key header, default `promptCache`,
  and Chat Completions `cacheStyle`
- uses the Messages API for `anthropic` and the Chat Completions adapter for
  the rest
- requires exactly one of `apiKey` or `federation`, and builds the adapter's
  `RequestAuth` (API keys use the provider's `apiKeyAuth`, default bearer)
- resolves `promptCache` (config value, else the provider default)
- wraps each adapter in `ResilientProvider`

Entry points (`action/index.ts`, `src/github/webhooks.ts`, `eval/runtime.ts`)
spread `providerOptionsFromConfig(config)` (model, `modelParams`,
`promptCache`) and add only what they override. Wire a new config-driven
provider option there, not at each call site. The eval pins
`promptCache: 'off'` so per-variant cost does not depend on run order.

### Prompt caching

`prompt-cache.ts` owns every caching rule; adapters only call it.

- Only the system prompt is marked: it depends on repo config alone, so it
  repeats across calls, stages, and PRs.
- Chat Completions styles: `cache-control` (Anthropic-style marker on the
  system block; openrouter, openai-compatible), `openai` (GPT-5.6+
  `prompt_cache_options.mode: explicit` + `prompt_cache_breakpoint`; `off` =
  explicit mode, no breakpoint), `kimi` (`prompt_cache_options`).
- Writes are reported as `usage.cacheWrite = { tokens, premium }`, where
  `premium` is the extra cost over base input chosen by who wrote the cache
  (Anthropic 5m and OpenAI GPT-5.6+: 0.25; 1h: 1; Kimi 5m and other automatic
  caches: 0). `pricing.ts` applies it without knowing TTLs.

### Adding a provider

1. Add the name to `PROVIDERS` in `src/config/schema.ts` (enum, factory
   validation, and the "requires `model`" error all derive from it).
2. Add a `PROVIDER_DEFAULTS` entry in `src/providers/factory.ts`: base URL
   (in `endpoints.ts`), token-cap field, API-key header, default
   `promptCache`, and `cacheStyle` (add a style in `prompt-cache.ts` if none
   fits).
3. Release models: add to `PROVIDER_DEFAULT_MODELS` and run
   `pnpm models:sync`, or leave it out to require `model`.
4. Pricing: add a table to `PROVIDER_PRICING` in `src/utils/pricing.ts`.
5. Federation (optional): see below.
6. Docs: provider lists in `README.md`, `action.yml`, `action/action.yml`,
   and `docs/llm-evaluation.md`; the README "Prompt caching" table.
7. Tests: `provider-factory` (construction and cache hint), plus adapter
   tests for any new cache style.

### Auth and workload identity federation

- `auth.ts` is provider-agnostic: `RequestAuth` (headers + optional
  `invalidate`), `staticAuth`/`bearerAuth`, `federatedAuth` (fresh identity
  token per exchange, cached access token, refresh 120s before expiry,
  single-flight), and `fetchWithAuth` (one re-auth on 401 for refreshable auth).
  Both adapters send requests through `fetchWithAuth`.
- `federation.ts` holds per-provider token exchanges: `FEDERATION_EXCHANGES`
  (accepted providers, default OIDC audience) plus `tokenExchangeFor()`. Only
  `anthropic` exists (RFC 7523 jwt-bearer at `{baseUrl}/oauth/token`). To add
  one: extend `FederationExchangeConfig`, add a registry entry and a
  `tokenExchangeFor()` case, and add an input parser to `EXCHANGE_PARSERS` in
  `action/federation.ts`.
- The Action's identity token source is GitHub OIDC (`core.getIDToken`);
  federation inputs come only from the workflow, never repo config.

`modelParams` merges into every request. Adapters remove pipeline-owned fields
such as model identity, messages, token caps, temperature, response format, and
streaming.

### OpenAI-compatible adapter

- Posts to `{baseUrl}/chat/completions` with its `RequestAuth` headers.
- Sends `User-Agent: fiscalcr/1.0`, or the configured user agent.
- Omits temperature when the resolved model requires the server default.
- Aborts after the configured timeout (default 300s).
- Maps `prompt_tokens`, `completion_tokens`, `cached_tokens`, and
  `cache_write_tokens` (priced via `chatCacheWrite`).
- Converts non-2xx responses to `LLMApiError` with status, body snippet, and
  parsed `Retry-After`.

### Anthropic adapter

- Posts to `{baseUrl}/messages` with its `RequestAuth` headers (`x-api-key` or a
  federated bearer token) and `anthropic-version: 2023-06-01`.
- Moves system messages into the top-level `system` field.
- Normalizes input, cache, and output token usage; cache writes are priced
  from Anthropic's per-TTL split (`anthropicCacheWrite`).
- Uses an explicit JSON-only instruction because Messages has no shared
  `response_format` field.

## Retries

`ResilientProvider` retries 429, 5xx, timeout, abort, and network errors.
Authentication and other 4xx errors fail immediately. Backoff is exponential
with 50–100% jitter, capped at 30s, and honors `Retry-After`.

Production factories default to three retries after the initial call.
`pipeline.maxRetries` is validated configuration but does not alter that
provider default.

## Per-model controls

- `temperature.ts`: explicit config wins; Kimi, OpenAI reasoning models, and
  Claude models that reject sampling params (5.x+, Opus 4.7+) omit
  temperature; other models use the preferred value (`0.3`).
- `model-ids.ts`: model-family checks used above and by prompt caching. All
  helpers strip OpenRouter vendor prefixes (`anthropic/claude-…`).
- `max-output.ts`: explicit `pipeline.maxOutputTokens` wins; Kimi defaults to
  65,536 completion tokens and other models to 32,768.
- `tokens.ts`: estimates input size and calculates approximate cost.

## Invariants

- Schema and defaults remain structurally compatible.
- Invalid repo config fails fast; missing config defaults; other API errors
  propagate.
- Stage calls use `modelForRole`; the five roles remain strict.
- `openai-compatible` without `baseUrl` is a `ConfigError`.
- Retry classification excludes auth and bad-request errors.
- JSON calls set a response format and token cap so truncation is detectable.
- System prompts depend only on repo config, never on the PR. Prompt caching
  keys on them, so PR-specific text there silently zeroes the hit rate
  (`run-review` test: "system prompts are cache-stable across pull requests").

## Relevant tests

- Config and overrides: `config-loader`, `config-overrides`, `action-config`,
  `action-model-params`, `action-experimental`, `action-federation`
- Provider mapping: `provider-factory`, `openai-compatible-provider`,
  `anthropic-provider`, `resilient-provider`, `auth`, `federation`
- Prompt caching: `openai-compatible-provider`, `anthropic-provider`,
  `provider-factory`, `pricing`, `run-review` (system-prompt stability)
- Per-model controls: `temperature`, `max-output`, `tokens`

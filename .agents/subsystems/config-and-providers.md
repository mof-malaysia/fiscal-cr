# Subsystem: Config & Providers

Configuration loading, precedence, provider construction, and request policy.

Sources:

- Config: `src/config/{schema,defaults,loader,model-presets,overrides}.ts`
- Providers: `src/providers/{interface,factory,openai-compatible,anthropic,resilient}.ts`
- Entrypoints: `action/{index,config,review-config}.ts`, `src/github/webhooks.ts`

See [model presets](model-presets.md) for stage resolution and [review
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

`src/config/schema.ts` is canonical. It validates providers, models, presets,
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
`visualize`. It is the only stage-model resolver. See [model
presets](model-presets.md) for precedence, built-ins, validation, and overrides.

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

`createLLMProvider({ apiKey, model, baseUrl?, provider, userAgent?, modelParams?, retry? })`:

- validates `openai-compatible`, `kimi`, `openai`, or `anthropic`
- requires `baseUrl` for `openai-compatible`
- defaults Kimi to `https://api.kimi.com/coding/v1`
- defaults OpenAI to `https://api.openai.com/v1` and uses
  `max_completion_tokens`
- defaults Anthropic to `https://api.anthropic.com/v1` and uses its Messages API
- wraps each adapter in `ResilientProvider`

`modelParams` merges into every request. Adapters remove pipeline-owned fields
such as model identity, messages, token caps, temperature, response format, and
streaming.

### OpenAI-compatible adapter

- Posts to `{baseUrl}/chat/completions` with bearer auth.
- Sends `User-Agent: fiscalcr/1.0`, or the configured user agent.
- Omits temperature when the resolved model requires the server default.
- Aborts after the configured timeout (default 300s).
- Maps `prompt_tokens`, `completion_tokens`, and `cached_tokens`.
- Converts non-2xx responses to `LLMApiError` with status, body snippet, and
  parsed `Retry-After`.

### Anthropic adapter

- Posts to `{baseUrl}/messages` with `x-api-key` and
  `anthropic-version: 2023-06-01`.
- Moves system messages into the top-level `system` field.
- Normalizes input, cache, and output token usage.
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

- `temperature.ts`: explicit config wins; Kimi and OpenAI reasoning models omit
  temperature; other models use the preferred value (`0.3`).
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

## Relevant tests

- Config and overrides: `config-loader`, `config-overrides`, `action-config`,
  `action-model-params`, `action-experimental`
- Provider mapping: `provider-factory`, `openai-compatible-provider`,
  `anthropic-provider`, `resilient-provider`
- Per-model controls: `temperature`, `max-output`, `tokens`

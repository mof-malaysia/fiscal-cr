# Subsystem: Model Presets

Deep-dive on `modelPreset` / `modelPresets` / `models` stage routing: how every pipeline stage gets its model, from repo YAML through validation to the LLM call. Files: `src/config/model-presets.ts` (built-ins + resolvers), `src/config/schema.ts` (`modelForRole`, zod fields, validation), `src/config/defaults.ts` (`DEFAULT_CONFIG` missing-file fallback).

Start here: [`../index.md`](../index.md) for context, [`../AGENTS.md`](../AGENTS.md) for non-negotiables. Related: [config & providers](config-and-providers.md) (full config/loader/provider precedence ladder, per-model knobs), [review pipeline](review-pipeline.md) (what each stage call does).

## Purpose

`provider-default` auto-picks the preset matching the effective repo provider.
The current built-ins use latest provider models: Kimi K3, OpenAI GPT-5.6, and
Anthropic Claude Fable/Sonnet 5.

## Source files

- `src/config/model-presets.ts` — `BUILTIN_MODEL_PRESET_NAMES`, `MODEL_PRESETS` (exact built-in stage maps), `presetForProvider`, `resolvePresetName`, `resolveStageMapFor`.
- `src/config/schema.ts` — `reviewConfigSchema` fields `model` / `models` / `modelPreset` / `modelPresets`, the `.superRefine` preset-name check, `ModelRole`, and `modelForRole` (the single resolver every call site uses).
- `src/config/defaults.ts` — `DEFAULT_CONFIG` (used when the config file is missing); unlike schema defaults, it explicitly populates all four `models` stage values.

## Config shape

Stage keys (`ModelRole`): `intent` (Pass 1 intent call), `fastPath` (fast-path combined call), `groupReview` (Pass 2 per-group reviews), `synthesis` (Pass 3 synthesis).

| Key | Type | Default | Meaning |
| --- | --- | --- | --- |
| `model` | string | `k3` | Legacy top-level fallback; used when neither a stage nor a preset resolves |
| `models` | `{ intent?, fastPath?, groupReview?, synthesis? }` — `.strict()` | `{}` | Explicit per-stage overrides; unset stages fall through to preset → `model` |
| `modelPreset` | string | absent | Selector: a built-in name (`provider-default`, `kimi`, `openai`, `anthropic`) or any name defined under `modelPresets` |
| `modelPresets` | `Record<name, { intent?, fastPath?, groupReview?, synthesis? }>` — `.strict()` | absent | Custom partial stage maps; an entry under a built-in name merges over that built-in |

All stage values and preset names require `min(1)` — empty strings are rejected.

**Schema versus missing-config defaults:** `{}` in this table is the `reviewConfigSchema` default for an explicit YAML config. `loadConfig` returns `DEFAULT_CONFIG` only when the config file is missing, and that object includes the fully populated Kimi stage map. An explicit YAML config may omit `models` (including an empty file); schema parsing then produces `models: {}`, so stage resolution uses the selected preset and ultimately the top-level `model`.

## Built-in presets

Exact stage maps from `MODEL_PRESETS`:

| Preset | `intent` | `fastPath` | `groupReview` | `synthesis` |
| --- | --- | --- | --- | --- |
| `kimi` | `k3-256k` | `k3-256k` | `k3` | `k3` |
| `openai` | `gpt-5.6-terra` | `gpt-5.6-terra` | `gpt-5.6-sol` | `gpt-5.6-sol` |
| `anthropic` | `claude-sonnet-5` | `claude-sonnet-5` | `claude-fable-5` | `claude-fable-5` |

```yaml
# Select any built-in directly:
provider: kimi
modelPreset: kimi
```

```yaml
provider: openai
modelPreset: openai
```

```yaml
provider: anthropic
modelPreset: anthropic
```

## provider-default

`provider-default` is a **selector, not a map**: `resolvePresetName` delegates to `presetForProvider(config.provider)` — `kimi` → `kimi` preset, `openai` → `openai`, `anthropic` → `anthropic`. `openai-compatible` (and any unknown provider) has **no preset** (`presetForProvider` returns `undefined`), so every stage falls back to the top-level `model`.

```yaml
provider: anthropic
modelPreset: provider-default   # resolves to the anthropic preset
```

Resolution reads the effective `config.provider`: the Action `provider` input / App `MODEL_PROVIDER` env override update it before model routing, so `provider-default` selects the same provider used for API calls.

## Custom modelPresets

`modelPresets` maps a preset name to a **partial** stage object. Unset stages fall back to the top-level `model`; the name becomes selectable via `modelPreset`.

```yaml
provider: openai
model: gpt-4.1-mini            # fallback for stages the preset does not set
modelPreset: team
modelPresets:
  team:
    intent: gpt-4.1-mini
    groupReview: gpt-5
```

An entry under a **built-in name merges over that built-in** (`resolveStageMapFor` spreads `{ ...builtin, ...user }` — user stages win):

```yaml
modelPreset: kimi
modelPresets:
  kimi:
    intent: my-custom-intent-model   # kimi's other three stages stay built-in
```

A preset with neither a built-in nor a user entry resolves to `undefined`, so the top-level `model` applies.

## Precedence

`modelForRole(config, role)` resolves in this order (first hit wins):

1. **Explicit `models.<role>`** — always wins.
2. **Selected preset's merged stage map** — `resolveStageMapFor(resolvePresetName(config), config.modelPresets)`, i.e. built-in map overlaid with the user's same-name entry.
3. **Top-level `model`** — legacy fallback.

```yaml
provider: openai
modelPreset: openai            # synthesis would be gpt-5
models:
  synthesis: gpt-5-pro         # explicit stage wins → gpt-5-pro
```

**Omitted selector (legacy behavior):** no `modelPreset` → `resolvePresetName` returns `undefined` → `modelForRole` reduces to `models[role] ?? config.model`, so configs that only set `model` keep their single-model behavior. `openai-compatible` under `provider-default` behaves the same way.

## Global overrides

Above everything in [Precedence](#precedence), an explicit global model pins **all** stages, bypassing `models`/presets entirely:

- **Action** (`action/index.ts`): the `model` input, when provided, sets `config.model` and all four `config.models.*` stages. There is **no Action input for preset selection** — `action.yml` exposes only `api_key`, `github_token`, `provider`, `model`, `base_url`, `user_agent`, `language`, `model_params`, `fail_on`, `config_path`, `experimental`, `telemetry`.
- **App** (`src/index.ts` → `src/github/webhooks.ts`): `MODEL` (alias `FISCALCR_MODEL`) is passed through `applyModelOverride`, which pins `config.model` and all four stages. No App env var selects a preset.

Both entry points construct the LLM provider with `modelForRole(config, "groupReview")` — the group-review stage dominates the token budget.

## Validation and fail-fast

- **Unknown `modelPreset` name** → `.superRefine` issue (must be a built-in or defined under `modelPresets`); empty names rejected by `min(1)`.
- **Unknown stage keys** in `models` or in any `modelPresets` entry → rejected by `.strict()` — including the legacy `big`/`small` role keys, which fail loudly instead of silently disappearing. The `big`/`small` terminology is dead; only the rejection note above references it.
- **Non-string / empty stage values** → rejected (`min(1)`).
- **Fail-fast**: `loadConfig` (`src/config/loader.ts`) runs `reviewConfigSchema.safeParse` on the repo `.fiscalcr-review.yml`; any validation failure throws `ConfigError` — invalid config never runs, never silently defaults. Missing config file (404) → `DEFAULT_CONFIG`.

## Consumers

All stage calls resolve via `modelForRole`:

- `src/pipeline/fast-path.ts` → `modelForRole(config, "fastPath")`
- `src/pipeline/pass1-intent.ts` → `modelForRole(config, "intent")`
- `src/pipeline/pass2-review.ts` → `modelForRole(config, "groupReview")`
- `src/pipeline/pass3-synthesis.ts` → `modelForRole(config, "synthesis")`
- Provider construction (`action/index.ts`, `src/github/webhooks.ts`) and pricing (`src/review/orchestrator.ts`) → `modelForRole(config, "groupReview")`

Per-model knobs consume the **resolved** stage model: `src/pipeline/max-output.ts` (`reviewMaxOutputTokens`, Kimi models get 65536 vs 32768) and `src/pipeline/temperature.ts` (`reviewTemperature`, Kimi models and OpenAI reasoning models omit `temperature`). Both default their `model` param to the legacy `config.model` for old callers. See [config & providers](config-and-providers.md) for the provider factory itself.

## Tests

- `test/unit/config-loader.test.ts` — resolution + validation: built-in selection, `provider-default` mapping, `openai-compatible` fallback, `models.*` over preset, custom presets, same-name merge over built-in, unknown preset / unknown stage key / legacy `big`/`small` rejection, empty names.
- `test/unit/fast-path.test.ts`, `test/unit/orchestrator-pipeline.test.ts`, `test/unit/pass3-synthesis.test.ts` — stage-model routing (`fastPath`/`intent`/`groupReview`/`synthesis`) end to end.

## Change recipe

- **Add a built-in preset**: add the stage map to `MODEL_PRESETS` in `model-presets.ts`; if it should be selectable by name, add it to `BUILTIN_MODEL_PRESET_NAMES`; if it's a new provider's default, extend `presetForProvider`. Add a `config-loader.test.ts` case; check `temperature.ts` / `max-output.ts` for model-name assumptions.
- **Change a stage model inside a built-in**: edit `MODEL_PRESETS` only; the resolver, validation, and tests pick it up. Verify the stage-routing tests still pass.
- **Change merge / resolution behavior**: `resolveStageMapFor` / `resolvePresetName` in `model-presets.ts` plus `modelForRole` in `schema.ts`; update `config-loader.test.ts` expectations.
- **Change validation**: `models` / `modelPresets` `.strict()` shape or the `superRefine` preset-name check in `schema.ts`; keep unknown-name / unknown-key rejection.
- **Never add an Action input or App env var for preset selection** without updating `action.yml`, `action/index.ts`, `src/index.ts`, README, and regenerating `action/dist/` — the current contract is presets are repo-YAML only.
- Keep `DEFAULT_CONFIG` structurally compatible with `ReviewConfig`; its populated `models` map is intentional and must not be replaced with the schema's `{}` default.

## Invariants

- Every stage model resolves through `modelForRole`; no pipeline call site reads `config.model` directly for its stage model (per-model knobs default to it only as a legacy fallback).
- Precedence order never changes: `models.<stage>` > selected preset stage > top-level `model`; Action `model` / App `MODEL`/`FISCALCR_MODEL` sit above all of it by pinning `models.*`.
- Presets are YAML-only — no Action input or App env selects one.
- `provider-default` resolves from the effective provider after Action/App provider overrides, not the stale repository value.
- Unknown preset names and unknown stage keys (including legacy `big`/`small`) fail validation fast; nothing is silently ignored.
- `schema.ts` and `defaults.ts` remain structurally compatible; their `models` defaults intentionally differ (`{}` for schema-parsed YAML, populated Kimi stages for missing-config fallback).

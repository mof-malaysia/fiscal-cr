# Subsystem: Model Presets

Defines stage-model resolution from repo YAML to each LLM call.

Sources:

- `src/config/model-presets.ts`: built-in maps and resolvers
- `src/config/schema.ts`: fields, validation, `modelForRole`
- `src/config/defaults.ts`: missing-file fallback

See [config & providers](config-and-providers.md) for loading and provider
construction. See [review pipeline](review-pipeline.md) for call behavior.

## Stage roles

| Role | Call |
| --- | --- |
| `intent` | Pass 1 intent and grouping |
| `fastPath` | Small-PR combined review |
| `groupReview` | Pass 2 per-group review |
| `synthesis` | Pass 3 final review |
| `visualize` | Optional full-review visualization |

## Config fields

| Field | Meaning |
| --- | --- |
| `model` | Top-level fallback; default `k3` |
| `models` | Explicit per-stage overrides; default `{}` |
| `modelPreset` | Built-in or custom preset selector |
| `modelPresets` | Named partial stage maps |

Stage names and model values must be non-empty. Unknown stage keys fail
because both stage-map schemas are strict.

Missing config uses `models: {}` and `modelPreset: provider-default`.
Explicit YAML without `modelPreset` keeps legacy `models.<stage>` → `model`
routing.

## Built-in presets

Built-ins are `kimi`, `openai`, and `anthropic`. See the
[README model matrix](../../README.md#model-presets) for current stage values.
`provider-default` selects the preset matching the effective provider.
`openai-compatible` has no built-in preset and falls back to `model`.

## Resolution

`modelForRole(config, role)` uses:

1. `models.<role>`
2. the selected preset stage
3. top-level `model`

For `visualize`, the final fallback is the resolved `fastPath` model. Omitting
`modelPreset` skips step 2. A selected built-in map can be overlaid by a
same-name user entry; user values win.

```yaml
provider: openai
model: gpt-4.1-mini
modelPreset: team
modelPresets:
  team:
    intent: gpt-4.1-mini
    groupReview: gpt-5
```

An entry under a built-in name changes only the supplied stages:

```yaml
modelPreset: kimi
modelPresets:
  kimi:
    intent: my-custom-intent-model
```

## Action and App overrides

An explicit Action `model` input or App `MODEL`/`FISCALCR_MODEL` value sets
`config.model` and the four core stages (`intent`, `fastPath`, `groupReview`,
`synthesis`). It does not replace `visualize`; that role keeps its explicit or
preset model, then uses the overridden `fastPath` fallback.

There is no Action input or App variable for preset selection. Both entry
points construct the provider from the resolved `groupReview` model.

## Validation

- Unknown preset names fail in `reviewConfigSchema.superRefine`.
- Unknown stage keys fail through strict stage maps.
- Empty preset names and model values fail `min(1)`.
- `loadConfig` throws `ConfigError` for invalid YAML; a missing file returns
  `DEFAULT_CONFIG`.

## Consumers

- `fast-path.ts` → `fastPath`
- `pass1-intent.ts` → `intent`
- `pass2-review.ts` → `groupReview`
- `pass3-synthesis.ts` → `synthesis`
- `visualize.ts` → `visualize`
- Provider construction and pricing → `groupReview`

`temperature.ts` and `max-output.ts` receive the resolved stage model. Their
optional model argument still defaults to top-level `config.model` for older
callers.

## Tests

- `test/unit/config-loader.test.ts`: selection, fallback, merge, precedence,
  and validation
- `test/unit/fast-path.test.ts`, `orchestrator-pipeline.test.ts`,
  `pass3-synthesis.test.ts`: stage routing
- Visualization tests cover the `visualize` stage and output rendering.

## Change recipe

- Add a built-in map in `MODEL_PRESETS`; extend
  `BUILTIN_MODEL_PRESET_NAMES` if users should select it.
- Extend `presetForProvider` if it is a provider default.
- Change resolution in `resolvePresetName`, `resolveStageMapFor`, or
  `modelForRole`; update config and stage-routing tests.
- Preserve strict unknown-name and unknown-key rejection.
- Keep `DEFAULT_CONFIG` compatible with the schema.

## Invariants

- Pipeline calls resolve through `modelForRole`.
- Precedence is explicit stage → preset stage → top-level model.
- Visualization falls back to resolved `fastPath`.
- Action/App model overrides affect only the four core stages.
- Presets remain repo-YAML only.

# Subsystem: Provider Models

Defines stage-model resolution from provider and repo YAML to each LLM call.
Model choice is coupled to the FiscalCR release: consumers pick a `provider`
and get the models this version's prompts were tuned against.

Sources:

- `src/config/provider-models.ts`: release-pinned stage models per provider
- `src/config/schema.ts`: fields, validation, `modelForRole`, `hasModelOverride`
- `src/config/defaults.ts`: missing-file fallback
- `scripts/sync-provider-models.ts`: regenerates the README model table

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
| `model` | Optional override for every stage; required for `openai-compatible` |
| `models` | Explicit per-stage overrides; default `{}` |

`modelPreset` / `modelPresets` were removed. `loadConfig` logs a warning and
zod strips them. Stage maps are strict, so unknown stage keys fail.

## Resolution

`modelForRole(config, role)` uses:

1. `models.<role>` (`visualize` with `model` set: then resolves like `fastPath`)
2. top-level `model`
3. `PROVIDER_DEFAULT_MODELS[provider][role]`
4. `visualize` only: the resolved `fastPath` model
5. otherwise throws `ConfigError` (`openai-compatible` without `model`)

The Action logs the resolved model for every stage and warns when
`hasModelOverride` is true. PR-head config may override models; that is
intentional, for beta-testing models from a branch.

## Action and App overrides

An explicit Action `model` input or App `MODEL`/`FISCALCR_MODEL` value sets
`config.model` and the four core stages (`intent`, `fastPath`, `groupReview`,
`synthesis`). `visualize` keeps an explicit `models.visualize`, otherwise it
uses `model`. Both entry points construct the provider from the resolved
`groupReview` model.

## Upgrading release models

1. Edit `PROVIDER_DEFAULT_MODELS` in `src/config/provider-models.ts`, and
   `RELEASE_MODEL_PARAMS` for per-model request params (e.g. `reasoning_effort`).
   The OpenAI adapter sends them under operator `modelParams`, which win.
2. Run `pnpm models:sync` to regenerate the README model table.
3. Run `pnpm test`. Guards catch the rest:
   - every default model needs a pricing entry in `src/utils/pricing.ts`
     (or an explicit `UNPRICED_DEFAULTS` exception)
   - the README table must match the map
   - routing tests read `PROVIDER_DEFAULT_MODELS`, so no literals to update
4. Check `src/pipeline/temperature.ts` (sampling-param rules) and
   `src/pipeline/max-output.ts` when moving to a new model family.
5. Ship as a minor release and name the new models in the changelog.

## Consumers

- `fast-path.ts` → `fastPath`
- `pass1-intent.ts` → `intent`
- `pass2-review.ts` → `groupReview`
- `pass3-synthesis.ts` → `synthesis`
- `visualize.ts` → `visualize`
- Provider construction and pricing → `groupReview`

`temperature.ts` and `max-output.ts` receive the resolved stage model. Their
optional model argument defaults to the resolved `groupReview` model.

## Tests

- `test/unit/provider-models.test.ts`: README sync, pricing coverage
- `test/unit/config-loader.test.ts`: precedence, removed keys, validation
- `test/unit/fast-path.test.ts`, `orchestrator-pipeline.test.ts`,
  `pass3-synthesis.test.ts`: stage routing

## Invariants

- Pipeline calls resolve through `modelForRole`.
- Precedence is explicit stage → `model` → release default.
- Visualization falls back to resolved `fastPath`.
- `provider-models.ts` is the only hand-edited source of default models.

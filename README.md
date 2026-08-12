# FiscalCR

AI-powered, model-agnostic code review for GitHub pull requests.

[GitHub Action](#quick-start--github-action) · [Self-Hosted GitHub App](#self-hosted-github-app) · [Configuration](#configuration)

## Features

- Model-agnostic provider support with native Anthropic, OpenAI, Kimi, and OpenAI-compatible APIs
- Full-PR review with inline GitHub annotations and summary comments
- Repo-level configuration via `.fiscalcr-review.yml`
- GitHub Action and self-hosted GitHub App modes
- Multilingual reviews in `en`, `zh-TW`, `zh-CN`, `ja`, and `ko`

## Quick Start — GitHub Action

### 1. Add secrets

In your repository, add the secret for your LLM provider:

| Secret        | Use for                                 |
| ------------- | --------------------------------------- |
| `LLM_API_KEY` | Your Anthropic, OpenAI, Kimi, or compatible provider API key |

### 2. Create the workflow

```yaml
# .github/workflows/fiscalcr-review.yml
name: FiscalCR Review

on:
  pull_request:
    types: [opened, synchronize, reopened, ready_for_review, review_requested]

permissions:
  contents: read
  pull-requests: write
  checks: write

# Prevent two reviews of the same PR from racing each other's state
concurrency:
  group: fiscalcr-${{ github.event.pull_request.number }}
  cancel-in-progress: false

jobs:
  review:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: mof-malaysia/fiscal-cr@main
        with:
          api_key: ${{ secrets.LLM_API_KEY }}
          provider: openai-compatible
          model: gpt-4.1-mini
          base_url: https://your-llm-provider.com/v1
```

### Action inputs

| Input          | Required | Default behavior                | Description                                                       |
| -------------- | -------- | ------------------------------- | ----------------------------------------------------------------- |
| `api_key`      | Yes      | —                               | LLM API key                                                       |
| `github_token` | No       | `${{ github.token }}`           | GitHub token for API access                                       |
| `provider`     | No       | Repo config or built-in default | `openai-compatible`, `kimi`, `openai`, or `anthropic`          |
| `model`        | No       | Repo config or built-in default | Model name; global override for every stage                      |
| `base_url`     | No       | Repo config                     | Provider base URL override                                        |
| `user_agent`   | No       | `fiscalcr/1.0`                  | Custom User-Agent for endpoints that whitelist clients (see note) |
| `language`     | No       | Repo config or built-in default | Review language override                                          |
| `fail_on`      | No       | Repo config or built-in default | `critical`, `warning`, or `never`                                 |
| `config_path`  | No       | `.fiscalcr-review.yml`          | Path to config file relative to repo root                         |
| `telemetry`    | No       | `false`                         | Emit metrics-only token telemetry to Action logs                  |
| `experimental` | No       | Repo config or `false`          | Enable experimental prompt optimizations                          |

### Action outputs

| Output              | Description                          |
| ------------------- | ------------------------------------ |
| `review_summary`    | Review summary text                  |
| `annotations_count` | Number of inline annotations created |
| `critical_count`    | Number of critical issues found      |
| `tokens_used`       | Total input + output tokens          |
| `cost_estimate`     | Estimated API cost in USD            |

### Notes on precedence

- Repo config is loaded from `.fiscalcr-review.yml` by default.
- Action inputs override repo config only when you explicitly provide them.
- Model presets (`modelPreset` selector, `modelPresets` custom maps) are
  configured in the repo's `.fiscalcr-review.yml`; there is no Action input
  for preset selection. The `model` input remains a global override and wins
  over every pipeline stage, including stages a preset would select. A
  `provider` input override also becomes effective for `provider-default`
  selection, so stage models match the provider used for API calls.
- `openai-compatible` requires an explicit `base_url`.
- `anthropic` uses the native Messages API and defaults to
  `https://api.anthropic.com/v1`; its API key is sent in `x-api-key`.

### Token telemetry

Set `telemetry: true` to emit structured lines prefixed with
`[fiscalcr-telemetry]` in the GitHub Actions log. Events contain token counts,
pipeline stage, timing, output limits, and finding counts. They never contain
prompts, source code, secrets, repository or pull request identifiers, or file
paths. Telemetry is disabled by default and is not sent to an external service.
`calls` counts pipeline-level LLM invocations; transparent provider retries are
not counted separately.

### Experimental features

Set `experimental: true` in `.fiscalcr-review.yml`, or pass the explicit Action
input, to enable experimental prompt optimizations. These optimizations may
change between releases. The default is `false`, preserving stable prompts.

### Endpoints that whitelist clients

Some provider endpoints whitelist clients by their `User-Agent` header and
reject unknown ones — including FiscalCR's default `fiscalcr/1.0`. Set the
`user_agent` input (or `userAgent` in `.fiscalcr-review.yml`, or
`LLM_USER_AGENT` in App mode) to an identifier the endpoint accepts. When a
custom User-Agent is set, the `X-Client-Name: fiscalcr` header is omitted so
the request carries one identity.

> ⚠️ Some providers treat tampering with the client identifier as a terms
> violation. Configure this at your own risk.

A few models reject any sampling temperature other than their server-side
default. FiscalCR omits the `temperature` parameter for those models (all
others use `0.3`; set a top-level `temperature:` in `.fiscalcr-review.yml` to
override).

## Self-Hosted GitHub App

Use the app when you want comment-driven reviews such as `@fiscalcr review` on pull requests.

### Setup

```bash
git clone https://github.com/mof-malaysia/fiscal-cr.git
cd fiscal-cr
pnpm install
cp .env.example .env
pnpm dev
```

### Environment variables

| Variable                | Required | Description                                 |
| ----------------------- | -------- | ------------------------------------------- |
| `API_KEY`               | Yes      | Provider API key                            |
| `FISCALCR_API_KEY`      | Optional | Alternate API key env name                  |
| `MODEL_PROVIDER`        | Optional | Provider name (`openai-compatible`, `kimi`, `openai`, or `anthropic`) |
| `MODEL`                 | Optional | Model name; global override for every stage |
| `BASE_URL`              | Optional | Operator-controlled base URL                |
| `LLM_USER_AGENT`        | Optional | Custom User-Agent for whitelisted endpoints |
| `GITHUB_APP_ID`         | Yes      | GitHub App ID                               |
| `GITHUB_PRIVATE_KEY`    | Yes      | GitHub App private key                      |
| `GITHUB_WEBHOOK_SECRET` | Yes      | Webhook secret                              |
| `PORT`                  | No       | Server port, default `3000`                 |
| `LOG_LEVEL`             | No       | Log level, default `info`                   |

Model presets (`modelPreset` selector, `modelPresets` custom maps) are
configured per repo in `.fiscalcr-review.yml`; there is no App-level env var
for preset selection. `MODEL` (alias `FISCALCR_MODEL`) remains a global
override that wins over every pipeline stage, including preset-derived
models. `MODEL_PROVIDER` overrides the effective provider and therefore changes
which preset `provider-default` selects; stage models match the provider used
for API calls.

### Comment commands

| Command            | Description                 |
| ------------------ | --------------------------- |
| `@fiscalcr review` | Run a full review on the PR |
| `@fiscalcr help`   | Show available commands     |

### Webhook events

| Event                           | Trigger                     |
| ------------------------------- | --------------------------- |
| `pull_request.opened`           | PR created                  |
| `pull_request.synchronize`      | New commits pushed          |
| `pull_request.review_requested` | Review requested            |
| `issue_comment.created`         | `@fiscalcr` command comment |

## Configuration

Create `.fiscalcr-review.yml` in your repository root:

```yaml
language: en
provider: openai-compatible
model: kimi-for-coding-highspeed
modelPreset: kimi # optional; built-in or custom preset — explicit models.* stages win (see "Model presets")
# modelPresets: # optional; custom named presets, selectable via modelPreset
#   fast:
#     intent: gpt-5-mini
#     groupReview: gpt-5
models:
  intent: kimi-for-coding-highspeed
  fastPath: kimi-for-coding
  groupReview: kimi-for-coding
  synthesis: kimi-for-coding
baseUrl: https://your-llm-provider.com/v1
# userAgent: MyCodingAgent/2.1.0   # only for endpoints that whitelist clients
experimental: false # opt in to prompt optimizations that may change between releases

review:
  auto:
    enabled: true
    onOpen: true
    onPush: true
    onReviewRequest: true
    drafts: false
  aspects:
    bugs: true
    security: true
    performance: true
    style: true
    bestPractices: true
    documentation: false
    testing: false
  minSeverity: suggestion
  maxAnnotations: 30
  failOn: critical
  incremental:
    enabled: true # re-review only files changed since the last reviewed commit
    maxDeltaFiles: 150 # larger deltas fall back to a full review
  comments:
    mode:
      sticky # one updated summary comment + small incremental reviews
      # 'legacy' → stack a full review on every run (pre-v2 behavior)
    dedupe: true # never re-post a finding that was already posted
    resolveOutdated: true # auto-resolve threads whose finding no longer occurs
    maxOpenComments: 100 # cumulative inline cap; overflow goes to check-run annotations

files:
  include:
    - "**/*"
  exclude:
    - "**/node_modules/**"
    - "**/dist/**"
    - "**/build/**"
    - "**/*.lock"
    - "**/*.min.*"
    - "**/package-lock.json"
    - "**/yarn.lock"
    - "**/pnpm-lock.yaml"
  maxFileSize: 100000

rules:
  - name: no-console-log
    description: "No console.log in production code"
    severity: warning
    filePattern: "src/**/*.ts"

prompt:
  systemAppend: "Pay special attention to SQL injection risks"
  reviewFocus: "Focus on API input validation and error handling"

pipeline:
  enabled: true # false → single-call review regardless of PR size (legacy behavior)
  concurrency: 3 # parallel group-review calls (1–8)
  groupTokenBudget: 40000 # max tokens of file content per review group
  relatedContextBudget: 15000 # tokens of unchanged imported files per group (Action mode only)
  maxGroups: 8 # overflow groups are reviewed diff-only
  fastPathThreshold: 25000 # PRs under this total use a single combined call
  minConfidence: 0.6 # findings below this are dropped (criticals kept to 0.4)
  maxRetries: 3
  callTimeoutMs: 120000
  maxOutputTokens: 8192
```

For native Anthropic Messages API support:

```yaml
provider: anthropic
model: claude-sonnet-4.5
# baseUrl: https://api.anthropic.com/v1  # optional; this is the default
```


If the configured file is not found, FiscalCR falls back to built-in defaults. Invalid configs fail fast instead of being silently ignored.

### Model stages

FiscalCR configures a model per pipeline stage under `models`:

| Key                    | Stage                                                                 |
| ---------------------- | --------------------------------------------------------------------- |
| `models.intent`        | Pass 1 intent/walkthrough/grouping call                               |
| `models.fastPath`      | Fast-path combined call (PRs under `pipeline.fastPathThreshold`)      |
| `models.groupReview`   | Pass 2 per-group file reviews                                         |
| `models.synthesis`     | Pass 3 final synthesis merging group summaries into one review        |

An unset stage falls back to the selected `modelPreset` stage model (see
[Model presets](#model-presets)), then to the top-level `model`, so configs
that only set `model` keep their single-model behavior — including configs
with no `models` block at all. Built-in defaults: `intent` is
`kimi-for-coding-highspeed`; `fastPath`, `groupReview`, and `synthesis` are
`kimi-for-coding`. With no config file all stages use these defaults. Unknown
keys under `models` (such as the legacy `big`/`small` roles) are rejected, so
a stale config fails fast instead of silently ignoring a stage.
Repo `models.*` values override the selected preset's stage models and the
built-in defaults; an unset stage falls back to the preset stage model, then
to the top-level repo `model`. An explicit `model` input on the GitHub Action
or `MODEL`/`FISCALCR_MODEL` in App mode overrides all stages globally.

### Model presets

Instead of listing every stage under `models`, select an opinionated preset
with `modelPreset`. Presets are YAML-only and optional: omitting `modelPreset`
keeps the legacy behavior (`models.*` stage, else the top-level `model`), and
no preset is injected by default.

Built-in presets and their exact stage models:

| Preset             | Stage         | Model                         |
| ------------------ | ------------- | ----------------------------- |
| `kimi`             | `intent`      | `kimi-for-coding-highspeed`   |
|                    | `fastPath`    | `kimi-for-coding`             |
|                    | `groupReview` | `kimi-for-coding`             |
|                    | `synthesis`   | `kimi-for-coding`             |
| `openai`           | `intent`      | `gpt-5-mini`                  |
|                    | `fastPath`    | `gpt-5-mini`                  |
|                    | `groupReview` | `gpt-5`                       |
|                    | `synthesis`   | `gpt-5`                       |
| `anthropic`        | `intent`      | `claude-haiku-4.5`            |
|                    | `fastPath`    | `claude-haiku-4.5`            |
|                    | `groupReview` | `claude-sonnet-4.5`           |
|                    | `synthesis`   | `claude-sonnet-4.5`           |
| `provider-default` | —             | Resolves to the `kimi`, `openai`, or `anthropic` preset from `provider`; `openai-compatible` has no preset and falls back to the top-level `model`. |

```yaml
provider: anthropic
modelPreset: anthropic
```

You can also define your own presets under `modelPresets` (preset name →
partial per-stage object) and select them by name with `modelPreset`. An entry
under a built-in name merges over that preset; a new name defines a fresh
preset whose unset stages fall back to the top-level `model`:

```yaml
model: gpt-4.1-mini # fallback for stages a preset does not set
modelPreset: team
modelPresets:
  team:
    intent: gpt-4.1-mini
    groupReview: gpt-5
  kimi:
    intent: team-tuned-kimi-highspeed # overrides the built-in kimi intent
```

Unknown preset names and unknown stage keys inside `modelPresets` fail config
validation.

Precedence: explicit `models.<stage>` > the selected preset's stage model >
the top-level `model`. An explicit `model` input on the GitHub Action or
`MODEL`/`FISCALCR_MODEL` in App mode still overrides every stage globally.

## How it works

```text
PR Event -> Extract Context -> Filter Files
  ├── Fast path (small PR): one combined LLM call (intent + walkthrough + findings)
  └── Full pipeline (large PR):
        Pass 1: PR intent, walkthrough, grouping hints   (1 intent call)
        Pass 2: parallel per-group file reviews          (N calls)
        Pass 3: validate/dedupe/rank + synthesis         (1 call, skipped for 1 group)
  -> Publish Check Run + PR review
```

### Review pipeline

1. Create a GitHub Check Run
2. Extract PR metadata, diff, and changed files (local checkout in Action mode, parallel API otherwise)
3. Filter files by include/exclude rules
4. PRs under `pipeline.fastPathThreshold` tokens take the fast path: a single combined call on the `fastPath` stage model
5. Larger PRs run the multi-pass pipeline:
   - **Pass 1 — intent**: an `intent` stage call summarizes the PR's intent, produces a file walkthrough, and suggests file groupings. Failure here is non-fatal.
   - **Pass 2 — group reviews**: files are deterministically grouped (hints → directory clustering → bin-packing to `groupTokenBudget`) and reviewed in parallel with the `groupReview` stage model. In Action mode each group also sees unchanged files it imports (`relatedContextBudget`). One failed group does not fail the review.
   - **Pass 3 — synthesis**: code-side validation drops findings on lines outside the diff, filters by confidence, dedupes, and ranks; a final `synthesis` stage call merges group summaries into one review (skipped when there is only one group).
6. Every LLM call goes through retry/backoff/timeout handling with `max_tokens` enforced
7. Update the Check Run and PR review summary (intent, walkthrough table, findings, token usage)

### Incremental reviews & comment lifecycle

FiscalCR keeps its review state in a hidden marker inside one **sticky summary
comment** per PR — no external storage, works identically in Action and App mode.

- **First run** reviews the whole PR and posts the sticky summary plus inline comments.
- **Each push** re-reviews only the files changed since the last reviewed commit
  (`review.incremental`). The sticky comment is updated in place; a small review
  with **only new findings** is posted — zero new findings means no review at all.
- **Findings are fingerprinted** (`path + category + normalized title`), so the same
  issue is never posted twice, even across full re-reviews. Deleting a bot comment
  will not cause a re-nag.
- **Fixed findings are cleaned up**: threads whose file changed but whose finding
  did not recur are resolved automatically, and a passing run dismisses the
  blocking REQUEST_CHANGES review ("Issues addressed as of `abc1234`").
- **The check run reflects cumulative PR health** — an unfixed critical from an
  earlier run keeps the check red even when a later push adds nothing new.
- `@fiscalcr review` always forces a full re-review (still deduped).
- Base branch changes, force-pushes, and oversized deltas automatically fall back
  to a full review.

**Limitations**: fork PRs run with a read-only token, so reviews cannot be posted
(pre-existing GitHub Actions restriction). Thread auto-resolution needs the
default `pull-requests: write` permission; when unavailable it degrades to a log
line. Use the `concurrency` group shown in the Quick Start so concurrent runs on
the same PR don't race each other's state.

## Cost model

FiscalCR uses a provider/model pricing snapshot to estimate API cost.
Known direct-provider families include OpenAI GPT-5.6 Luna, Terra, and Sol,
Anthropic Claude 5, and Kimi Open Platform models. OpenRouter model IDs use
OpenRouter-specific entries when the configured endpoint is OpenRouter.

For an unknown OpenRouter model, FiscalCR queries the public model endpoint,
caches the result for one hour, and falls back to the local snapshot if the
lookup fails.

Kimi Open Platform snapshot rates:

| Model                         | Input cache hit | Input cache miss | Output |
| ----------------------------- | --------------- | ---------------- | ------ |
| `kimi-k3`                     | $0.30           | $3.00            | $15.00 |
| `kimi-k2.7-code`              | $0.19           | $0.95            | $4.00  |
| `kimi-k2.7-code-highspeed`    | $0.38           | $1.90            | $8.00  |
| `kimi-k2.6`                   | $0.16           | $0.95            | $4.00  |

Legacy `kimi-k2.7` and `kimi-k2-7` IDs resolve to the K2.7 Code rate.

Unknown models and custom endpoints otherwise use the legacy fallback estimate:

| Token type   | Rate              |
| ------------ | ----------------- |
| Input        | $0.39 / 1M tokens |
| Output       | $1.90 / 1M tokens |
| Cached input | $0.10 / 1M tokens |

Pricing lookup is best-effort and can add up to two seconds before a review
starts for an uncached OpenRouter model. It is approximate: vendor pricing,
routing, discounts, long-context tiers, batch/priority modes, and subscription
quotas can differ. The displayed pricing source identifies whether the
estimate used an exact model, a model family, a remote OpenRouter lookup, or
the fallback.

## Architecture

```text
fiscal-cr/
├── action/
│   ├── action.yml
│   ├── index.ts
│   └── dist/
├── src/
│   ├── index.ts
│   ├── app.ts
│   ├── config/
│   ├── github/
│   ├── pipeline/
│   ├── providers/
│   ├── review/
│   ├── types/
│   └── utils/
├── test/
│   └── unit/
└── .fiscalcr-review.yml
```

## Development

```bash
pnpm install
pnpm test
pnpm lint
pnpm build:action
```

## Local LLM evaluation

Run the real production routing and review-pipeline code against a
deterministic 11-case gold benchmark suite — no GitHub API or repository
needed, and no GitHub publishing side effects (no check runs, reviews,
comments, or state markers; the GitHub Action workspace-context path is not
exercised). Each case is a synthetic PR with hand-authored expected issues;
every case runs once as baseline and once as experimental per round.

Prerequisite: put your provider API key in a root `.env` (never commit it). The
harness reads `API_KEY` (falling back to `FISCALCR_API_KEY`, then `KIMI_API_KEY`)
from the environment only and never logs it.

```bash
make eval-llm-dry        # keyless plan preview and prompt stats
make eval-llm            # smoke: 3 cases × 1 run × 2 variants = 6 attempts (all fast-path)
make eval-llm-full       # full: 11 cases × 1 run × 2 variants = 22 attempts (up to 40 provider calls)
make eval-llm-pipeline-dry  # keyless dry run of the pipeline-01 multi-pass canary
EVAL_CASES=clean-01,local-01 make eval-llm   # focused: 2 cases × 2 variants = 4 attempts
```

Provider calls are billable and an attempt is not a call: fast-path attempts
cost at most 1 provider call, multi-pass attempts (like `pipeline-01`) up to
10 (intent + up to 8 group reviews + synthesis). `EVAL_MAX_CALLS` guards the
provider-call upper bound before any provider is created; the full 11-case ×
4-round decision run upper bound is `EVAL_MAX_CALLS=160`. See
[docs/llm-evaluation.md](docs/llm-evaluation.md) for suite taxonomy, metrics,
blind review workflow, artifact schema (`fiscalcr-eval-v3`), and configuration
reference.

## Severity levels

| Level        | Meaning               | Example                                      |
| ------------ | --------------------- | -------------------------------------------- |
| `critical`   | Must fix before merge | Bugs, security issues, data loss risk        |
| `warning`    | Should fix            | Performance issues, risky practices          |
| `suggestion` | Nice to have          | Readability and maintainability improvements |
| `nitpick`    | Optional              | Minor style preferences                      |

## License

[MIT](LICENSE)

# FiscalCR

AI-powered, model-agnostic code review for GitHub pull requests.

[GitHub Action](#quick-start--github-action) · [Self-Hosted GitHub App](#self-hosted-github-app) · [Configuration](#configuration)

## Features

- Model-agnostic providers: Anthropic, OpenAI, Kimi, and compatible APIs
- Full-PR reviews with inline annotations and summary comments
- Optional visualizations for eligible full reviews
- Sticky lifecycle state and legacy comment modes
- Repo-level config via `.fiscalcr-review.yml`
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
          # visualize: true
          # comments: sticky
```

With `review.comments.resolveOutdated` enabled (the default), fixed findings
receive a reply on their original inline comments. Thread cleanup is separate
and best effort.

The Action uses the built-in `GITHUB_TOKEN`; `pull-requests: write` is enough.

### Action inputs

| Input          | Required | Default behavior                | Description                                                       |
| -------------- | -------- | ------------------------------- | ----------------------------------------------------------------- |
| `api_key`      | Yes*     | —                               | LLM API key. *Omit when using the federation inputs below        |
| `anthropic_federation_rule_id` | No | — | Federation rule (`fdrl_...`); enables [keyless Anthropic auth](#keyless-anthropic-auth-github-oidc) |
| `anthropic_organization_id` | No | — | Anthropic organization ID (UUID), required with federation |
| `anthropic_service_account_id` | No | — | Service account (`svac_...`), required with federation |
| `anthropic_workspace_id` | No | Rule's sole workspace | Workspace (`wrkspc_...`); needed only if the rule spans several |
| `oidc_audience` | No | Provider default (`https://api.anthropic.com`) | Audience of the GitHub OIDC token |
| `github_token` | No       | `${{ github.token }}`           | GitHub token for API access                                       |
| `provider`     | No       | Repo config or built-in default | `openai-compatible`, `kimi`, `openai`, or `anthropic`             |
| `model`        | No       | Repo config or built-in default | Model name; overrides the four core review stages                 |
| `model_params` | No       | Repo config                     | JSON object of provider-native fields merged into each model call  |
| `base_url`     | No       | Repo config                     | Provider base URL override                                        |
| `user_agent`   | No       | `fiscalcr/1.0`                  | Custom User-Agent for endpoints that whitelist clients            |
| `language`     | No       | Repo config or built-in default | Review language override                                          |
| `fail_on`      | No       | Repo config or built-in default | `critical`, `warning`, or `never`                                 |
| `config_path`  | No       | `.fiscalcr-review.yml`          | Path to config file relative to repo root                         |
| `telemetry`    | No       | `false`                         | Emit metrics-only token telemetry to Action logs                  |
| `experimental` | No       | Repo config or `false`          | Enable experimental prompt optimizations                          |
| `visualize`   | No       | Repo config                     | Enable or disable review visualization (`true`/`false`)         |
| `comments`    | No       | Repo config                     | Comment mode: `sticky` or `legacy`                              |

The Action inputs are scalar workflow values. `visualize` maps to
`review.visualize.enabled`, and `comments` maps to `review.comments.mode`.
When either input is omitted, the corresponding repository setting is kept.

For example, these settings can be supplied without a repository config file:

```yaml
      - uses: mof-malaysia/fiscal-cr@main
        with:
          api_key: ${{ secrets.LLM_API_KEY }}
          visualize: true
          comments: sticky
```

### Action outputs

| Output              | Description                          |
| ------------------- | ------------------------------------ |
| `review_summary`    | Review summary text                  |
| `annotations_count` | Number of inline annotations created |
| `critical_count`    | Number of critical issues found      |
| `tokens_used`       | Total input + output tokens          |
| `cost_estimate`     | Estimated API cost in USD            |

### Keyless Anthropic auth (GitHub OIDC)

With `provider: anthropic`, the Action can authenticate through Anthropic
[Workload Identity Federation](https://platform.claude.com/docs/en/manage-claude/wif-providers/github-actions)
instead of an `api_key` secret. Each run exchanges a GitHub OIDC token for a
short-lived Anthropic token and refreshes it as needed; no Claude secret is
stored in GitHub.

One-time setup in the Claude Console (**Settings → Workload identity →
Connect workload → GitHub Actions**):

1. Service account (role `developer`) that is a member of the workspace that
   should own FiscalCR usage.
2. Issuer `https://token.actions.githubusercontent.com` with JWKS discovery.
3. Federation rule targeting that service account. Allowlist repositories in
   the rule's `condition`:

   ```json
   {
     "match": {
       "subject_prefix": "repo:your-org/*",
       "audience": "https://api.anthropic.com",
       "claims": { "repository_owner": "your-org", "event_name": "pull_request" },
       "condition": "claims.repository in [\"your-org/repo-a\", \"your-org/repo-b\"]"
     },
     "oauth_scope": "workspace:inference"
   }
   ```

Store the rule, organization, service account, and workspace IDs as
organization or repository Actions **variables** (they are not secrets), then:

```yaml
permissions:
  contents: read
  pull-requests: write
  checks: write
  id-token: write

jobs:
  review:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: mof-malaysia/fiscal-cr@main
        with:
          provider: anthropic
          anthropic_federation_rule_id: ${{ vars.ANTHROPIC_FEDERATION_RULE_ID }}
          anthropic_organization_id: ${{ vars.ANTHROPIC_ORGANIZATION_ID }}
          anthropic_service_account_id: ${{ vars.ANTHROPIC_SERVICE_ACCOUNT_ID }}
          anthropic_workspace_id: ${{ vars.ANTHROPIC_WORKSPACE_ID }}
```

Set either `api_key` or the federation inputs, not both. Pull requests from
forks receive no OIDC token and cannot use federation. A denied exchange
returns an opaque `401`; the reason is listed in the Console under
**Workload identity → Authentication history**.

### Configuration precedence

- Action policy comes from the PR head SHA; `provider` and `base_url` come from
  the trusted base SHA. Non-PR runs use the default branch.
- Provided inputs override config: `provider`, `model`, `model_params`,
  `base_url`, `user_agent`, `language`, `fail_on`, and `experimental`.
- Head configuration outside those routing fields is untrusted. Base-revision
  routing prevents it from redirecting requests that contain the API key.
- Without a `model` override, stage models follow the effective provider and
  the FiscalCR release (see [Models](#models)).
- `openai-compatible` requires `base_url`. `anthropic` uses the native
  Messages API, defaults to `https://api.anthropic.com/v1`, and sends keys in
  `x-api-key` (or a federated `Authorization: Bearer` token).

### Token telemetry

Set `telemetry: true` to emit `[fiscalcr-telemetry]` metrics in Action logs.
Events include token counts, stage, timing, output limits, and finding counts;
they exclude prompts, source, secrets, repository/PR IDs, and paths. Telemetry
is disabled by default and uses no external service. Published accounting
includes per-stage token and cost totals; `calls` excludes provider retries.

### Experimental features

Set `experimental: true` in YAML or as an Action input to enable prompt
optimizations that may change between releases. The default is `false`.

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
default (Kimi coding models, OpenAI reasoning models, and Claude 5.x / Opus
4.7+). FiscalCR omits the `temperature` parameter for those models (all
others use `0.3`; set a top-level `temperature:` in `.fiscalcr-review.yml` to
override).

## Self-Hosted GitHub App

Use App mode for comment-driven reviews such as `@fiscalcr review`.

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
| `MODEL`                 | Optional | Model name; `FISCALCR_MODEL` is an alias    |
| `BASE_URL`              | Optional | Operator-controlled URL; `FISCALCR_BASE_URL` is an alias |
| `LLM_USER_AGENT`        | Optional | Custom User-Agent for whitelisted endpoints |
| `GITHUB_APP_ID`         | Yes      | GitHub App ID                               |
| `GITHUB_PRIVATE_KEY`    | Yes      | GitHub App private key                      |
| `GITHUB_WEBHOOK_SECRET` | Yes      | Webhook secret                              |
| `PORT`                  | No       | Server port, default `3000`                 |
| `LOG_LEVEL`             | No       | Log level, default `info`                   |

### Comment commands

| Command            | Description                 |
| ------------------ | --------------------------- |
| `@fiscalcr review` | Run a full review on the PR |
| `@fiscalcr help`   | Show available commands     |

### Webhook events

| Event                                      | Trigger                     |
| ------------------------------------------ | --------------------------- |
| `pull_request.opened`                      | PR created                  |
| `pull_request.synchronize`                 | New commits pushed          |
| `pull_request.reopened`                    | PR reopened                 |
| `pull_request.ready_for_review`            | Draft PR marked ready       |
| `pull_request.review_requested`            | Review requested            |
| `pull_request_review_thread.resolved`      | Thread marked resolved      |
| `pull_request_review_thread.unresolved`    | Thread reopened             |
| `issue_comment.created`                    | `@fiscalcr` command comment |

## Configuration

Create `.fiscalcr-review.yml` in your repository root:

```yaml
language: en
provider: openai-compatible
model: gpt-5.6-terra # required for openai-compatible; for native providers omit it to use the release's models (see "Models")
# models: # optional advanced per-stage overrides; win over `model`
#   groupReview: gpt-5.6-sol
baseUrl: https://your-llm-provider.com/v1
# userAgent: MyCodingAgent/2.1.0   # only for endpoints that whitelist clients
# modelParams:
#   reasoning_effort: medium # provider-native fields; pipeline fields are stripped
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
  visualize:
    enabled: false # opt-in: publish a visualization alongside the review
    mode: auto # auto, concept, or implementation
    maxOutputTokens: 2000 # completion-token cap for the visualization call
    minChangedFiles: 2 # minimum reviewable files before visualization generation
    minChangedLines: 20 # minimum additions plus deletions before generation
  incremental:
    enabled: true # re-review only files changed since the last reviewed commit
  comments:
    mode: sticky # one updated summary comment + incremental reviews
    # legacy → stack a full review on every run
    dedupe: true # do not repost an existing finding
    resolveOutdated: true # resolve threads for fixed findings
    maxOpenComments: 100 # overflow goes to check-run annotations

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
provider: anthropic # models follow the FiscalCR release; see "Models"
# baseUrl: https://api.anthropic.com/v1  # optional; this is the default
```

If the configured file is not found, FiscalCR falls back to built-in defaults. Invalid configs fail fast instead of being silently ignored.

### Models

Pick a `provider`; each FiscalCR release pins the models its prompts and
review harness were tuned against. Upgrading FiscalCR is how you get newer
models, so reviews stay consistent with the version you run.

Models in this release:

<!-- provider-models:start -->
| Provider | intent | fastPath | groupReview | synthesis | visualize |
| --- | --- | --- | --- | --- | --- |
| `kimi` | `k3-256k` | `k3-256k` | `k3` | `k3` | `k3-256k` |
| `openai` | `gpt-6-luna` | `gpt-6-luna` | `gpt-6.1-sol` | `gpt-6.1-sol` | `gpt-6-luna` |
| `anthropic` | `claude-sonnet-5-5` | `claude-sonnet-5-5` | `claude-opus-5-5` | `claude-opus-5-5` | `claude-sonnet-5-5` |

Release-tuned request params: `gpt-6-luna`: `reasoning_effort: max`; `gpt-6.1-sol`: `reasoning_effort: medium`.
<!-- provider-models:end -->

`openai-compatible` has no release models and requires `model`.

#### Overriding models (advanced)

Overrides opt out of the tuned defaults, for example to beta-test a model from
a PR branch. Resolution order is `models.<stage>` → top-level `model` →
release model. With `model` set, `visualize` resolves like `fastPath`.

| Key | Stage |
| --- | --- |
| `model` | Every stage without an explicit `models.<stage>` |
| `models.intent` | Pass 1 intent, walkthrough, and grouping |
| `models.fastPath` | Combined call for small PRs |
| `models.groupReview` | Pass 2 per-group reviews |
| `models.synthesis` | Pass 3 final synthesis |
| `models.visualize` | Optional visualization |

An Action `model` input or App `MODEL`/`FISCALCR_MODEL` override pins `model`
and the four core stages over repo config. The Action logs the resolved stage
models and warns when any override is active. Unknown stage keys fail
validation. The former `modelPreset` / `modelPresets` keys are ignored with a
warning.

## How it works

```text
PR event → load config → extract and filter files
  ├─ small PR / pipeline disabled → one combined fast-path call
  └─ large PR → intent → groups → parallel reviews → synthesis
      └─ eligible full review → optional visualization
→ publish the Check Run and PR review
```

- Fast-path and multi-pass findings use the same validation.
- Failed intent or individual groups degrade the review; all groups failing is fatal.
- Every LLM call uses configured retry, timeout, and output limits.
- Sticky mode updates one lifecycle comment; legacy mode posts a full review per run.

### Incremental reviews & comment lifecycle

Sticky mode stores bounded state in a hidden `v2` marker inside one summary
comment per PR. Legacy mode stores no lifecycle state.

- Stable fingerprints identify `open`, `fixed`, and `dismissed` findings.
- Only a successful reviewed scope can mark an absent finding fixed. Delta
  scopes use reviewed line ranges, so unrelated findings stay open.
- With `resolveOutdated`, fixed findings receive replies on their original
  comments and their threads are resolved when supported.
- Resolving a current FiscalCR thread dismisses its matching open finding.
  An `unresolved` event reopens a matching dismissed finding. Action mode has
  no manual-resolution webhook.
- Active findings remain visible; terminal history and event data are bounded.
  Active state is never silently truncated. v1 migration forces a lossy full
  review and preserves the old marker if saving fails.
- App check identity and head SHA are retained; stale checks are replaced.
  State is saved last, after publication succeeds.
- `@fiscalcr review` forces a full review. Base changes, force-pushes, and large
  deltas also fall back to full review.

Fork PRs use read-only tokens and cannot post reviews. Thread cleanup needs
`pull-requests: write`; manual resolution also needs the App thread webhook.
Cleanup failures log and do not fail the review. Keep the Quick Start
`concurrency` group to serialize runs for one PR.

### Visualizations

Set `review.visualize.enabled: true` to add a visualization to eligible full
reviews. `mode` can be `auto`, `concept`, or `implementation`; `auto` classifies
changed files before generation.

The model returns one validated representation: a flowchart for relationships,
a sequence diagram for ordered interactions, or a Markdown table for finite
rules and transitions. It can omit the visualization when no useful cross-file
relationship exists. Code renders it with conservative syntax; raw Mermaid,
Markdown, HTML, styles, links, and directives are not accepted.

Check Runs and Action summaries use text rendering; PR comments use Mermaid.
The visualization call uses `review.visualize.maxOutputTokens` as its
independent cap. Generation requires the configured file and line thresholds,
uses bounded patch evidence, and is nonfatal. Delta reviews keep the prior
full-review visual.

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
├── action.yml              # published Action metadata
├── action/
│   ├── index.ts
│   ├── config.ts
│   └── dist/               # generated release bundle
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
├── docs/
│   └── llm-evaluation.md
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

The harness runs the production review pipeline against 11 synthetic cases.
It does not call GitHub or publish reviews. Put a provider key in root `.env`;
the harness reads `API_KEY`, then `FISCALCR_API_KEY`, `ANTHROPIC_API_KEY`, or
`KIMI_API_KEY`, and never logs it.

```bash
make eval-llm-dry             # keyless plan
make eval-llm                 # smoke suite
make eval-llm-full            # full suite
make eval-llm-pipeline-dry    # multi-pass canary
EVAL_CASES=clean-01,local-01 make eval-llm
```

See [docs/llm-evaluation.md](docs/llm-evaluation.md) for metrics, blind review,
artifacts, budgets, and the full configuration reference.

## Severity levels

| Level        | Meaning               | Example                                      |
| ------------ | --------------------- | -------------------------------------------- |
| `critical`   | Must fix before merge | Bugs, security issues, data loss risk        |
| `warning`    | Should fix            | Performance issues, risky practices          |
| `suggestion` | Nice to have          | Readability and maintainability improvements |
| `nitpick`    | Optional              | Minor style preferences                      |

## License

[MIT](LICENSE)

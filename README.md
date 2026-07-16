# FiscalCR

AI-powered, model-agnostic code review for GitHub pull requests.

[GitHub Action](#quick-start--github-action) · [Self-Hosted GitHub App](#self-hosted-github-app) · [Configuration](#configuration) · [中文說明](#中文說明)

> Fork lineage: [irfancoder/kimi-code-reviewer](https://github.com/irfancoder/kimi-code-reviewer), originally based on [howardpen9/kimi-code-reviewer](https://github.com/howardpen9/kimi-code-reviewer).

## Features

- Model-agnostic provider support with OpenAI-compatible APIs
- Legacy Kimi compatibility for existing workflows and deployments
- Full-PR review with inline GitHub annotations and summary comments
- Repo-level configuration via `.fiscalcr-review.yml`
- GitHub Action and self-hosted GitHub App modes
- Multilingual reviews in `en`, `zh-TW`, `zh-CN`, `ja`, and `ko`

## Quick Start — GitHub Action

### 1. Add secrets

In your repository, add the secret that matches your chosen provider setup:

| Secret | Use for |
| ------ | ------- |
| `LLM_API_KEY` | Recommended generic provider setup |
| `MOONSHOT_API_KEY` | Legacy Kimi setup |

### 2. Create the workflow

```yaml
# .github/workflows/fiscalcr-review.yml
name: FiscalCR Review

on:
  pull_request:
    types: [opened, synchronize, review_requested]

permissions:
  contents: read
  pull-requests: write
  checks: write

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

For legacy Kimi usage:

```yaml
- uses: mof-malaysia/fiscal-cr@main
  with:
    kimi_api_key: ${{ secrets.MOONSHOT_API_KEY }}
```

### Action inputs

| Input | Required | Default behavior | Description |
| ----- | -------- | ---------------- | ----------- |
| `api_key` | No | — | Recommended generic LLM API key |
| `kimi_api_key` | No | — | Legacy Moonshot/Kimi API key |
| `github_token` | No | `${{ github.token }}` | GitHub token for API access |
| `provider` | No | Repo config or built-in default | `openai-compatible` or `kimi` |
| `model` | No | Repo config or built-in default | Model name override |
| `base_url` | No | Repo config | Generic provider base URL override |
| `kimi_base_url` | No | Repo config | Legacy base URL override |
| `language` | No | Repo config or built-in default | Review language override |
| `fail_on` | No | Repo config or built-in default | `critical`, `warning`, or `never` |
| `config_path` | No | `.fiscalcr-review.yml` | Path to config file relative to repo root |

### Action outputs

| Output | Description |
| ------ | ----------- |
| `review_summary` | Review summary text |
| `annotations_count` | Number of inline annotations created |
| `critical_count` | Number of critical issues found |
| `tokens_used` | Total input + output tokens |
| `cost_estimate` | Estimated API cost in USD |

### Notes on precedence

- Repo config is loaded from `.fiscalcr-review.yml` by default.
- Action inputs override repo config only when you explicitly provide them.
- For `openai-compatible`, an explicit `base_url` is required.
- For legacy `kimi`, the Kimi API URL is filled in automatically if you do not override it.

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

| Variable | Required | Description |
| -------- | -------- | ----------- |
| `API_KEY` | Recommended | Generic provider API key |
| `FISCALCR_API_KEY` | Optional | Alternate generic API key env name |
| `KIMI_API_KEY` | Optional | Legacy Kimi API key |
| `MODEL_PROVIDER` | Optional | Provider name (`openai-compatible` or `kimi`) |
| `MODEL` | Optional | Model name |
| `BASE_URL` | Optional | Operator-controlled base URL |
| `GITHUB_APP_ID` | Yes | GitHub App ID |
| `GITHUB_PRIVATE_KEY` | Yes | GitHub App private key |
| `GITHUB_WEBHOOK_SECRET` | Yes | Webhook secret |
| `PORT` | No | Server port, default `3000` |
| `LOG_LEVEL` | No | Log level, default `info` |

### Comment commands

| Command | Description |
| ------- | ----------- |
| `@fiscalcr review` | Run a full review on the PR |
| `@fiscalcr help` | Show available commands |

### Webhook events

| Event | Trigger |
| ----- | ------- |
| `pull_request.opened` | PR created |
| `pull_request.synchronize` | New commits pushed |
| `pull_request.review_requested` | Review requested |
| `issue_comment.created` | `@fiscalcr` command comment |

## Configuration

Create `.fiscalcr-review.yml` in your repository root:

```yaml
language: zh-TW
provider: kimi
model: kimi-k2.5

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

cache:
  enabled: true
  ttl: 3600

pipeline:
  enabled: true              # false → single-call review regardless of PR size (legacy behavior)
  concurrency: 3             # parallel group-review calls (1–8)
  groupTokenBudget: 40000    # max tokens of file content per review group
  relatedContextBudget: 15000 # tokens of unchanged imported files per group (Action mode only)
  maxGroups: 8               # overflow groups are reviewed diff-only
  fastPathThreshold: 25000   # PRs under this total use a single combined call
  minConfidence: 0.6         # findings below this are dropped (criticals kept to 0.4)
  maxRetries: 3
  callTimeoutMs: 120000
  maxOutputTokens: 8192
```

If the configured file is not found, FiscalCR falls back to built-in defaults. Invalid configs fail fast instead of being silently ignored.

## How it works

```text
PR Event -> Extract Context -> Filter Files
  ├── Fast path (small PR): one combined LLM call (intent + walkthrough + findings)
  └── Full pipeline (large PR):
        Pass 1: PR intent, walkthrough, grouping hints   (1 small call)
        Pass 2: parallel per-group file reviews          (N calls)
        Pass 3: validate/dedupe/rank + synthesis         (1 call, skipped for 1 group)
  -> Publish Check Run + PR review
```

### Review pipeline

1. Create a GitHub Check Run
2. Extract PR metadata, diff, and changed files (local checkout in Action mode, parallel API otherwise)
3. Filter files by include/exclude rules
4. PRs under `pipeline.fastPathThreshold` tokens take the fast path: a single combined call
5. Larger PRs run the multi-pass pipeline:
   - **Pass 1 — intent**: a small call summarizes the PR's intent, produces a file walkthrough, and suggests file groupings. Failure here is non-fatal.
   - **Pass 2 — group reviews**: files are deterministically grouped (hints → directory clustering → bin-packing to `groupTokenBudget`) and reviewed in parallel. In Action mode each group also sees unchanged files it imports (`relatedContextBudget`). One failed group does not fail the review.
   - **Pass 3 — synthesis**: code-side validation drops findings on lines outside the diff, filters by confidence, dedupes, and ranks; a final call merges group summaries into one review (skipped when there is only one group).
6. Every LLM call goes through retry/backoff/timeout handling with `max_tokens` enforced
7. Update the Check Run and PR review summary (intent, walkthrough table, findings, token usage)

## Cost model

The current cost estimate logic uses the existing Kimi-oriented token pricing constants for rough estimation.

| Token type | Rate |
| ---------- | ---- |
| Input | $0.39 / 1M tokens |
| Output | $1.90 / 1M tokens |
| Cached input | $0.10 / 1M tokens |

Provider-specific pricing tables are a reasonable follow-up, but they are not part of this PR.

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
│   ├── kimi/
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

## Severity levels

| Level | Meaning | Example |
| ----- | ------- | ------- |
| `critical` | Must fix before merge | Bugs, security issues, data loss risk |
| `warning` | Should fix | Performance issues, risky practices |
| `suggestion` | Nice to have | Readability and maintainability improvements |
| `nitpick` | Optional | Minor style preferences |

## 中文說明

FiscalCR 是一個支援多模型供應商的 GitHub PR 自動審查工具，保留了既有 Kimi 相容性，同時新增 OpenAI-compatible 供應商支援。

### 快速開始

1. 在 GitHub Secrets 中新增 `LLM_API_KEY`（通用供應商）或 `MOONSHOT_API_KEY`（舊版 Kimi 流程）。
2. 建立 workflow 並使用 `mof-malaysia/fiscal-cr@main`。
3. 如需自訂規則，在 repo 根目錄新增 `.fiscalcr-review.yml`。

### 重要行為

- 預設會搜尋 `.fiscalcr-review.yml`。
- 也可以透過 `config_path` 指定其他檔名，例如 `fiscalcr.yaml`。
- Action input 只有在你明確提供時才會覆蓋 repo config。
- 若使用 `openai-compatible`，必須提供明確的 `base_url`。
- PR 留言指令為 `@fiscalcr review` 與 `@fiscalcr help`。

## License

[MIT](LICENSE)

# FiscalCR Repository Walkthrough

Grep-friendly orientation. User setup lives in [README.md](../README.md);
detailed behavior lives in the subsystem guides:

- [Review pipeline](subsystems/review-pipeline.md)
- [Model presets](subsystems/model-presets.md)
- [GitHub integration](subsystems/github-integration.md)
- [Config & providers](subsystems/config-and-providers.md)

## Purpose & stack

AI-powered, model-agnostic code review for GitHub pull requests. It posts a
Check Run, PR review, and inline comments through either a GitHub Action or a
self-hosted GitHub App.

- **Runtime**: TypeScript, ESM, Node >= 20, strict mode
- **HTTP**: Hono + `@hono/node-server`
- **GitHub**: `@octokit/app`, `@octokit/rest`, `@octokit/webhooks`
- **Config/data**: Zod, YAML, minimatch, Pino
- **Package manager**: pnpm 9

## Entry points

Both modes use `ReviewOrchestrator` (`src/review/orchestrator.ts`).

| Mode | Entry | Runtime |
| --- | --- | --- |
| GitHub Action | `action/index.ts` → root `action.yml` → `action/dist/index.js` | Action inputs + `GITHUB_WORKSPACE` |
| Self-hosted App | `src/index.ts` → `src/app.ts` → `src/github/webhooks.ts` | `.env`, `POST /api/webhook`, `GET /health` |

Action inputs are defined in root `action.yml`: `api_key`, `github_token`,
`provider`, `model`, `model_params`, `base_url`, `user_agent`, `language`,
`fail_on`, `config_path`, `telemetry`, and `experimental`. `model` pins the
four core review stages; visualization has no separate Action input.

App variables are read in `src/index.ts`: `API_KEY` or `FISCALCR_API_KEY`,
`GITHUB_APP_ID`, `GITHUB_PRIVATE_KEY`, `GITHUB_WEBHOOK_SECRET`,
`MODEL_PROVIDER`, `MODEL` or `FISCALCR_MODEL`, `BASE_URL` or
`FISCALCR_BASE_URL`, `LLM_USER_AGENT`, `PORT`, and `LOG_LEVEL`.

## Directory map

| Path | Contents |
| --- | --- |
| `src/review/` | Orchestration, scope, diff analysis, file sources, filtering, summaries, visual rendering |
| `src/pipeline/` | Fast path, multi-pass stages, visualization, prompts, schemas, grouping, usage |
| `src/github/` | Webhooks, checks, PR context, comments, state, fingerprints, threads |
| `src/config/` | Schema, defaults, loader, presets, overrides |
| `src/providers/` | Provider interface, adapters, factory, retries |
| `src/types/` | Shared review and visualization types |
| `src/utils/` | Logging, errors, tokens, pricing, JSON repair, concurrency |
| `action/` | Action entry, input parsing, GitHub adapter, generated bundle directory |
| `test/` | Vitest unit tests and fixture repository |
| `.github/workflows/` | CI and release workflows |
| Root | `action.yml`, `README.md`, `package.json`, `.env.example`, TypeScript config |

## Task-to-path routing

| Task | Paths |
| --- | --- |
| Review lifecycle and publishing | `src/review/orchestrator.ts` |
| Full/delta/skip scope | `src/review/delta.ts` |
| PR extraction and file access | `src/github/pulls.ts`, `src/review/file-source.ts` |
| Diff and file filtering | `src/review/diff-analyzer.ts`, `src/review/file-filter.ts` |
| Fast path and review passes | `src/pipeline/{fast-path,pass1-intent,pass2-review,pass3-synthesis}.ts` |
| Grouping and prompts | `src/pipeline/{grouper,prompts,schemas}.ts` |
| Visual generation and rendering | `src/pipeline/{visualize,visual-schema}.ts`, `src/review/visual-renderer.ts` |
| Checks, comments, threads | `src/github/{checks,comments,threads}.ts` |
| Sticky state and fingerprints | `src/github/{review-state,fingerprint}.ts` |
| Webhook commands and triggers | `src/github/webhooks.ts` |
| Config and model routing | `src/config/{schema,defaults,loader,model-presets,overrides}.ts` |
| Providers and retries | `src/providers/` |

## Runtime flows

### App mode

```text
POST /api/webhook
  → verify GitHub signature
  → resolve installation Octokit
  → load repo config
  → apply App provider/model overrides
  → create provider and ReviewOrchestrator
  → reviewPullRequest
```

Auto-review events are `opened`, `synchronize`, `reopened`, and
`ready_for_review`. Review requests, `@fiscalcr review|help`, and review-thread
resolution events use separate handlers. `review.auto` gates automatic runs.

### Action mode

```text
workflow → action/index.ts
  → read inputs
  → load config at PR head and trusted base revisions
  → merge policy and routing settings
  → apply explicit overrides
  → create provider and ReviewOrchestrator
  → review local checkout
  → write outputs and job summary
```

The Action disables the orchestrator-managed Check Run and uses the workflow
job check. Local file reads use `GITHUB_WORKSPACE`.

### Review pipeline

```text
load state → decide full/delta/skip → extract → filter
  → fast path
    or intent → group → parallel reviews → validate → synthesize
  → optional full-review visualization
  → publish → save sticky state last
```

See [review pipeline](subsystems/review-pipeline.md) for scope rules,
grouping, failure behavior, and publication order.

## Shared contracts

- `src/config/schema.ts` is canonical; `defaults.ts` mirrors it.
- Stage routing and preset semantics are defined in
  [model presets](subsystems/model-presets.md).
- Sticky mode stores bounded v2 state in one hidden summary-comment marker.
- Successful reviewed scopes alone can mark findings fixed.
- Check conclusions use cumulative open findings; cleanup failures log.

## Testing map

| Area | Tests |
| --- | --- |
| Lifecycle and scope | `orchestrator-lifecycle`, `review-state`, `comments`, `threads`, `delta` |
| Pipeline routing and stages | `run-review`, `orchestrator-pipeline`, `fast-path`, `pass3-synthesis`, `grouper` |
| Parsing and diff context | `pipeline-schemas`, `json`, `diff-analyzer`, `file-filter`, `file-source`, `related-context` |
| Visualization | `change-diagram`, `diagram-renderer`, `summary-builder` |
| Config and Action | `config-loader`, `config-overrides`, `action-config`, `action-model-params`, `action-experimental` |
| Providers | `provider-factory`, `openai-compatible-provider`, `anthropic-provider`, `resilient-provider` |
| Utilities and accounting | `tokens`, `temperature`, `max-output`, `concurrency`, `pricing`, `usage`, `action-telemetry` |
| Webhook and GitHub adapters | `webhooks`, `action-github-client`, `fingerprint` |

All paths above refer to `test/unit/*.test.ts`.

## Commands

| Command | Purpose |
| --- | --- |
| `pnpm install` | Install dependencies |
| `pnpm generate:prompts` | Generate embedded prompts |
| `pnpm test` | Run Vitest |
| `pnpm test:watch` | Run Vitest in watch mode |
| `pnpm lint` | Type-check with `tsc --noEmit` |
| `pnpm build` | Build `dist/` |
| `pnpm build:action` | Rebuild `action/dist/` |
| `pnpm dev` | Run the App in watch mode |
| `pnpm start` | Run `dist/index.js` |
| `pnpm clean` | Remove build output |

## Common change recipes

- **Config option**: update schema and defaults, consume it, then add focused tests.
- **Model preset**: update `model-presets.ts` and routing/validation tests; keep
  [model preset](subsystems/model-presets.md) semantics current.
- **Pipeline stage**: add the stage, prompt, parser, orchestrator wiring, and
  `UsageTracker` accounting.
- **Severity/category**: update shared types, parser, prompts, publication
  maps, and thread matching.
- **Sticky lifecycle**: update `orchestrator.ts`, `review-state.ts`, and
  comment publication logic; bump the marker version for shape changes.
- **Action contract**: update `action/index.ts`, root `action.yml`, and README;
  rebuild the generated bundle.

## Generated artifacts

- `dist/`: `pnpm build` output; gitignored.
- `action/dist/`: `pnpm build:action` output; gitignored locally and force-added
  by `release.yml`. Never hand-edit it.

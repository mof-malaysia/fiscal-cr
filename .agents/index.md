# FiscalCR Repository Walkthrough

Grep-friendly orientation for agents. Subsystem deep-dives:

- [Review pipeline](subsystems/review-pipeline.md)
- [GitHub integration](subsystems/github-integration.md)
- [Config & providers](subsystems/config-and-providers.md)

## Purpose & stack

AI-powered, model-agnostic code review for GitHub pull requests. Reviews PRs via LLM calls and posts the result as a check run + PR review/inline comments. Runs either as a GitHub Action or a self-hosted GitHub App.

- **Language/runtime**: TypeScript, ESM (`"type": "module"`), Node >= 20, strict mode.
- **HTTP**: Hono + `@hono/node-server` (App mode server).
- **GitHub**: `@octokit/app`, `@octokit/rest`, `@octokit/webhooks`.
- **Other deps**: zod (schemas), yaml (repo config), minimatch (file globs), pino (logging). Dev: vitest, tsx, `@vercel/ncc` (action bundle), `@actions/core`/`@actions/github`.
- **Package manager**: pnpm (lockfile v9; CI pins pnpm 9 via `pnpm/action-setup@v4`).

## Entry points

Both entry points funnel into the same `ReviewOrchestrator` (`src/review/orchestrator.ts`).

| Mode | Entry | Invocation | Runtime env |
| --- | --- | --- | --- |
| GitHub Action | `action/index.ts` (ncc-bundled to `action/dist/index.js`) | `action.yml` (root) — `runs.main: action/dist/index.js`, node20 | Action inputs + `GITHUB_WORKSPACE` checkout |
| Self-hosted App | `src/index.ts` → `src/app.ts` (Hono server) → `src/github/webhooks.ts` | `pnpm dev` / `pnpm start` | `.env` vars, webhook at `POST /api/webhook`, `GET /health` |

Action inputs (`action/index.ts`, via `@actions/core`): `api_key` (required), `github_token`, `provider`, `model`, `base_url`, `user_agent`, `language`, `fail_on`, `config_path` (default `.fiscalcr-review.yml`). Outputs: `review_summary`, `annotations_count`, `critical_count`, `tokens_used`, `cost_estimate`.

App env vars (`src/index.ts`, `.env.example`): `API_KEY` (or `FISCALCR_API_KEY`), `GITHUB_APP_ID`, `GITHUB_PRIVATE_KEY`, `GITHUB_WEBHOOK_SECRET`, `MODEL_PROVIDER`, `MODEL` (or `FISCALCR_MODEL`), `BASE_URL` (or `FISCALCR_BASE_URL`), `LLM_USER_AGENT`, `PORT` (3000), `LOG_LEVEL`.

## Directory map

| Path | Contents |
| --- | --- |
| `src/index.ts` | Hono server: `/health`, `/api/webhook` (verify + dispatch), env plumbing |
| `src/app.ts` | `createApp(config)` — builds `@octokit/app`, registers webhooks |
| `src/review/` | Orchestrator + scope decision + diff analysis + file filtering/sourcing + summary builder |
| `src/pipeline/` | Fast path + multi-pass pipeline (intent → group review → synthesis), prompts, response schemas, grouping, usage tracking, per-model output/temperature resolution |
| `src/github/` | Octokit/GitHub API layer: webhooks, checks, PR context, comments, review state, fingerprints, threads |
| `src/config/` | Zod schema (canonical), defaults, repo-config loader |
| `src/providers/` | `LLMProvider` interface, factory, OpenAI-compatible adapter, resilient (retry) decorator |
| `src/types/` | `review.ts` — shared domain types (`ReviewResult`, `ReviewAnnotation`, `PullRequestContext`, …) |
| `src/utils/` | logger, errors, tokens, JSON extraction/repair, concurrency limiter |
| `action/` | Action entry + generated `action/dist/` (committed) |
| `test/` | Vitest unit tests (`test/unit/*.test.ts`) + fixture repo (`test/fixtures/fake-repo/`) |
| `.github/workflows/` | `ci.yml` (PR: tsc, tests, ncc build), `release.yml` (rebuild + commit `action/dist/` + retag) |
| Root files | `action.yml` (published Action manifest), `README.md`, `package.json`, `tsconfig.json`, `vitest.config.ts`, `.env.example` |

## Task-to-path routing

| Task | Paths |
| --- | --- |
| Full-review lifecycle, publishing, dedupe | `src/review/orchestrator.ts` |
| Scope decision (full / delta / skip) | `src/review/delta.ts` |
| PR context extraction | `src/github/pulls.ts` |
| File filtering by globs | `src/review/file-filter.ts` |
| File content sources (local vs API) | `src/review/file-source.ts` |
| Diff parsing / line mapping | `src/review/diff-analyzer.ts` |
| Fast path (small PRs) | `src/pipeline/fast-path.ts` |
| Pass 1 intent, Pass 2 groups, Pass 3 synthesis | `src/pipeline/{pass1-intent,pass2-review,pass3-synthesis}.ts` |
| Deterministic grouping | `src/pipeline/grouper.ts` |
| Prompts / response parsing | `src/pipeline/{prompts,schemas}.ts` |
| LLM call budget knobs | `src/pipeline/{temperature,max-output,related-context}.ts`, `src/utils/tokens.ts` |
| Check runs | `src/github/checks.ts` |
| PR reviews / inline comments | `src/github/comments.ts` |
| Sticky summary + state marker | `src/github/review-state.ts` |
| Finding fingerprints | `src/github/fingerprint.ts` |
| Thread resolution | `src/github/threads.ts` |
| Webhook triggers & commands | `src/github/webhooks.ts` |
| Config | `src/config/{schema,defaults,loader}.ts` |
| Providers | `src/providers/{interface,factory,openai-compatible,resilient}.ts` |

## Core runtime flows

### App mode (self-hosted)

```text
POST /api/webhook (Hono)
  → app.webhooks.verifyAndReceive()        // signature-verified
    → webhooks.ts handlers (per event)
      → loadConfig(octokit, owner, repo)   // repo .fiscalcr-review.yml
      → createLLMProvider(...)             // env overrides config
      → new ReviewOrchestrator(octokit, llm, config)
      → reviewPullRequest(...)
```

Handled events: `pull_request.opened|synchronize|reopened|ready_for_review` (auto-review), `pull_request.review_requested`, `issue_comment.created` (`@fiscalcr review` → `forceFull: true`; `@fiscalcr help` → command table). Auto-review gates: `review.auto.{enabled,drafts,onOpen,onPush,onReviewRequest}`.

### Action mode

```text
workflow → action/index.ts
  → core.getInput(...)                    // inputs + defaults
  → github.getOctokit(token)              // uses .rest shape
  → loadConfig(...)                       // via config_path input
  → inputs override config (model/base_url/user_agent/language/fail_on)
  → review.auto gates (drafts/onOpen/onPush)
  → new ReviewOrchestrator(octokit, llm, config, { workspaceRoot: GITHUB_WORKSPACE })
  → reviewPullRequest(...)
  → setOutputs(...) + core.summary + failOn → core.setFailed
```

Action mode passes `workspaceRoot`, so file contents and related-import context read from the local checkout (`LocalFileSource`) instead of the API.

### Review pipeline (both modes)

See [subsystems/review-pipeline.md](subsystems/review-pipeline.md) for depth. Outline:

```text
reviewPullRequest(owner, repo, pullNumber, headSha, forceFull?)
 1. createCheckRun(headSha)
 2. loadReviewState() → decideScope()      // full | delta | skip
 3. extractPullRequestContext()            // metadata, files, diff, contents
    (path-filtered when delta; LocalFileSource in Action mode)
 4. filterFiles()                          // include/exclude globs, size, patch presence
 5. runReview():
      totalTokens < fastPathThreshold (or pipeline.enabled=false)
        → runFastPath()                    // 1 combined LLM call
      else
        → Pass 1 runIntentPass()           // intent+walkthrough+group hints (non-fatal)
        → groupFiles()                     // deterministic grouping + bin-packing
        → Pass 2 runReviewPass()           // parallel group calls (concurrency)
        → validateAndRankFindings()        // deterministic gate
        → Pass 3 synthesize()              // 1 LLM call when >1 group; fallbacks otherwise
 6. publish:
      legacy mode → createPRReview()       // stacked full review per run
      sticky mode  → dedupe vs postedFingerprints
                   → resolveOutdatedThreads()
                   → completeCheckRun()    // conclusion from cumulative openCounts
                   → dismissBlockingReview() → createIncrementalReview()
                   → saveStickyComment()   // state saved LAST
```

## Configuration, providers, GitHub-state integrations

See [subsystems/config-and-providers.md](subsystems/config-and-providers.md) and [subsystems/github-integration.md](subsystems/github-integration.md).

Precedence (highest wins): explicit Action inputs / App env vars → repo `.fiscalcr-review.yml` → built-in defaults (`src/config/defaults.ts` / zod schema `.default()`). `src/config/schema.ts` is canonical; `defaults.ts` mirrors it (the shared `DEFAULT_EXCLUDE_PATTERNS` const exists specifically to prevent drift).

Providers are OpenAI-compatible via one adapter (`src/providers/openai-compatible.ts`), selected by `src/providers/factory.ts`, wrapped in retry/backoff by `src/providers/resilient.ts`. `kimi` is a preset with a built-in base URL; `openai-compatible` requires an explicit `base_url`.

GitHub state is persisted in a hidden marker inside one sticky summary comment per PR — no external storage, identical in both modes. Findings are fingerprinted (`src/github/fingerprint.ts`) so the same issue is never posted twice, even across full re-reviews or after a human deletes a bot comment.

## Testing map

Vitest (`test/unit/*.test.ts`, globals enabled, node env). Fixture repo: `test/fixtures/fake-repo/` (used by file-source/related-context tests).

| Area | Test file(s) | Covers |
| --- | --- | --- |
| Orchestration lifecycle | `orchestrator-lifecycle.test.ts` | sticky first run, delta dedupe, fix push, skip run, forceFull, legacy mode |
| Pipeline routing | `orchestrator-pipeline.test.ts` | fast-path vs multi-pass selection, failed-group tolerance, kill-switch, failure propagation |
| Scope decision | `delta.test.ts` | full/delta/skip cases incl. base change, force-push, caps |
| Grouping | `grouper.test.ts` | hint seeding, clustering, bin-packing, test-file migration, overflow |
| Pass 3 / scoring | `pass3-synthesis.test.ts` | `validateAndRankFindings`, `deterministicScore`, `synthesize` pruning |
| Fast path | `fast-path.test.ts` | single-call path, truncation salvage |
| Response parsing | `pipeline-schemas.test.ts`, `json.test.ts` | intent/group/synthesis/fast-path parsers, `extractJson`/`repairTruncatedJson` |
| Diff analysis | `diff-analyzer.test.ts` | hunk parsing, `lineToDiffPosition`, `commentableLines` |
| File filter/source | `file-filter.test.ts`, `file-source.test.ts` | glob filtering; local vs API sources, path traversal guard |
| Related context | `related-context.test.ts` | import spec extraction, resolution, budget |
| Comments | `comments.test.ts` | `partitionPlaceable`, incremental review, blocking dismiss, legacy review |
| Fingerprints | `fingerprint.test.ts` | normalization, stability, markers |
| Sticky state | `review-state.test.ts` | marker roundtrip, FIFO caps, load/save lifecycle |
| Threads | `threads.test.ts` | listing, outdated resolution, degradation |
| Providers | `provider-factory.test.ts`, `openai-compatible-provider.test.ts`, `resilient-provider.test.ts` | factory validation, adapter HTTP, retry/backoff |
| Config | `config-loader.test.ts` | load, missing→defaults, invalid/errors |
| Misc utils | `tokens.test.ts`, `concurrency.test.ts`, `temperature.test.ts`, `max-output.test.ts` | token/cost math, limiter, per-model knobs |

## Commands

| Command | What it runs |
| --- | --- |
| `pnpm install` | install deps (pnpm; lockfile v9, CI pins pnpm 9) |
| `pnpm test` | `vitest run` (unit tests) |
| `pnpm test:watch` | `vitest` (watch) |
| `pnpm lint` | `tsc --noEmit` (type check; `test/` and `action/dist` excluded via tsconfig) |
| `pnpm build` | `tsc` → `dist/` |
| `pnpm build:action` | `ncc build action/index.ts -o action/dist` (regenerates the committed bundle) |
| `pnpm dev` | `tsx watch src/index.ts` (App mode) |
| `pnpm start` | `node dist/index.js` |
| `pnpm clean` | `rm -rf dist action/dist` |

## Common change recipes

- **Add a config option**: `src/config/schema.ts` (zod field + default) → `src/config/defaults.ts` (mirror) → consume where relevant (usually `prompts.ts` or `orchestrator.ts`) → test in `config-loader.test.ts` / the affected module's test. Schema and defaults must stay in sync.
- **Add an LLM call stage**: new file under `src/pipeline/`, prompt builders in `prompts.ts`, response parser in `schemas.ts`, wire into `orchestrator.runReview` or an existing pass, track usage with `UsageTracker`.
- **Add severity/category**: update `src/types/review.ts` enums, `pipeline/schemas.ts` `findingSchema`, severity maps (`checks.ts`, `comments.ts`, `review-state.ts`), prompt rubric in `prompts.ts`, and the `SEVERITY_RE` in `threads.ts`.
- **Change the sticky lifecycle**: `orchestrator.publishSticky` + `review-state.ts` (bump marker version `v1` if `ReviewState` shape changes) + `comments.ts` posting logic.
- **Add a webhook trigger / command**: `src/github/webhooks.ts` `registerWebhooks`.
- **Fix LLM JSON parsing**: `src/utils/json.ts` (`extractJson`, `repairTruncatedJson`) and `pipeline/schemas.ts`.
- **Change Action inputs/outputs**: `action/index.ts` + root `action.yml` + `README.md`, then `pnpm build:action` and commit `action/dist/`.

## Generated artifacts

- `dist/` — `pnpm build` (tsc) output; gitignored.
- `action/dist/` — `pnpm build:action` (ncc) bundle; **committed** (`.gitignore` has `!action/dist/`); regenerated by CI on release. Never hand-edit. Root `action.yml` points at `action/dist/index.js`.

## Docs links

- [README.md](../README.md) — user-facing docs: setup, configuration reference, "how it works".
- [Subsystem: review pipeline](subsystems/review-pipeline.md)
- [Subsystem: GitHub integration](subsystems/github-integration.md)
- [Subsystem: config & providers](subsystems/config-and-providers.md)

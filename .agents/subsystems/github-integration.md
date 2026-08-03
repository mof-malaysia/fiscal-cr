# Subsystem: GitHub Integration

Everything that talks to GitHub: webhook triggers, check runs, PR reviews, sticky comment state, fingerprints, thread resolution. Files: `src/github/*`, `src/app.ts`, `src/index.ts`, `action/index.ts`.

Start here: [`../index.md`](../index.md) for context, [`../AGENTS.md`](../AGENTS.md) for non-negotiables. Related: [review pipeline](review-pipeline.md), [config & providers](config-and-providers.md).

## Triggers

### App mode — webhooks (`src/github/webhooks.ts`, registered by `src/app.ts`)

`registerWebhooks(webhooks, appCtx)` registers handlers on `@octokit/webhooks`:

| Event | Behavior |
| --- | --- |
| `pull_request.opened` / `synchronize` / `reopened` / `ready_for_review` | Auto-review, gated by `review.auto.{enabled,drafts,onOpen,onPush}` (reopened/ready follow `onOpen`) |
| `issue_comment.created` | `parseFiscalCRCommand` matches `@fiscalcr [review|help]`. `review` → full re-review (`forceFull: true`); `help` → posts command table. Bare `@fiscalcr` defaults to `review`. Non-PR issue comments are ignored |
| `pull_request.review_requested` | Gated by `review.auto.onReviewRequest` |

Each handler: resolve installation Octokit → `loadConfig` → `createLLMProvider` (env overrides config) → `new ReviewOrchestrator(octokit, llm, config)` → `reviewPullRequest`.

### Action mode (`action/index.ts`)

Triggered by workflow `on: pull_request` events. Reads inputs, loads repo config, applies `review.auto` gates (`drafts`, `onOpen`, `onPush`), builds the orchestrator with `workspaceRoot` (local checkout), and maps the result to Action outputs + `core.summary` + `failOn` → `core.setFailed`. Note: `@actions/github`'s Octokit exposes REST under `.rest`; the orchestrator expects the `@octokit/rest` shape, so `octokit.rest` is passed.

## GitHub API surface

| Concern | File | API calls |
| --- | --- | --- |
| Check runs | `src/github/checks.ts` | `checks.create`, `checks.update` — annotations batched 50/request; severity → `failure`/`warning`/`notice` |
| PR context | `src/github/pulls.ts` | `pulls.get` (metadata + `diff` mediaType), `pulls.listFiles` (paged 100), contents via file source |
| Reviews/comments | `src/github/comments.ts` | `pulls.createReview` (inline comments + body), `pulls.dismissReview` |
| Sticky comment | `src/github/review-state.ts` | `issues.listComments` (paged 100), `issues.createComment`, `issues.updateComment` |
| File contents | `src/review/file-source.ts` | `repos.getContent` (base64, concurrency 8), or local `readFile` in Action mode |
| Scope compare | `src/review/delta.ts` | `repos.compareCommitsWithBasehead` |
| Config fetch | `src/config/loader.ts` | `repos.getContent` (base64) |
| Threads | `src/github/threads.ts` | GraphQL `repository.pullRequest.reviewThreads` + `resolveReviewThread`/`addPullRequestReviewThreadReply` mutations |

## Sticky state (`review-state.ts`)

The single source of persisted state — a hidden HTML marker embedded in one sticky summary comment per PR, identical in both modes, no external storage:

```
<!-- fiscalcr:state:v1 {json} -->
```

`ReviewState`: `{ v: 1, lastReviewedSha, baseSha, blockingReviewId, postedFingerprints[], openCounts{}, runs[] }`.

- `loadReviewState` scans comment pages for the marker prefix — **by marker, never by author** (works for both `github-actions[bot]` and App bot users).
- `parseStateMarker` validates and fills defaults for optional fields; corrupt/unknown markers → `null` (treated as no state).
- `saveStickyComment` updates in place; re-checks for a concurrently created sticky comment before creating; on update failure (deleted comment) creates a new one.
- FIFO caps: `postedFingerprints` 300, `runs` 20.
- `renderStickyComment` renders summary + walkthrough + open counts + demoted findings + run history + the marker.

## Fingerprints (`fingerprint.ts`)

Stable identity for a finding across runs: `sha256(path \0 category \0 normalizedTitle)` truncated to 16 hex. `normalizeTitle` lowercases, strips backticks, maps digits → `#` and non-alphanumerics → spaces, so cosmetic drift (casing, backticks, line numbers, counts) never produces a "new" finding. Deliberately excludes line numbers and body text.

Every inline comment we post carries a hidden marker `<!-- fiscalcr:fp:v1:<fp> -->`; `extractFingerprint` reads it back from thread comments. Dedupe compares against `postedFingerprints` from state — including findings whose comments a human deleted (deleting a bot comment never causes a re-nag).

## Reviews & comments (`comments.ts`)

- `partitionPlaceable` splits annotations by whether `endLine` is a commentable line on the diff right side (`diff-analyzer.commentableLines`); unplaceable → check-run annotations + sticky section.
- `createIncrementalReview` (sticky mode): posts only this run's new findings; nitpicks never inline; zero placeable + `COMMENT` event → nothing posted; a 422 on inline comments retries once body-only.
- `dismissBlockingReview`: always dismisses the old blocking review before re-posting; failures degrade to a log line.
- `createPRReview` (legacy mode): one full stacked review per run, `REQUEST_CHANGES` when `failOn` threshold hit.

## Threads (`threads.ts`)

- `listFiscalcrThreads`: GraphQL-paginated review threads; keeps only threads whose first comment carries a fingerprint marker; parses severity from the `**[severity]**` prefix.
- `resolveOutdatedThreads`: resolves unresolved threads whose file changed in this run and whose fingerprint did not recur; replies with "Resolved automatically" then resolves. Every failure (403 on default tokens, per-thread mutation errors) degrades to logging — cleanup never fails a review.

## Data/control flow

```text
webhook / action inputs
  → octokit (installation-scoped or workflow token)
  → loadConfig(octokit, owner, repo)
  → ReviewOrchestrator.reviewPullRequest
      → checks.create → … (see review-pipeline.md)
      → publishSticky:
          dedupe via postedFingerprints
          → resolveOutdatedThreads (GraphQL)
          → checks.update (cumulative conclusion)
          → pulls.dismissReview (old blocking) → pulls.createReview (new findings)
          → issues.updateComment / createComment (sticky state) — LAST
```

## Invariants

- State is saved last, only after posting succeeded.
- Check run conclusion reflects cumulative open counts, not the current run's delta.
- One live blocking review at a time, always re-anchored to the newest commit.
- Marker-based identification everywhere (state + fingerprints) — never author-based.
- Dedupe persists across full re-reviews and human deletion of bot comments.
- All cleanup failures (thread resolve, review dismiss, sticky update) degrade to logs — never fail the review.

## Relevant tests

- `test/unit/orchestrator-lifecycle.test.ts` — sticky lifecycle incl. dedupe, dismiss, skip-run, forceFull, legacy.
- `test/unit/review-state.test.ts` — marker roundtrip, corrupt markers, FIFO caps, load/save concurrency and deletion recovery.
- `test/unit/fingerprint.test.ts` — normalization, stability, markers.
- `test/unit/comments.test.ts` — placement partition, incremental review, blocking dismiss, legacy review.
- `test/unit/threads.test.ts` — listing, outdated resolution, degradation on 403.
- `test/unit/delta.test.ts` — scope decision via compare API.

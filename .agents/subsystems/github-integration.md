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

The single persisted state is a bounded hidden `v2` marker embedded in one
sticky summary comment per PR:

```
<!-- fiscalcr:state:v2 {json} -->
```

`ReviewState` stores `{ v: 2, lastReviewedSha, baseSha, blockingReviewId,
findings[], recentEvents[], autoResolvedThreads[], checkRunId,
checkRunHeadSha, runs[] }`. Each finding record is keyed by the existing
fingerprint and has `open`, `fixed`, or `dismissed` status, current severity,
location, thread identity, and bounded transitions. Open counts are derived
from current open records; `postedFingerprints` and aggregate counter deltas
are not lifecycle state.

- `loadReviewState` scans comment pages by marker, never author. v1 is detected
  separately for lazy migration.
- v1 migration forces the next review full and is explicitly lossy: old
  fixed/dismissed history is not fabricated. A failed migration save leaves v1
  intact.
- Reviews reconcile a complete finding inventory against an explicit successful
  reviewed-path manifest. Failed detector groups cannot fix findings.
- Active records render in the summary; fixed/dismissed records stay hidden.
  Transition history, terminal records, recent event identities, and run
  metadata are bounded. Old terminal records are evicted to fit a conservative
  marker budget; active state is never silently truncated.
- `saveStickyComment` updates in place, re-checks before creating, rejects an
  oversized body before replacement, and creates a replacement after a deleted
  comment.

## Fingerprints (`fingerprint.ts`)

Stable identity remains `sha256(path \0 category \0 normalizedTitle)` truncated
to 16 hex. Severity changes update a record in place. Inline comments retain
their existing `fiscalcr:fp:v1` marker.

## Reviews & comments (`comments.ts`)

- `partitionPlaceable` separates inline-capable annotations from check-run
  annotations and summary metadata.
- `createIncrementalReview` posts only newly-open publishable findings;
  threadless/demoted findings remain in the lifecycle inventory but cannot be
  manually dismissed.
- `dismissBlockingReview` always dismisses the old blocking review before a
  replacement; failures degrade to a log line.

## Threads (`threads.ts`)

`listFiscalcrThreads` keeps only current, FiscalCR-marked threads. Fixed inline
findings are automatically resolved when enabled. Manual resolution is handled
by the App's `pull_request_review_thread.resolved` webhook only when the current
thread and record identity match; only an open thread-backed record can become
dismissed. Unresolved events have no immediate lifecycle effect. Automatic
resolution remains `fixed`, never `dismissed`.

## Checks (`checks.ts`)

App reviews persist check id plus head SHA. A missing, inaccessible, deleted, or
wrong-head check receives a replacement; old check annotations are not rewritten.
Action mode keeps `createCheckRun: false` and remains review-time only.

## Data/control flow

```text
webhook / action inputs
  → octokit (installation-scoped or workflow token)
  → ReviewOrchestrator.reviewPullRequest
      → load v2/v1 state → force full on v1 migration → decide scope
      → complete successful inventory + reviewed-path manifest
      → reconcile records → resolve fixed threads → complete check
      → dismiss/repost blocking review → post newly-open inline findings
      → update sticky marker LAST
```

State updates use bounded event identities and idempotent reread/retry. The
latest completed review is eventual authority; strict linearizable review-wins
ordering is not claimed.

## Invariants

- State is saved last, only after posting succeeded.
- Check conclusion derives from current open records.
- The successful reviewed-scope manifest is the only authority that can mark an
  absent open finding fixed.
- Current thread events are marker-identified, status-gated, and idempotent.
- Cleanup failures degrade to logs; webhook transient failures propagate as
  non-2xx while permanent stale/unsupported events are acknowledged.

## Relevant tests

- `test/unit/orchestrator-lifecycle.test.ts` — sticky lifecycle incl. dedupe, dismiss, skip-run, forceFull, legacy.
- `test/unit/review-state.test.ts` — marker roundtrip, corrupt markers, FIFO caps, load/save concurrency and deletion recovery.
- `test/unit/fingerprint.test.ts` — normalization, stability, markers.
- `test/unit/comments.test.ts` — placement partition, incremental review, blocking dismiss, legacy review.
- `test/unit/threads.test.ts` — listing, outdated resolution, degradation on 403.
- `test/unit/delta.test.ts` — scope decision via compare API.

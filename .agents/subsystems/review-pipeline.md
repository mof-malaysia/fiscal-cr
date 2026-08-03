# Subsystem: Review Pipeline

The orchestration core shared by both entry points. Files: `src/review/orchestrator.ts`, `src/review/delta.ts`, `src/pipeline/*`, plus supporting `src/review/{diff-analyzer,file-filter,file-source}.ts` and `src/utils/tokens.ts`.

Start here: [`../index.md`](../index.md) for context, [`../AGENTS.md`](../AGENTS.md) for non-negotiables. Related: [GitHub integration](github-integration.md), [config & providers](config-and-providers.md).

## Responsibilities

`ReviewOrchestrator.reviewPullRequest({ owner, repo, pullNumber, headSha, forceFull? })` runs one review end-to-end:

1. **Create check run** (`src/github/checks.ts`) — always the first GitHub write.
2. **Load prior state + decide scope** (`src/github/review-state.ts`, `src/review/delta.ts`) → `full | delta | skip`.
3. **Extract PR context** (`src/github/pulls.ts`) — metadata, paged file list, unified diff, full file contents (path-filtered for delta reviews; `LocalFileSource` reads the checkout in Action mode, `ApiFileSource` fetches in parallel otherwise).
4. **Filter files** (`src/review/file-filter.ts`) — include/exclude minimatch globs, skip removed/patchless files. Contents are dropped for filtered-out files so prompts never carry lockfiles etc.
5. **Run the review** — fast path or multi-pass pipeline (below).
6. **Publish** — legacy stacked review or sticky lifecycle (dedupe → resolve threads → check run → blocking review → incremental review → sticky comment).

## Scope decision (`delta.ts`)

`decideScope` decides full / delta / skip from `ReviewState` + GitHub compare API:

- `skip`: head already reviewed, or compare says `identical`, or no reviewable files changed.
- `delta`: files changed since `lastReviewedSha` (compare API), under `review.incremental.maxDeltaFiles` and the API's 300-file cap, and `filterFiles` leaves reviewable paths. Returns `paths` (context filter) and `sinceSha` (delta hint + state update).
- `full` (fallback on any uncertainty): incremental disabled, `forceFull`, no prior state, base sha changed, compare failed (force-push), history diverged/behind, delta too large. Rationale in code: *a wasted full review is cheap, a missed finding is not.*

## Review execution (`orchestrator.runReview`)

Token budget: `estimateTokens(patches) + estimateTokens(contents)` over changed files.

- **Fast path** (`src/pipeline/fast-path.ts`): when `!pipeline.enabled` (kill-switch) or total < `pipeline.fastPathThreshold` — one combined LLM call (intent + summary + score + walkthrough + findings), parsed by `parseFastPathResponse`, passed through the same `validateAndRankFindings` gate as the pipeline. Truncated output (`finishReason === 'length'`) is salvaged via `repairTruncatedJson` and warns.
- **Multi-pass pipeline**:
  - **Pass 1 — intent** (`pass1-intent.ts`): one small call (2k max tokens, 60s timeout) for PR intent, walkthrough, grouping hints, risk hotspots. Non-fatal — failure or unparseable output yields `null` and the pipeline proceeds. Output paths are filtered to files actually in the PR.
  - **Grouping** (`grouper.ts`): deterministic — Pass-1 hints seed clusters, remaining files cluster by top path segments, test files migrate to their subject's cluster, oversized clusters split by first-fit-decreasing bin-packing to `pipeline.groupTokenBudget`, tiny groups merge, overflow past `pipeline.maxGroups` collapses into one diff-only group. Output sorted for stable prefix-cache behavior.
  - **Pass 2 — group reviews** (`pass2-review.ts`): one LLM call per group, bounded by `pLimit(config.pipeline.concurrency)`. In Action mode each group also gets unchanged imported files (`related-context.ts`, budget `pipeline.relatedContextBudget`; needs local checkout). A failed group becomes `failed: true` and is noted in the summary, never aborts the run; all groups failing throws `ReviewError`.
  - **Pass 3 — deterministic gate + synthesis** (`pass3-synthesis.ts`): `validateAndRankFindings` drops findings whose end lines aren't in the diff (hallucination guard), filters by confidence (`pipeline.minConfidence`; criticals get a 0.4 floor and are flagged), dedupes same-file+category overlapping ranges (keep higher severity/confidence), applies `review.minSeverity` floor and `review.maxAnnotations` cap. Then `synthesize` — when more than one group, one LLM call (4k max tokens, 90s) writes the final summary/score/walkthrough and may prune near-duplicates/false positives (never criticals); everything has deterministic fallbacks (score from `deterministicScore`, summary from group summaries).
- **Usage**: `UsageTracker` aggregates tokens + call count across all calls, surfaced in `ReviewResult.tokensUsed` / `callCount`.

## Publishing

- **Legacy** (`review.comments.mode: 'legacy'`): `publishLegacy` → `createPRReview` stacks a full review per run. No state, no dedupe.
- **Sticky** (`publishSticky`): dedupe new annotations against `state.postedFingerprints`; overflow past `maxOpenComments` demotes to check-run annotations; `resolveOutdatedThreads` cleans fixed findings; open counts re-derived (full) or adjusted (delta); check run conclusion from cumulative `openCounts`; old blocking review always dismissed, new one posted if still failing; one small incremental review with only new findings (zero + non-blocking → nothing posted); **sticky comment with the new state is saved last**.

## Data/control flow

```text
reviewPullRequest
  ├─ createCheckRun
  ├─ loadReviewState → decideScope
  │    └─ skip? → completeSkippedRun (conclusion carried from openCounts)
  ├─ extractPullRequestContext (pathFilter=scope.paths, fileSource)
  ├─ filterFiles
  ├─ runReview
  │    ├─ fast path (1 call)          ─┐
  │    └─ pass1 → groupFiles → pass2 → │ → validateAndRankFindings → synthesize
  ├─ publishLegacy | publishSticky
  └─ catch → completeCheckRun(failure) → throw ReviewError
```

## Invariants

- Every uncertain scope case falls back to **full** review.
- `validateAndRankFindings` is deterministic and applied identically to fast path and pipeline output.
- Synthesis never drops criticals (dedupe/prune keeps them).
- A single failed group degrades the review; all failed groups fail the run.
- Pass 1 failure is always non-fatal.
- Check run conclusion reflects **cumulative** open counts, not the per-run delta.
- Sticky state is persisted **last**, only after posting succeeded.

## Relevant tests

- `test/unit/orchestrator-lifecycle.test.ts` — sticky lifecycle end-to-end (first run, delta dedupe, fix push, skip, forceFull, legacy).
- `test/unit/orchestrator-pipeline.test.ts` — fast path vs pipeline routing, failed-group tolerance, kill-switch, failure propagation.
- `test/unit/delta.test.ts` — scope decision cases.
- `test/unit/grouper.test.ts`, `test/unit/pass3-synthesis.test.ts`, `test/unit/fast-path.test.ts`, `test/unit/pipeline-schemas.test.ts`, `test/unit/diff-analyzer.test.ts`, `test/unit/file-filter.test.ts`, `test/unit/file-source.test.ts`, `test/unit/related-context.test.ts`, `test/unit/json.test.ts`, `test/unit/tokens.test.ts`, `test/unit/max-output.test.ts`, `test/unit/temperature.test.ts`.

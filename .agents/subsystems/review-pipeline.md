# Subsystem: Review Pipeline

Shared review execution for the GitHub Action and self-hosted App.

Sources: `src/review/orchestrator.ts`, `src/review/{delta,diff-analyzer,
file-filter,file-source}.ts`, `src/pipeline/*`, and `src/utils/tokens.ts`.

See [model presets](model-presets.md) for stage routing and [GitHub
integration](github-integration.md) for API and lifecycle details.

## Responsibilities

`ReviewOrchestrator.reviewPullRequest({ owner, repo, pullNumber, headSha,
forceFull? })`:

1. Loads sticky state and decides `full`, `delta`, or `skip`.
2. Ensures the App Check Run; Action mode uses its workflow check.
3. Extracts PR metadata, files, patches, and content.
4. Filters files by include/exclude globs, size, status, and patch presence.
5. Runs the fast path or multi-pass review.
6. Generates an optional visualization for eligible full reviews.
7. Publishes the result and saves sticky state last.

## Scope decision

`decideScope` uses state, the GitHub compare API, and incremental settings:

- `skip`: the head is already reviewed, the compare is identical, or no
  reviewable files changed.
- `delta`: changed paths since `lastReviewedSha` fit the configured limit and
  still contain reviewable files. It returns paths and `sinceSha`.
- `full`: incremental is disabled, `forceFull` is set, state is absent, the
  base changed, compare failed or diverged, or the delta is too large.

Uncertainty always chooses a full review.

## Review execution

The token estimate covers changed patches and file contents. Every call uses
the model resolved for its stage; see [model presets](model-presets.md).

- **Fast path** (`fast-path.ts`): used when the pipeline is disabled or the
  estimate is below `fastPathThreshold`. One call returns summary, score,
  walkthrough, and findings. Truncated JSON is salvaged when possible.
- **Pass 1** (`pass1-intent.ts`): produces intent, walkthrough, risk hotspots,
  and grouping hints. Failure is non-fatal.
- **Grouping** (`grouper.ts`): deterministic hints, path clustering,
  test-file migration, bin-packing, small-group merging, and overflow handling.
- **Pass 2** (`pass2-review.ts`): reviews groups in parallel under
  `pipeline.concurrency`. Action mode adds unchanged imported files within
  `relatedContextBudget`. A failed group degrades the result; all failures
  fail the run.
- **Pass 3** (`pass3-synthesis.ts`): validates diff lines, filters confidence,
  deduplicates, ranks, applies severity and annotation limits, then synthesizes
  the final review when multiple groups exist. Deterministic fallbacks cover
  missing synthesis output.
- **Visualization** (`visualize.ts`): full reviews meeting file and line
  thresholds get one bounded, structured visual call. Mode selection is
  deterministic; parse or provider failure leaves the review unchanged.

`UsageTracker` aggregates tokens, costs, and calls across review and
visualization stages.

## Publishing

- **Legacy** (`review.comments.mode: legacy`): posts a complete review each run
  without lifecycle state.
- **Sticky** (`review.comments.mode: sticky`): reconciles the complete finding
  inventory against the successful reviewed scope, resolves fixed threads,
  posts newly open findings, completes the Check Run, and saves the v2 marker.
  Delta reviews preserve the previous visualization.

## Data flow

```text
load state → decide scope → extract → filter
  → fast path
    or intent → group → parallel reviews → validate → synthesize
  → optional full-review visualization
  → publish → save sticky state last
```

## Invariants

- Uncertain scope falls back to full review.
- The deterministic finding gate applies to both routes.
- Synthesis never removes critical findings.
- One failed group degrades; all failed groups fail.
- Pass 1 and visualization failures are non-fatal.
- Check conclusions use cumulative open findings.
- Sticky state is saved only after publication succeeds.

## Relevant tests

- Lifecycle and routing: `orchestrator-lifecycle.test.ts`,
  `orchestrator-pipeline.test.ts`, `run-review.test.ts`, `delta.test.ts`
- Stages and parsing: `fast-path.test.ts`, `grouper.test.ts`,
  `pass3-synthesis.test.ts`, `pipeline-schemas.test.ts`, `json.test.ts`
- Context and accounting: `diff-analyzer.test.ts`, `file-filter.test.ts`,
  `file-source.test.ts`, `related-context.test.ts`, `tokens.test.ts`,
  `temperature.test.ts`, `max-output.test.ts`
- Visual output: `change-diagram.test.ts`, `diagram-renderer.test.ts`,
  `summary-builder.test.ts`

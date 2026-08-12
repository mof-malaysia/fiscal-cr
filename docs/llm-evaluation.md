# Local LLM evaluation

A local harness exercises the real production routing and review-pipeline
implementation (`src/pipeline/run-review.ts`) against a deterministic 11-case
gold benchmark suite — no GitHub API, repository, or pull request involved.
Each case is a small synthetic PR with hand-authored expected issues; every
case runs once as **baseline** and once as **experimental** per round.

**Defensible scope.** The harness prepares a `PullRequestContext` (title,
description, changed-file patches and full content) and then calls the same
`runReviewPipeline` the production orchestrator uses, so routing
(fast-path vs multi-pass) and every review stage run the real implementation.
It deliberately stops there: it performs **no GitHub publishing side effects**
(no check runs, reviews, comments, or state markers) and does **not** exercise
the GitHub Action workspace-context path or the full GitHub lifecycle. Results
are a signal for this pipeline's review behavior, not an end-to-end GitHub
integration test.

## Quick start

```bash
# Keyless, no network: prints the plan (routes, attempts, provider-call upper
# bound), budget check, and per-variant suite prompt char/token stats
make eval-llm-dry

# Live smoke (default): 3 fast-path cases × EVAL_RUNS × 2 variants = 6 attempts
make eval-llm

# Live full suite: 11 cases × EVAL_RUNS × 2 variants = 22 attempts
make eval-llm-full

# Keyless focused dry run of the pipeline-01 multi-pass canary
make eval-llm-pipeline-dry
```

Secure usage:

- Export the key in your shell; never paste it into chat, commit it, or pass it
  on the command line. The harness reads `API_KEY` (fallbacks
  `FISCALCR_API_KEY`, `ANTHROPIC_API_KEY`, then `KIMI_API_KEY`) from the environment only and never
  prints or logs it.
- A root `.env` is auto-loaded when present, so `make eval-llm` needs no manual
  exports. Already-exported variables win over `.env`. `.env` is gitignored —
  never commit it, and the harness never reads, prints, or logs its values.
- Node may print a benign `DEP0205` warning about `--env-file`; it is left
  as-is (the harness does not suppress warnings or change `NODE_OPTIONS`).

## Attempts vs. provider calls

An **attempt** is one baseline or experimental run of the production review
pipeline on one case. Planned attempts = `cases × runs × 2`.

A single attempt may issue more than one **provider LLM call**, depending on
the route the production runner selects:

- **fast-path** attempts cost at most **1** provider call.
- **multi-pass** attempts cost at most **1 (intent) + maxGroups (group
  reviews) + 1 (synthesis when more than one group)** — with the default
  `maxGroups = 8`, at most **10** provider calls.

`EVAL_MAX_CALLS` guards the **provider-call upper bound** (the sum of these
per-attempt bounds), not the attempt count. The harness also records the
**actual** provider calls issued per attempt and in aggregate.

## Suite taxonomy

- `EVAL_SUITE` (`smoke` default | `full`) picks the case set: 3 smoke cases
  (`clean-01`, `local-01`, `security-01`) or all 11.
- `EVAL_CASES` (exact comma-separated override, e.g. `clean-01, security-01`)
  beats `EVAL_SUITE` when both are set. Focused runs make `2 × N` attempts for
  N cases. Unknown, empty, or duplicate ids are rejected.
- `EVAL_RUNS` (positive integer, default `1`) sets A/B rounds **per case**.
  Planned attempts = `cases × runs × 2`. The default smoke run is
  `3 × 1 × 2 = 6` attempts; the full suite at the default runs is
  `11 × 1 × 2 = 22` attempts.
- `EVAL_SEED` (non-empty string, default `fiscalcr-eval-v2`) deterministically
  rotates case order per round; variant order per case follows an AB / BA /
  BA / AB pattern so order bias cancels per case. The seed version is kept for
  deterministic continuity across runs.
- `EVAL_MAX_CALLS` (default `20` for smoke/focused runs, `40` for the full
  suite) is a guard enforced **immediately before any
  live provider is created or any network call is made** — a plan whose
  provider-call upper bound exceeds it fails with a nonzero exit and a message
  showing the exact override. Dry runs show the same guard without failing and
  never touch the network or write artifacts.

### Provider-call upper bounds

| Suite / run          | Attempts | Provider-call upper bound |
| -------------------- | -------- | ------------------------- |
| smoke, `EVAL_RUNS=1` | 6        | 6 (all fast-path)         |
| full, `EVAL_RUNS=1`  | 22       | 40 (10 fast-path × 1 + pipeline-01 × 10) |
| full, `EVAL_RUNS=4`  | 88       | **160** (decision run)    |

The 11-case × 4-round decision run upper bound is **160** provider calls
(`10 fast-path cases × 8 attempts × 1 + pipeline-01 × 8 attempts × 10 =
80 + 80`) and requires `EVAL_MAX_CALLS=160`
(`EVAL_RUNS=4 EVAL_MAX_CALLS=160 EVAL_SUITE=full make eval-llm`).

## Metrics

Metrics are reported **per attempt** (one baseline or experimental run of the
pipeline on one case), with **stage and per-provider-call detail**:

- Per attempt: the route taken (`fast-path` / `multi-pass`), the actual number
  of provider LLM calls issued, per-stage outcomes (`intent` / `group-review` /
  `synthesis` / `fast-path`, each `success` or `failed`), total input/output/
  cached tokens, raw output characters, duration, retained vs gold counts,
  TP/FP/FN/F1 against the case gold, and model self-score.
- Per provider call: prompt hashes/counts (per-message sha256, char counts,
  estimated tokens — never the prompt), duration, usage, finish reason, and on
  success the parse/contract metadata; on rejection a sanitized error
  code/message only.
- **Fast-path-only fields are nullable on multi-pass.** `parseSuccess`,
  `contractComplete`, `conciseCompliant`, `zeroFindingsKind`, word-count and
  walkthrough-coverage metrics describe the single fast-path response's
  contract compliance and are `null` on the multi-pass route — never false
  evidence. Multi-pass generated findings are counted only from `group-review`
  captures (stage truth), never from intent/synthesis responses.
- **Failed provider calls may still yield a completed attempt.** A stage that
  fails is recorded as a `failed` stage outcome; if the pipeline still produces
  a review, the attempt is `completed` with `degraded: true`. Only a fatal
  failure (e.g. all review groups failed) produces a `failed` attempt. A failed
  provider call never aborts the plan — the harness records the sanitized
  failure and continues. Exit code is nonzero only for config/budget/fatal
  setup/artifact failures, never for a model-call failure.
- Final blocks: execution counts (planned/completed/failed/completion rate),
  post-gate quality (micro P/R/F1, macro F1, clean rate [FP-free runs], severe
  FPs, duplicates, TP per 1k output tokens) per variant, reliability/efficiency
  diagnostics (parse/contract/format-length rates, median output tokens/raw
  chars/duration), paired deltas over **complete pairs only** (output savings,
  raw-char savings, F1/TP/FP deltas), and a large-regression report that only
  issues a verdict at `EVAL_RUNS >= 4` (below that it is labeled
  insufficient/directional). Model self-score and finding count are reported
  as diagnostics, never headlined as quality.

Quality metrics and gold limitations:

- Quality is measured by matching generated findings to the hand-authored gold
  issues per case (exact path + overlapping line + accepted category, resolved
  with one-to-one maximum-cardinality matching). Severity is scored as
  agreement, not detection. `clean` cases are closed-world: any finding on them
  is a false positive.
- The gold suite is small and synthetic; scores are a signal for regressions in
  this harness, not a general model ranking. Vacuous-truth conventions apply
  when a case has no predictions or no gold (e.g. an empty clean review is
  perfect precision and recall).
- Output **tokens** come from the provider's usage report; visible **raw
  characters** are the actual response text length. They are reported
  separately because token estimates and character counts differ per model.

## Blind review

After a live run with at least one complete baseline+experimental pair, the
harness writes two sidecar files with the same timestamp stem:
`.eval-results/eval-<timestamp>-blind.md` and `...-blind-key.json`.

The Markdown pack contains every complete pair rendered as **Review A** and
**Review B** with deterministic randomized side assignment (based on
`EVAL_SEED` + pair id). The pack includes the PR context (title, description,
changed-file patches and full content) and a concise scoring worksheet per
pair. It deliberately excludes baseline/experimental labels, prompt metadata,
token counts, timing, gold issue manifests, and quality metrics.

The answer key maps each `blindPairId` to which variant is Review A and
which is Review B. It contains no review text, no context, and no secrets.

**Workflow:** run the benchmark, open only the `-blind.md` pack, score each
pair using the rubric, then open the `-blind-key.json` to unblind. Do not
open the key before scoring.

An 11-case × 4-round decision run produces 44 pairs. A practical human
review samples or stratifies from that pool; 20 well-chosen pairs are
usually enough to detect meaningful explanation-quality differences.

Gold metrics (automated TP/FP/FN/F1) test **detection** against planted
issues. The blind pack tests **explanation quality** — clarity,
actionability, and usefulness — which automated metrics do not measure.

## Configuration reference

| Variable             | Default            | Notes                                             |
| -------------------- | ------------------ | ------------------------------------------------- |
| `API_KEY`            | — (live only)      | Falls back to `FISCALCR_API_KEY`, then `KIMI_API_KEY` |
| `MODEL_PROVIDER`     | `kimi`             | `kimi`, `openai-compatible`, `openai`, or `anthropic` |
| `MODEL`              | `kimi-for-coding`  | Falls back to `KIMI_MODEL`, then the default      |
| `KIMI_MODEL`         | `kimi-for-coding`  | Kimi model override, e.g. `kimi-k2.5`             |
| `ANTHROPIC_API_KEY` | —                  | Anthropic-specific API key fallback                |
| `ANTHROPIC_MODEL`   | —                  | Anthropic-specific model fallback                  |
| `BASE_URL`           | provider default   | Falls back to `FISCALCR_BASE_URL`                 |
| `LLM_USER_AGENT`     | —                  | Optional custom User-Agent for whitelisting       |
| `EVAL_SUITE`         | `smoke`            | `smoke` (3 cases) or `full` (11 cases)            |
| `EVAL_CASES`         | —                  | Exact comma-separated override; beats `EVAL_SUITE` |
| `EVAL_RUNS`          | `1`                | A/B rounds per case; attempts = cases × runs × 2  |
| `EVAL_SEED`          | `fiscalcr-eval-v2` | Deterministic per-round case rotation             |
| `EVAL_MAX_CALLS`     | `20`; full: `40`    | Provider-call upper-bound guard; full 11×4 decision run needs `160` |

Examples:

```bash
export API_KEY=sk-...
export MODEL_PROVIDER=openai-compatible
export MODEL=gpt-4.1-mini
export BASE_URL=https://api.openai.com/v1
make eval-llm            # smoke, 6 attempts (6 provider calls)
make eval-llm-full       # full suite, 22 attempts (up to 40 provider calls)
```

```bash
EVAL_RUNS=3 make eval-llm          # smoke, 18 attempts (3 cases × 3 rounds × 2)
EVAL_CASES=clean-01,local-01 make eval-llm   # focused, 4 attempts
EVAL_RUNS=4 EVAL_MAX_CALLS=160 EVAL_SUITE=full make eval-llm   # decision run, 88 attempts (up to 160 calls)
```

Or drop the same variables in a root `.env` (exported env still wins) and run
bare:

```bash
make eval-llm
make eval-llm-dry   # still zero calls — the key is read but never sent
```

## Artifacts

After a live run (even one where every call failed) the harness writes a
timestamped, secret-safe JSON artifact to
`.eval-results/eval-<timestamp>.json` (gitignored).

It carries the schema id **`fiscalcr-eval-v3`** and the suite identity
`fiscalcr-eval-v3-pipeline`, plus:

- suite metadata (selected case ids, seed) and sanitized plan entries — one
  per attempt, with the **route** (fast-path / multi-pass) and the per-attempt
  provider-call upper bound;
- per-attempt outcomes with a **`completed` | `failed`** status. A completed
  attempt may carry `degraded: true` (a pipeline stage failed but a review was
  still produced) and the per-stage outcomes (`intent` / `group-review` /
  `synthesis` / `fast-path`, each `success` or `failed`);
- prompt **hashes and counts only** (per-message sha256, char counts,
  estimated tokens) — never raw prompts or raw responses;
- the final review text and quality report for completed attempts;
- **actual provider calls** issued per attempt and in aggregate, plus
  planned/completed/failed/degraded counts and the provider-call upper bound.

**Prompt-preview vs. actual-call hash evidence.** The artifact's `prompt`
section is a *static suite-level preview*: it hashes only the statically
buildable **fast-path** prompts (the ones actually sent on that route). Cases
routed **multi-pass** are listed in `prompt.dynamicMultiPassCaseIds` /
`dynamicMultiPassCount` and are **excluded** from the preview — their stage
prompts are generated during live execution, so no fabricated fast-path prompt
is ever hashed. The source of truth for live multi-pass prompts is the
**per-call hashes captured in each attempt's `captures`** (per-message sha256
of the prompts actually sent). A pipeline-only selection therefore has a
`prompt` preview hash that represents "no static prompt preview", not a fake
fast-path prompt.

It never contains the API key, operator base URL, environment dump, request
headers, or raw provider response bodies; `assertArtifactSafe` proves the
artifact free of forbidden content and the live key before anything is
written. Repository metadata is only a commit hash + dirty flag, captured
best-effort with fixed git arguments and nulled on failure.

## Interpreting results

- Use automated metrics (TP/FP/FN/F1) to catch **detection regressions**.
- Use the blind pack to judge **explanation quality** (clarity,
  actionability, usefulness) when comparing baseline and experimental prompts.
- A decision run (`EVAL_RUNS=4`, 88 attempts, up to 160 provider calls, 44
  pairs) is the recommended minimum for reliable paired comparison; below 4
  runs the regression report is labeled directional/insufficient.
- Model self-score and raw finding count are diagnostics, not quality
  headlines.

## Limitations

- The gold suite is small and synthetic; scores are a signal for regressions
  in this harness, not a general model ranking.
- The harness runs the production routing/review pipeline but performs no
  GitHub publishing side effects and does not cover the GitHub Action
  workspace-context path or the full GitHub lifecycle.
- Vacuous-truth conventions apply when a case has no predictions or no gold.
- Blind human review is manual and time-consuming; sample or stratify rather
  than scoring every pair.

## Pricing estimates

FiscalCR resolves a provider/model pricing snapshot for cost estimates.
Known direct-provider model families include OpenAI GPT-5.6 Luna, Terra, and
Sol, Anthropic Claude 5, and Kimi Open Platform models; OpenRouter model IDs
use OpenRouter-specific rates when the configured endpoint is OpenRouter.
Unknown OpenRouter models receive a best-effort lookup from the public model
endpoint, cached for one hour. Other unknown models use the legacy fallback
estimate.

Current Kimi Open Platform snapshot rates (USD per 1M tokens):

| Model | Cache hit | Cache miss | Output |
| --- | ---: | ---: | ---: |
| `kimi-k3` | $0.30 | $3.00 | $15.00 |
| `kimi-k2.7-code` | $0.19 | $0.95 | $4.00 |
| `kimi-k2.7-code-highspeed` | $0.38 | $1.90 | $8.00 |
| `kimi-k2.6` | $0.16 | $0.95 | $4.00 |

Legacy `kimi-k2.7` and `kimi-k2-7` IDs use the K2.7 Code rate.

Pricing lookup has a two-second timeout and cannot fail a review; a failed
lookup returns the fallback estimate. Telemetry marks estimates as `exact`,
`family`, `remote`, or `fallback`. Rates can change, and long-context tiers,
routing, discounts, batch/priority modes, and subscription quotas can make
the estimate differ from the actual bill.

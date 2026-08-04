# Local LLM evaluation

A local harness exercises the real provider, fast-path, and usage-tracking code
against a deterministic 10-case gold benchmark suite — no GitHub API,
repository, or pull request involved. Each case is a small synthetic PR with
hand-authored expected issues; every case runs once as **baseline** and once as
**experimental** per round.

## Quick start

```bash
# Keyless, no network: prints the plan, budget check, and per-variant suite
# prompt char/token stats
make eval-llm-dry

# Live smoke (default): 3 cases × EVAL_RUNS × 2 variants = 6 calls
make eval-llm

# Live full suite: 10 cases × EVAL_RUNS × 2 variants = 20 calls
make eval-llm-full
```

Secure usage:

- Export the key in your shell; never paste it into chat, commit it, or pass it
  on the command line. The harness reads `API_KEY` (fallbacks
  `FISCALCR_API_KEY`, then `KIMI_API_KEY`) from the environment only and never
  prints or logs it.
- A root `.env` is auto-loaded when present, so `make eval-llm` needs no manual
  exports. Already-exported variables win over `.env`. `.env` is gitignored —
  never commit it, and the harness never reads, prints, or logs its values.
- Node may print a benign `DEP0205` warning about `--env-file`; it is left
  as-is (the harness does not suppress warnings or change `NODE_OPTIONS`).

## Suite taxonomy

- `EVAL_SUITE` (`smoke` default | `full`) picks the case set: 3 smoke cases
  (`clean-01`, `local-01`, `security-01`) or all 10.
- `EVAL_CASES` (exact comma-separated override, e.g. `clean-01, security-01`)
  beats `EVAL_SUITE` when both are set. Focused runs make `2 × N` calls for N
  cases. Unknown, empty, or duplicate ids are rejected.
- `EVAL_RUNS` (positive integer, default `1`) sets A/B rounds **per case**.
  Planned calls = `cases × runs × 2`. The default smoke run is
  `3 × 1 × 2 = 6` calls; the full suite at the default runs is
  `10 × 1 × 2 = 20` calls.
- `EVAL_SEED` (non-empty string, default `fiscalcr-eval-v2`) deterministically
  rotates case order per round; variant order per case follows an AB / BA /
  BA / AB pattern so order bias cancels per case.
- `EVAL_MAX_CALLS` (default `20`) is a guard enforced **immediately before any
  live provider call** — a plan exceeding it fails with a nonzero exit and a
  message showing the exact override. Dry runs show the same guard without
  failing and never touch the network or write artifacts.
- The 10-case × 4-round decision run is **80 calls** and requires
  `EVAL_MAX_CALLS=80` (`EVAL_RUNS=4 EVAL_MAX_CALLS=80 EVAL_SUITE=full make eval-llm`).

## Metrics

What a run reports:

- Per completed call: parse success (real `parseFastPathResponse`), contract
  completeness, format-length compliance, retained vs gold counts, TP/FP/FN/F1
  against the case gold, output tokens, raw output characters, and duration.
- Per failed call: a sanitized error code/message only. Individual model-call
  failures never abort the plan — the harness records a `failed` attempt,
  prints a compact safe line, and continues. Exit code is nonzero only for
  config/budget/fatal setup/artifact failures, never for a model-call failure.
- Final blocks: execution counts (planned/completed/failed/completion rate),
  post-gate quality (micro P/R/F1, macro F1, clean-FP rate, severe FPs,
  duplicates, TP per 1k output tokens) per variant, reliability/efficiency
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

A 10-case × 4-round decision run produces 40 pairs. A practical human
review samples or stratifies from that pool; 20 well-chosen pairs are
usually enough to detect meaningful explanation-quality differences.

Gold metrics (automated TP/FP/FN/F1) test **detection** against planted
issues. The blind pack tests **explanation quality** — clarity,
actionability, and usefulness — which automated metrics do not measure.

## Configuration reference

| Variable             | Default            | Notes                                             |
| -------------------- | ------------------ | ------------------------------------------------- |
| `API_KEY`            | — (live only)      | Falls back to `FISCALCR_API_KEY`, then `KIMI_API_KEY` |
| `MODEL_PROVIDER`     | `kimi`             | `kimi` or `openai-compatible`                     |
| `MODEL`              | `kimi-for-coding`  | Falls back to `KIMI_MODEL`, then the default      |
| `KIMI_MODEL`         | `kimi-for-coding`  | Kimi model override, e.g. `kimi-k2.5`             |
| `BASE_URL`           | provider default   | Falls back to `FISCALCR_BASE_URL`                 |
| `LLM_USER_AGENT`     | —                  | Optional custom User-Agent for whitelisting       |
| `EVAL_SUITE`         | `smoke`            | `smoke` (3 cases) or `full` (10 cases)            |
| `EVAL_CASES`         | —                  | Exact comma-separated override; beats `EVAL_SUITE` |
| `EVAL_RUNS`          | `1`                | A/B rounds per case; plan = cases × runs × 2      |
| `EVAL_SEED`          | `fiscalcr-eval-v2` | Deterministic per-round case rotation             |
| `EVAL_MAX_CALLS`     | `20`               | Budget guard; full 10×4 decision run needs `80`   |

Examples:

```bash
export API_KEY=sk-...
export MODEL_PROVIDER=openai-compatible
export MODEL=gpt-4.1-mini
export BASE_URL=https://api.openai.com/v1
make eval-llm            # smoke, 6 calls
make eval-llm-full       # full suite, 20 calls
```

```bash
EVAL_RUNS=3 make eval-llm          # smoke, 18 calls (3 cases × 3 rounds × 2)
EVAL_CASES=clean-01,local-01 make eval-llm   # focused, 4 calls
EVAL_RUNS=4 EVAL_MAX_CALLS=80 EVAL_SUITE=full make eval-llm   # decision run, 80 calls
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

It carries the schema id `fiscalcr-eval-v2`, suite metadata, selected case
ids + seed, sanitized plan entries, per-attempt outcomes (completed metrics
and quality, or sanitized failures), fixture manifests with gold issues,
baseline/experimental prompt fingerprints (suite-level sha256 over
case id/version + exact prompts, plus total chars), repo commit/dirty flags,
config (runs/planned/completed/failed/timeout/max calls), and the aggregate
benchmark result. Completed attempts keep the parsed and final review text
for the later blind human pack.

It never contains the API key, operator base URL, environment dump, request
headers, or raw provider response bodies; `assertArtifactSafe` proves the
artifact free of forbidden content and the live key before anything is
written. Repository metadata is only a commit hash + dirty flag, captured
best-effort with fixed git arguments and nulled on failure.

## Interpreting results

- Use automated metrics (TP/FP/FN/F1) to catch **detection regressions**.
- Use the blind pack to judge **explanation quality** (clarity,
  actionability, usefulness) when comparing baseline and experimental prompts.
- A decision run (`EVAL_RUNS=4`, 80 calls, 40 pairs) is the recommended
  minimum for reliable paired comparison; below 4 runs the regression report
  is labeled directional/insufficient.
- Model self-score and raw finding count are diagnostics, not quality
  headlines.

## Limitations

- The gold suite is small and synthetic; scores are a signal for regressions
  in this harness, not a general model ranking.
- Vacuous-truth conventions apply when a case has no predictions or no gold.
- Blind human review is manual and time-consuming; sample or stratify rather
  than scoring every pair.

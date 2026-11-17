# History suite: real reverted-or-hotfixed and healthy PRs

The synthetic suite in `eval/cases.ts` has 11 hand-built PRs. This suite adds
real merged PRs from public, permissively licensed repos:

- **bad** PRs, which were reverted or hotfixed soon after merging, each with a
  hand-written **cause label**;
- **healthy** PRs from the same repos and period, which nothing reverted or
  fixed.

ROADMAP "Next" uses it to test a claimed-versus-actual check (#38, #39): does
comparing what a PR says with what it changes surface the bad PR's cause, and
how often does it fire on healthy PRs?

Nothing from the source repos is committed. `cases.json` holds pointers (repo,
PR number, pinned SHAs), the licence, the evidence link, size facts and the
cause label. The code, title and body are fetched at run time into the
gitignored `.cache/eval-history/`.

## What is in it

25 bad and 30 healthy cases (55 in all) from 9 repos, merged between
2025-12 and 2026-10. The issue asked for about 30 bad; 25 is inside its 25–35
band. The bad source ran dry under the rules below: most reverts in these repos
are for non-code reasons or name no cause, the 30-day window and the 6-per-repo
cap are strict, and a candidate is dropped when its cause sits in a file the
production filter skips or when the PR is off the fast path. Adding more uses
the steps under "Adding cases".

| | bad | healthy |
| --- | --- | --- |
| Evidence: revert / fix PR | 21 / 4 | – |
| Over the 25k-token target (all under 80k) | 9 | 4 |
| Empty body | 1 | 0 |
| Median estimated tokens | 12.6k | 11.5k |

## Use it

```sh
make eval-history-fetch       # read-only GitHub API calls; no provider calls
make eval-llm-history-dry     # plan, routes and call bound; no key, no network
EVAL_SUITE=history EVAL_CASES=hono-4707,vue-15319 make eval-llm-dry
```

The fetch needs a GitHub token for the rate limit: `GITHUB_TOKEN`, `GH_TOKEN`,
or the `gh` CLI's login (`gh auth token`). Any read-only token works. The token
is never printed or stored. A second fetch skips cases already cached with the
same pinned SHAs (`--force` refetches).

`EVAL_SUITE=history` reads only the cache. When a case is missing it fails and
names the fetch command. It keeps the default `EVAL_MAX_CALLS` guard of 20, so
a live run of the whole suite needs an explicit guard (2 attempts per case, 1
provider call each): `EVAL_SUITE=history EVAL_MAX_CALLS=<2 × cases> make eval-llm`.
Live runs are #39's job.

## Manifest format (`cases.json`)

`manifest.ts` defines the format with zod and `validateManifest()` checks it;
`eval/__tests__/history.test.ts` runs that check on the committed file.

```jsonc
{
  "schemaVersion": 1,
  "suiteId": "fiscalcr-eval-history",
  "cases": [
    {
      "id": "hono-4707",                 // kebab-case, <repo short name>-<PR number>
      "kind": "bad",                     // "bad" | "healthy"
      "repo": "honojs/hono",
      "licence": "MIT",                  // SPDX id: MIT, Apache-2.0, BSD-2-Clause, BSD-3-Clause, ISC
      "pr": 4707,
      "mergedAt": "2026-02-19T10:27:57Z",
      "baseSha": "…40 hex…",             // PR base at merge time
      "headSha": "…40 hex…",             // PR head at merge time: the code the review sees
      "mergeSha": "…40 hex…",            // merge or squash commit on the base branch
      "language": "typescript",          // main language of the changed code
      "size": {                          // measured from the materialised context
        "files": 1, "additions": 14, "deletions": 6,
        "estimatedTokens": 5853          // fast-path estimate: patches + full files
      },
      "description": { "titleChars": 71, "bodyChars": 2152 },
      "tags": [],                        // see Tags
      // bad cases only:
      "evidence": {
        "kind": "revert",                // "revert" | "fix"
        "url": "https://github.com/honojs/hono/pull/4757",
        "pr": 4757,
        "mergedAt": "2026-02-23T07:16:34Z"
      },
      "cause": {                         // ExpectedIssue from eval/quality.ts
        "issueId": "hono-4707-cause",
        "acceptedPaths": ["src/context.ts"],
        "acceptedLineRanges": [{ "startLine": 710, "endLine": 712 }],
        "acceptedCategories": ["bug", "security", "performance", "style",
          "best-practice", "documentation", "testing", "other"],
        "minSeverity": "nitpick",
        "maxSeverity": "critical",
        "rationale": "The one-sentence cause.",
        "evidence": "<evidence url> — what the evidence says, in our words."
      }
    }
  ]
}
```

Rules the validator enforces beyond the shapes: unique `id`s and PRs; a
`cause` and `evidence` on every bad case and neither on a healthy one; the
evidence merged after the PR and cited in `cause.evidence`; at most 6 bad cases
per repo; the `empty-body` tag set exactly when `bodyChars` is 0; no unknown
fields (so nothing like an author login can slip in).

Line numbers in `acceptedLineRanges` are **new-file lines at `headSha`**, the
lines a review comments on. The loader checks that every accepted path is a
reviewed file in the context and that every range touches an added or context
line of its diff, so a label the matcher could never hit fails loudly.

### How the harness sees a case

`loader.ts` turns each entry plus its cached context into a `BenchmarkCase`:

- `context`: owner, repo, PR number, the pinned SHAs, the title and body, the
  per-file patches from `compare base...head`, and full contents at `headSha`.
  Files go through the production default include/exclude filter and the
  `files.maxFileSize` cap, as in `src/github/pulls.ts` and the orchestrator.
- `expectedIssues`: `[cause]` for a bad case, `[]` for a healthy one.
- `label`: `owner/repo#pr`; `tags`: `history`, the kind, the language, then the
  manifest tags.

The existing matcher scores a cause by path, overlapping lines and category, so
the claim-check scoring in #38 can use `evaluateRunQuality` unchanged. One
caveat: the existing quality metrics treat a case with no expected issues as
closed-world, so every finding on a healthy PR counts as a false positive.
Real healthy PRs are not a closed world, and #38 reports them differently.

### Tags

| Tag | Meaning |
| --- | --- |
| `empty-body` | The PR body is empty, so "claimed" is weak. #39 reports these separately. |
| `body-edited-after-merge` | The body was edited after the merge. The fetch takes the current body; the leak check below still applies. |
| `over-target-size` | Over the 25k-token target, still under the 80k fast-path threshold. |

## Selection rules

**Repos.** Nine active public repos with an OSI-permissive licence, PRs that
usually have a description, and squash or merge-PR workflows. Mostly TS/JS, to
match FiscalCR's users, plus Rust, Python and Go:

| Repo | Licence | Language |
| --- | --- | --- |
| honojs/hono | MIT | TypeScript |
| vuejs/core | MIT | TypeScript |
| pnpm/pnpm | MIT | TypeScript |
| vitest-dev/vitest | MIT | TypeScript |
| prettier/prettier | MIT | JavaScript |
| astral-sh/uv | Apache-2.0 | Rust |
| astral-sh/ruff | MIT | Rust |
| pydantic/pydantic | MIT | Python |
| cli/cli | MIT | Go |

At most 6 bad PRs per repo. All PRs were merged between 2025-11-17 and
2026-11-17, the 12 months before the set was built, to limit the chance that a
model has seen the revert. `mergedAt` is recorded so #39 can check whether age
matters.

**Bad PR.** A merged PR P followed within 30 days by either:

- (a) a revert of P (`Revert "…"`, `Reverts owner/repo#N`, `This reverts commit <sha>`), or
- (b) a fix PR that names P as the cause and changes lines P added or changed.

The evidence must say why, and the cause must be visible in P's own diff.

**Excluded:** reverts for non-code reasons (merged too early or to the wrong
branch, release timing or policy, "accidentally merged", revert-of-revert, CI
flake), bot and dependency-bump PRs, docs-only PRs, generated or vendored
files, and PRs whose cause is only in code P did not touch.

**Healthy PR.** A merged PR from the same repos and period, of similar size,
that is not a bot, docs, test-only, CI or release PR. No revert names it, and
no fix-, revert-, hotfix- or regression-type commit touched any of its changed
files within 90 days of the merge.

**Size cap.** Every case must stay on the fast path (`fastPathThreshold`,
80k tokens), so each attempt is one provider call. The target is 25k tokens or
less including full files; larger cases are tagged `over-target-size`.

**What the review sees.** The PR as it was at merge time: title, body and the
diff at the pinned SHAs. No comments, reviews, later commits or links to the
revert or fix. The loader refuses a case whose title or body names the
evidence (its URL, `#number`, `owner/repo#number`, pull link or reverted
commit).

## Decisions where the rules were ambiguous

- **Healthy check is file-level, not line-level.** Any fix-type commit on any
  changed file within 90 days excludes the PR. This is stricter than the
  issue's line-level rule and needs no blame calls. It is biased towards files
  that change less often, which is why pnpm, whose files change constantly,
  has few healthy cases.
- **Production file filter.** Paths the production default excludes (e.g.
  `**/build/**`) are not reviewed, so a bad PR whose cause sits only in such a
  path is excluded (e.g. a Next.js PR whose cause was in `src/build/`).
- **Performance reverts count.** A revert for a measured slowdown (hono-5113,
  hono-5174, uv-22234) is a code reason. These are hard cases: the cause is
  visible in the diff, but only a benchmark shows it.
- **Reviewer-found reverts count** when a maintainer shows that the change is
  wrong (ruff-24929, ruff-26775, pydantic-13503), even if no user hit it yet.
- **Behaviour changes count** when the evidence calls them a regression or
  breaking (pnpm-13074, vue-15347), not when it is a product decision.
- **The 30-day window is strict.** vitest #10744 (fixed 30 days and 1 hour
  later) is out.
- **TanStack/router is out.** Its name contains `stack`, which the artifact
  safety check (`assertArtifactSafe`) rejects in fixture labels and evidence,
  and a live run would fail after spending. Next.js and Astro were also
  considered: Astro's licence field is not a single SPDX id, and the Next.js
  candidates were off the fast path or had their cause in an excluded path.
- **Body edits.** The fetch takes the PR body as it is today. GitHub does not
  give the body at merge time without edit history, so the leak check is the
  guard, and the draft step tags bodies edited after the merge.
- **Cause labels accept every category and severity**, as the issue asks.
  Line ranges cover the lines that carry the cause, not the whole hunk; where a
  cause spans two places in one file, both ranges are listed.

## Adding cases

1. Find candidates (read-only API calls; no provider calls):

   ```sh
   ./node_modules/.bin/tsx eval/history/collect.ts bad owner/repo --since 2025-11-17
   ./node_modules/.bin/tsx eval/history/collect.ts healthy owner/repo --since 2025-11-17 --until 2026-06-30 --limit 5
   ```

2. Read the evidence and P's diff. Keep the case only if the rules above hold.
3. Draft the entry, which measures size and description from the materialised
   context:

   ```sh
   ./node_modules/.bin/tsx eval/history/collect.ts draft owner/repo 1234 --revert https://github.com/owner/repo/pull/1240
   ```

4. Fill `id`, `language` and, for a bad case, the cause: path, new-file line
   range at `headSha`, one sentence, and the evidence in your own words. Keep it
   free of the substrings `assertArtifactSafe` rejects (`stack`, `headers`,
   `authorization`, `apiKey`, `baseUrl`, `rawResponse`); a test checks this.
5. `make eval-history-fetch` must report no unusable cases, and `pnpm test` must
   pass.

## Second reading

The acceptance criteria ask a second reader (Irfan or the PR author) to check
at least 10 cause labels against their evidence and note disagreements here.

Pending. Suggested ten, one or more per repo:

| Case | Reader | Agrees? | Note |
| --- | --- | --- | --- |
| hono-4707 | | | |
| vue-14548 | | | |
| pnpm-10334 | | | |
| prettier-19273 | | | |
| vitest-10726 | | | |
| uv-21569 | | | |
| pydantic-13890 | | | |
| gh-cli-12596 | | | |
| ruff-26775 | | | |
| vue-15347 | | | |

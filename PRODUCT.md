# Product

<!-- impeccable:product-schema 1 -->

## Platform

web

## Stack

The product is a TypeScript (ESM, Node >= 20) GitHub Action and self-hosted GitHub App. Its public landing page is an Astro static site with Tailwind CSS v4, modelled on the stack of the Laman marketing site (`../fiscal-sb/apps/www`). It lives in `site/` in this repository and deploys to GitHub Pages (`mof-malaysia.github.io/fiscal-cr`). Confirmed by the owner, 5 Nov 2026.

## Users

Engineering teams anywhere who review pull requests on GitHub. The person evaluating FiscalCR is usually a tech lead, staff engineer or platform/DevEx engineer deciding whether to add automated AI review to their repositories; the people living with it are the developers whose PRs it comments on. They read code all day, distrust noisy bots, and care about cost, which model sees their code, and whether the review is worth reading.

## Product Purpose

FiscalCR posts an AI code review on every pull request: a Check Run, a PR review with a summary, and inline comments on the lines that matter. It exists so a team can get useful first-pass review from the LLM provider it already trusts, configured in one YAML file, without a SaaS vendor in the middle. Success: a team adds one workflow file, the next PR gets a review worth reading, and fixed findings resolve themselves as the PR moves.

## Positioning

- **Model-agnostic, bring your own key.** Anthropic (native Messages API), OpenAI, Kimi, OpenRouter, or any OpenAI-compatible endpoint, including a self-hosted one. Keyless Anthropic auth via GitHub OIDC (Workload Identity Federation) is supported.
- **No service in the middle.** Runs as a GitHub Action in the team's own CI, or as a self-hosted GitHub App. Code goes only to the provider the team configures.
- **Open source, MIT.** Built and maintained by the Ministry of Finance Malaysia team (`mof-malaysia/fiscal-cr`).
- **Release-pinned models.** Each FiscalCR release pins the models its prompts and review harness were tuned against, so reviews stay consistent with the version a team runs.

## Operating Context

- Setup is a GitHub workflow file plus an `LLM_API_KEY` secret (or OIDC federation variables), optionally a `.fiscalcr-review.yml` in the repo root.
- Triggers: PR opened, synchronized, reopened, ready for review, review requested; in App mode also `@fiscalcr review` and `@fiscalcr help` comments.
- Output lives in GitHub: a Check Run (can fail the check on `critical` or `warning`), a summary comment, inline review comments, check-run annotations for overflow.

## Capabilities and Constraints

- Review pipeline: small PRs take a single fast-path call; larger PRs run multi-pass (intent and grouping, parallel per-group reviews, synthesis). Findings below a confidence threshold are dropped.
- Review aspects: bugs, security, performance, style, best practices, optional documentation and testing; severity floor and annotation cap configurable.
- Sticky comment mode (default): one updated summary plus incremental reviews; dedupe of repeated findings; replies on and resolution of threads for fixed findings. Legacy mode stacks a full review per run.
- Incremental review of only files changed since the last reviewed commit.
- Repo-level custom rules (name, description, severity, file pattern) and prompt additions (`systemAppend`, `reviewFocus`).
- Optional visualizations (Mermaid flowchart, sequence diagram, or change table) on eligible full reviews.
- Review languages: `en`, `zh-TW`, `zh-CN`, `ja`, `ko`.
- Prompt caching per provider; metrics-only token telemetry (off by default, no external service); Action outputs include tokens used and estimated cost.
- Base-revision routing: `provider` and `base_url` come from the trusted base SHA so a PR cannot redirect requests carrying the API key.
- Local evaluation harness with an 11-case gold benchmark suite (`docs/llm-evaluation.md`).
- Undecided: custom domain; hosted demo; versioned docs site.

## Brand Commitments

- Name: FiscalCR (written as one word, CR in caps). App command handle `@fiscalcr`.
- English only for the site.
- FTDS design family (owner, 5 Nov 2026): FTDS tokens and Astro components, Inter, as on Laman's marketing site (`../fiscal-sb/apps/www`). FiscalCR gets its own expression inside FTDS, as Laman does: its own mark and its own signature moment, the Review Field (owner's choice, 5 Nov 2026).

## Evidence on Hand

- README, action inputs/outputs, config reference, provider-model table (`README.md`).
- Evaluation harness description (`docs/llm-evaluation.md`); no published benchmark scores.
- No logo, no screenshots, no testimonials, no user counts, no star counts worth citing (repo is new and public). None of these may be invented; demonstration reviews on the site are labelled as examples.

## Product Principles

1. **Your model, your CI, your code.** Never imply FiscalCR hosts, stores or sees code.
2. **Signal over noise.** Every claim about review quality must trace to a real mechanism (confidence threshold, dedupe, resolve-on-fix, caps).
3. **Configuration is the interface.** Show the YAML; developers trust what they can read.
4. **Honest about what it is.** Open source, young, MIT; no fabricated social proof or benchmarks.

# Roadmap

Owned by Irfan. `/pm` reads this file and only proposes changes to it.

## Now (this quarter, in priority order)

1. TODO: goal, and what "done" looks like

## Next

- **Project memory: FiscalCR remembers what the team decided, and why.** The next major upgrade, not refined yet: the plan will be worked out with Irfan on Monday 16 November 2026. Taken from the 10 November 2026 design conversation:
  - **The idea.** Each PR is checked for what the author says changed against what the code actually changes. Any change nobody mentioned, if it matters, gets a short question, and a person fixes it or accepts it with a reason. Accepted reasons become decision records ("retries are OK because the provider blocks duplicate charges"). Later PRs that touch the same code bring the record back and ask whether it still holds.
  - **What it remembers.** Only decisions and the assumptions behind them, never a summary of the code. Each record names the files or functions it depends on, who accepted it, and on which merged PR.
  - **Keeping it small.** A high bar to get in, one record per topic that is updated rather than added to, and records retire when their code is deleted, when a later PR contradicts them, or when a test now enforces them. Starting limits, to tune: about 200 characters per reason, 200 active records per repo, 5 per PR.
  - **Trust.** Only a person's answer on a merged PR creates a record, never the model or a PR description. FiscalCR reads records from the trusted base only, and each must link to its PR so tampering can be checked.
  - **Where it lives (open).** Leaning towards a dedicated `fiscalcr/memory` branch: git history, no FiscalCR server, and no bot PR after each merge. The alternatives are a file on `main` (`.fiscalcr/decisions.yml`), a separate memory repo, or an optional database for large App setups. Keep the PR answers as the source of truth, so the store can be rebuilt or swapped later.
  - **Open questions.** Bot write access (the Action's token is read-only today, and protected branches may block it), the Action no longer being a one-file install (it needs a second workflow on merge), and the two ways it could fail: missing a change while looking thorough, and people clicking "accept" without thinking.
  - **Test first.** Run the claimed-versus-actual check on about 30 PRs that were later reverted or hotfixed and 30 healthy ones, using the eval harness. Build it only if it finds the bad PRs' cause far more often.

## Not doing

- TODO: things we've decided against, so nobody proposes them again

## Known gaps

- None recorded yet.

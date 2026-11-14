# Roadmap

Owned by Irfan. `/pm` reads this file and only proposes changes to it.

## Now (this quarter, in priority order)

1. TODO: goal, and what "done" looks like

## Next

- TODO

## Not doing

- TODO: things we've decided against, so nobody proposes them again

## Known gaps

- Nothing runs `pnpm lint` or `pnpm test` on a PR: there are no git hooks, and `ci.yml` only runs FiscalCR's own review. Type check and tests run only in `release.yml`, after a release is published, so a broken `main` is found at release time.
- `pnpm --dir site check-types` runs nowhere; `site.yml` only builds, and only after a merge to `main`.
- The root `package.json` has no `packageManager` pin; `release.yml` uses pnpm 9 while `site/` pins pnpm 12.16.1.

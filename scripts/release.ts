/**
 * The release a setup guide pins, and the workflow it tells teams to commit.
 * Shared by `scripts/generate-llms.ts` and the landing page (`site/`), so
 * llms.txt and the page's Copy buttons always agree. Node built-ins only: the
 * site imports this file directly.
 */
import { execFileSync } from 'node:child_process';

/** The newest stable release tag (vX.Y.Z); betas and the floating major tag are skipped. */
export function latestRelease(): string {
  const tags = execFileSync('git', ['tag', '--list', 'v*', '--sort=-v:refname'], { encoding: 'utf8' })
    .split('\n')
    .map((tag) => tag.trim())
    .filter((tag) => /^v\d+\.\d+\.\d+$/.test(tag));
  if (!tags[0]) {
    throw new Error('No stable release tag (vX.Y.Z) found. Run `git fetch --tags` first.');
  }
  return tags[0];
}

/** The quick-start workflow, pinned to `version`. */
export function workflowYaml(version: string): string {
  return `# .github/workflows/fiscalcr-review.yml
name: FiscalCR Review

on:
  pull_request:
    types: [opened, synchronize, reopened, ready_for_review, review_requested]

permissions:
  contents: read
  pull-requests: write
  checks: write

# Serializes runs for one PR so two reviews never race the same state.
concurrency:
  group: fiscalcr-\${{ github.event.pull_request.number }}
  cancel-in-progress: false

jobs:
  review:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: mof-malaysia/fiscal-cr@${version}
        with:
          api_key: \${{ secrets.LLM_API_KEY }}
          provider: anthropic
`;
}

// What the page shares: addresses with the base path, the links, the classes
// sections share, and the workflow file the Copy buttons put on the clipboard.
import { withBase } from "./base-path.mjs";

export const GITHUB_URL = "https://github.com/mof-malaysia/fiscal-cr";
export const README_URL = `${GITHUB_URL}#readme`;
export const ISSUES_URL = `${GITHUB_URL}/issues`;
export const CONFIG_URL = `${GITHUB_URL}#configuration`;
export const APP_URL = `${GITHUB_URL}#self-hosted-github-app`;

/** A root-relative address ("/logo.svg") with the site's base in front. */
export const url = (path: string) => withBase(import.meta.env.BASE_URL, path);

/** The page column every section sits in: FTDS's wide column, with the navbar's gutter. */
export const pageColumn = "mx-auto w-full max-w-[1280px] px-4.5 md:px-6";

/** A section's h2. */
export const sectionTitle =
  "text-heading-sm md:text-heading-md font-semibold tracking-[-0.02em] text-balance";

export const navItems = [
  { label: "Reviews", href: "#reviews" },
  { label: "Models", href: "#models" },
  { label: "How it works", href: "#pipeline" },
  { label: "Configure", href: "#configure" },
  { label: "Install", href: "#install" },
];

/** The workflow from the README's quick start, as a team would commit it. */
export const WORKFLOW = `# .github/workflows/fiscalcr-review.yml
name: FiscalCR Review

on:
  pull_request:
    types: [opened, synchronize, reopened, ready_for_review, review_requested]

permissions:
  contents: read
  pull-requests: write
  checks: write

concurrency:
  group: fiscalcr-\${{ github.event.pull_request.number }}
  cancel-in-progress: false

jobs:
  review:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: mof-malaysia/fiscal-cr@v1.2.0
        with:
          api_key: \${{ secrets.LLM_API_KEY }}
          provider: anthropic
`;

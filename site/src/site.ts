// What the page shares: addresses with the base path, the links, the classes
// sections share, and the workflow file the Copy buttons put on the clipboard.
// Its version is read from the latest release tag at build time.
import { latestRelease, workflowYaml } from "../../scripts/release";

export const GITHUB_URL = "https://github.com/mof-malaysia/fiscal-cr";
export const README_URL = `${GITHUB_URL}#readme`;
export const ISSUES_URL = `${GITHUB_URL}/issues`;
export const CONFIG_URL = `${GITHUB_URL}#configuration`;
export const APP_URL = `${GITHUB_URL}#self-hosted-github-app`;

/** The release the workflow pins, e.g. "v1.2.0": the newest stable git tag. */
export const RELEASE = latestRelease();

const base = import.meta.env.BASE_URL.replace(/\/$/, "");

/** A root-relative address ("/logo.svg") with the site's base in front ("/fiscal-cr/logo.svg"). */
export const url = (path: string) => (path === "/" ? base || "/" : base + path);

/** A link-styled button on the primary field, where FTDS's filled primary button would vanish. */
export const fieldButton = {
  solid: "control-lg text-label-lg focus-ring inline-flex items-center gap-2 rounded-md font-medium transition-colors bg-bg-white text-txt-primary hover:bg-bg-primary-50",
  quiet: "control-lg text-label-lg focus-ring inline-flex items-center gap-2 rounded-md font-medium transition-colors text-txt-white bg-bg-white/12 hover:bg-bg-white/20",
};

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

/** The quick-start workflow, the same one llms.txt gives (scripts/release.ts). */
export const WORKFLOW = workflowYaml(RELEASE);

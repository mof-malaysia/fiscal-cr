// The newest stable FiscalCR release (vX.Y.Z), read from the repository's git
// tags at build time; betas and the floating major tag (v1) are skipped. The
// Pages workflow checks out with full history so the tags are there.
import { execFileSync } from "node:child_process";

export function latestRelease(): string {
  const tags = execFileSync("git", ["tag", "--list", "v*", "--sort=-v:refname"], { encoding: "utf8" })
    .split("\n")
    .map((tag) => tag.trim())
    .filter((tag) => /^v\d+\.\d+\.\d+$/.test(tag));
  if (!tags[0]) throw new Error("No stable release tag (vX.Y.Z) found. Run `git fetch --tags` first.");
  return tags[0];
}

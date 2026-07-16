import type { ChangedFile } from '../types/review.js';
import type { ReviewConfig } from '../config/schema.js';
import type { IntentResult } from './schemas.js';
import { estimateTokens } from '../utils/tokens.js';

export interface FileGroup {
  label: string;
  files: ChangedFile[];
  /** True when the group ships diffs only (no full file contents) to fit budget. */
  diffOnly: boolean;
}

const MIN_GROUP_TOKENS = 8_000;
const TEST_FILE_RE = /(\.(test|spec)\.[jt]sx?$)|(__tests__\/)|(_test\.\w+$)/;

function fileCost(file: ChangedFile, contents: Map<string, string>): number {
  const patchTokens = file.patch ? estimateTokens(file.patch) : 0;
  const content = contents.get(file.filename);
  return patchTokens + (content ? estimateTokens(content) : 0);
}

/** Strip test-suffix noise so `foo.test.ts` pairs with `foo.ts`. */
function subjectBasename(path: string): string {
  const base = path.split('/').pop() ?? path;
  return base.replace(/\.(test|spec)(?=\.[jt]sx?$)/, '').replace(/_test(?=\.\w+$)/, '');
}

function clusterKey(path: string): string {
  const segments = path.split('/');
  return segments.slice(0, Math.min(2, segments.length - 1)).join('/') || '.';
}

/**
 * Deterministically split changed files into review groups:
 * Pass 1 hints seed the clusters, directory structure covers the rest, test
 * files join their subject, and clusters are bin-packed to the token budget.
 */
export function groupFiles(
  files: ChangedFile[],
  contents: Map<string, string>,
  hints: IntentResult | null,
  config: ReviewConfig,
): FileGroup[] {
  const budget = config.pipeline.groupTokenBudget;
  const byName = new Map(files.map((f) => [f.filename, f]));
  const assigned = new Set<string>();
  const clusters: Array<{ label: string; files: ChangedFile[] }> = [];

  // 1. Seed clusters from Pass 1 hints (unknown paths dropped).
  for (const hint of hints?.groups ?? []) {
    const members = hint.files
      .filter((p) => byName.has(p) && !assigned.has(p))
      .map((p) => byName.get(p)!);
    if (members.length === 0) continue;
    members.forEach((f) => assigned.add(f.filename));
    clusters.push({ label: hint.label || clusterKey(members[0].filename), files: members });
  }

  // 2. Remaining files cluster by top path segments.
  const residualByDir = new Map<string, ChangedFile[]>();
  for (const file of files) {
    if (assigned.has(file.filename)) continue;
    const key = clusterKey(file.filename);
    residualByDir.get(key)?.push(file) ?? residualByDir.set(key, [file]);
  }
  for (const [key, members] of [...residualByDir.entries()].sort()) {
    clusters.push({ label: key, files: members });
  }

  // 3. Test files migrate to the cluster containing their subject.
  for (const cluster of clusters) {
    for (const file of [...cluster.files]) {
      if (!TEST_FILE_RE.test(file.filename)) continue;
      const subject = subjectBasename(file.filename);
      const home = clusters.find(
        (c) =>
          c !== cluster &&
          c.files.some(
            (f) => !TEST_FILE_RE.test(f.filename) && (f.filename.split('/').pop() ?? '') === subject,
          ),
      );
      if (home) {
        cluster.files = cluster.files.filter((f) => f !== file);
        home.files.push(file);
      }
    }
  }

  // 4. Split oversized clusters (first-fit-decreasing).
  let groups: Array<{ label: string; files: ChangedFile[]; cost: number }> = [];
  for (const cluster of clusters) {
    if (cluster.files.length === 0) continue;
    const total = cluster.files.reduce((sum, f) => sum + fileCost(f, contents), 0);
    if (total <= budget) {
      groups.push({ ...cluster, cost: total });
      continue;
    }
    const sorted = [...cluster.files].sort(
      (a, b) => fileCost(b, contents) - fileCost(a, contents),
    );
    const bins: Array<{ label: string; files: ChangedFile[]; cost: number }> = [];
    for (const file of sorted) {
      const cost = fileCost(file, contents);
      const bin = bins.find((b) => b.cost + cost <= budget);
      if (bin) {
        bin.files.push(file);
        bin.cost += cost;
      } else {
        bins.push({ label: `${cluster.label} (${bins.length + 1})`, files: [file], cost });
      }
    }
    groups.push(...bins);
  }

  // 5. Merge tiny groups into the previous group while under budget.
  const merged: typeof groups = [];
  for (const group of groups) {
    const prev = merged[merged.length - 1];
    if (
      prev &&
      (group.cost < MIN_GROUP_TOKENS || prev.cost < MIN_GROUP_TOKENS) &&
      prev.cost + group.cost <= budget
    ) {
      prev.files.push(...group.files);
      prev.cost += group.cost;
    } else {
      merged.push(group);
    }
  }
  groups = merged;

  // 6. Cap group count: overflow collapses into one diff-only group.
  groups.sort((a, b) => b.cost - a.cost);
  let overflow: FileGroup | null = null;
  if (groups.length > config.pipeline.maxGroups) {
    const spill = groups.splice(config.pipeline.maxGroups - 1);
    overflow = {
      label: 'remaining files (diff only)',
      files: spill.flatMap((g) => g.files),
      diffOnly: true,
    };
  }

  // 7. Deterministic output order for prefix-cache stability across pushes.
  const result: FileGroup[] = groups.map((g) => ({
    label: g.label,
    files: [...g.files].sort((a, b) => a.filename.localeCompare(b.filename)),
    diffOnly: false,
  }));
  if (overflow) {
    overflow.files.sort((a, b) => a.filename.localeCompare(b.filename));
    result.push(overflow);
  }
  result.sort((a, b) => (a.files[0]?.filename ?? '').localeCompare(b.files[0]?.filename ?? ''));
  return result;
}

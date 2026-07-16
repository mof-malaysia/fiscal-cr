import { readFile, stat } from 'node:fs/promises';
import { dirname, isAbsolute, join, normalize, sep } from 'node:path';
import { minimatch } from 'minimatch';
import type { ReviewConfig } from '../config/schema.js';
import type { FileGroup } from './grouper.js';
import { estimateTokens } from '../utils/tokens.js';
import { logger } from '../utils/logger.js';

const MAX_RELATED_PER_GROUP = 5;
const MAX_LINES_PER_FILE = 200;
const MAX_TOKENS_PER_FILE = 4_000;
const RESOLVE_EXTENSIONS = ['', '.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs'];

const IMPORT_RE =
  /(?:import|export)\s[^'"]*?from\s+['"]([^'"]+)['"]|require\(\s*['"]([^'"]+)['"]\s*\)|import\(\s*['"]([^'"]+)['"]\s*\)/g;

/** Extract relative import specifiers (./x, ../y) from JS/TS source. */
export function extractImportSpecs(content: string): string[] {
  const specs: string[] = [];
  for (const match of content.matchAll(IMPORT_RE)) {
    const spec = match[1] ?? match[2] ?? match[3];
    if (spec && (spec.startsWith('./') || spec.startsWith('../'))) {
      specs.push(spec);
    }
  }
  return specs;
}

async function resolveSpec(
  workspaceRoot: string,
  importerPath: string,
  spec: string,
): Promise<string | null> {
  // Strip a TS-style .js extension so './x.js' can resolve to 'x.ts'.
  const base = spec.replace(/\.js$/, '');
  const candidates: string[] = [];
  for (const ext of RESOLVE_EXTENSIONS) {
    candidates.push(join(dirname(importerPath), base + ext));
    candidates.push(join(dirname(importerPath), base, `index${ext || '.ts'}`));
  }
  // Also try the spec verbatim (covers './style.css'-like exact paths).
  candidates.push(join(dirname(importerPath), spec));

  for (const candidate of candidates) {
    const repoRelative = normalize(candidate);
    if (isAbsolute(repoRelative) || repoRelative.startsWith(`..${sep}`)) continue;
    const absolute = normalize(join(workspaceRoot, repoRelative));
    if (!absolute.startsWith(normalize(workspaceRoot) + sep)) continue;
    try {
      const info = await stat(absolute);
      if (info.isFile()) return repoRelative.split(sep).join('/');
    } catch {
      // try next candidate
    }
  }
  return null;
}

function truncateContent(content: string): string {
  const lines = content.split('\n');
  let text =
    lines.length > MAX_LINES_PER_FILE
      ? `${lines.slice(0, MAX_LINES_PER_FILE).join('\n')}\n// [truncated related file — context only]`
      : content;
  if (estimateTokens(text) > MAX_TOKENS_PER_FILE) {
    text = `${text.slice(0, MAX_TOKENS_PER_FILE * 4)}\n// [truncated related file — context only]`;
  }
  return text;
}

/**
 * For a review group, collect unchanged files imported by the group's changed
 * files (Action mode only — requires a local checkout). Related files are
 * ranked by how many changed files reference them.
 */
export async function collectRelatedContext(
  group: FileGroup,
  fileContents: Map<string, string>,
  workspaceRoot: string,
  config: ReviewConfig,
  changedPaths: Set<string>,
): Promise<Map<string, string>> {
  const related = new Map<string, string>();
  if (config.pipeline.relatedContextBudget <= 0 || group.diffOnly) return related;

  const referenceCounts = new Map<string, number>();
  for (const file of group.files) {
    const content = fileContents.get(file.filename);
    if (!content) continue;
    for (const spec of extractImportSpecs(content)) {
      const resolved = await resolveSpec(workspaceRoot, file.filename, spec);
      if (!resolved) continue;
      if (changedPaths.has(resolved)) continue; // already in the PR
      if (config.files.exclude.some((p) => minimatch(resolved, p, { dot: true }))) continue;
      referenceCounts.set(resolved, (referenceCounts.get(resolved) ?? 0) + 1);
    }
  }

  const ranked = [...referenceCounts.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, MAX_RELATED_PER_GROUP);

  let budget = config.pipeline.relatedContextBudget;
  for (const [path] of ranked) {
    try {
      const raw = await readFile(join(workspaceRoot, path), 'utf-8');
      if (raw.includes('\u0000')) continue;
      const truncated = truncateContent(raw);
      const tokens = estimateTokens(truncated);
      if (tokens > budget) continue;
      related.set(path, truncated);
      budget -= tokens;
    } catch (err) {
      logger.debug({ path, err }, 'Could not read related file');
    }
  }

  return related;
}

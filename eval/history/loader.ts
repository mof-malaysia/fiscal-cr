import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { commentableLines } from '../../src/review/diff-analyzer.js';
import type { PullRequestContext } from '../../src/types/review.js';
import type { BenchmarkCase } from '../quality.js';
import {
  causeOf,
  readManifest,
  type HistoryCase,
  type HistoryManifest,
} from './manifest.js';

/**
 * Loader for the history suite: reads cases materialised by `materialize.ts`
 * from the gitignored cache, synchronously and without network, so
 * `eval/plan.ts` stays sync and the dry run stays free.
 *
 * What the review sees is the PR as it was at merge time: title, body and
 * diff. No comments, reviews, later commits, or links to the revert or fix.
 */

const REPO_ROOT = fileURLToPath(new URL('../../', import.meta.url));
export const HISTORY_CACHE_DIR = path.join(REPO_ROOT, '.cache', 'eval-history');
/** Bump when the cached shape changes; older entries are refetched. */
export const CACHE_FORMAT = 1;

export interface CachedContext {
  cacheFormat: number;
  id: string;
  baseSha: string;
  headSha: string;
  context: Omit<PullRequestContext, 'fileContents'> & { fileContents: Record<string, string> };
}

// ---------------------------------------------------------------------------
// Leak check

/**
 * Returns why a context leaks post-merge data, or null when it is clean. A
 * context leaks when its title or body names the revert or fix: its URL, its
 * `#number` / `owner/repo#number` reference, or its commit SHA.
 */
export function findPostMergeLeak(c: HistoryCase, ctx: Pick<PullRequestContext, 'title' | 'body'>): string | null {
  if (c.kind !== 'bad') return null;
  const text = `${ctx.title}\n${ctx.body}`;
  const lower = text.toLowerCase();
  if (lower.includes(c.evidence.url.toLowerCase())) return `mentions ${c.evidence.url}`;
  const n = c.evidence.pr;
  if (n !== undefined) {
    const ref = new RegExp(`(^|[^\\w/])(${escapeRe(c.repo)})?#${n}(?!\\d)`, 'i');
    if (ref.test(text)) return `references #${n}`;
    if (lower.includes(`/${c.repo.toLowerCase()}/pull/${n}`)) return `links pull/${n}`;
  }
  const commit = /\/commit\/([0-9a-f]{7,40})$/.exec(c.evidence.url)?.[1];
  if (commit && lower.includes(commit.slice(0, 7))) return `mentions commit ${commit.slice(0, 7)}`;
  return null;
}

/**
 * Returns why a bad case's cause label cannot be matched against its
 * materialised context, or null when it can: every accepted path must be a
 * reviewed file with content, and every line range must lie inside the file
 * and touch a line the diff shows.
 */
export function findCauseProblem(c: HistoryCase, ctx: PullRequestContext): string | null {
  if (c.kind !== 'bad') return null;
  const files: { lines: Set<number>; length: number }[] = [];
  for (const p of c.cause.acceptedPaths) {
    const patch = ctx.changedFiles.find((f) => f.filename === p)?.patch;
    const content = ctx.fileContents.get(p);
    if (!patch || content === undefined) return `${p} is not a reviewed file in the context`;
    files.push({ lines: commentableLines(patch), length: content.split('\n').length });
  }
  for (const r of c.cause.acceptedLineRanges) {
    const shown = files.some(({ lines, length }) => {
      if (r.endLine > length) return false;
      for (let l = r.startLine; l <= r.endLine; l++) if (lines.has(l)) return true;
      return false;
    });
    if (!shown) return `lines ${r.startLine}-${r.endLine} are not in the diff of ${c.cause.acceptedPaths.join(', ')}`;
  }
  return null;
}

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// ---------------------------------------------------------------------------
// Cache I/O

export function cachePath(id: string, dir: string = HISTORY_CACHE_DIR): string {
  return path.join(dir, `${id}.json`);
}

function isFresh(cached: CachedContext, c: HistoryCase): boolean {
  return cached.cacheFormat === CACHE_FORMAT && cached.baseSha === c.baseSha && cached.headSha === c.headSha;
}

export function readCached(c: HistoryCase, dir: string = HISTORY_CACHE_DIR): CachedContext | null {
  const file = cachePath(c.id, dir);
  if (!existsSync(file)) return null;
  const cached = JSON.parse(readFileSync(file, 'utf8')) as CachedContext;
  return isFresh(cached, c) ? cached : null;
}

export function toContext(cached: CachedContext): PullRequestContext {
  return { ...cached.context, fileContents: new Map(Object.entries(cached.context.fileContents)) };
}

export function toBenchmarkCase(c: HistoryCase, context: PullRequestContext): BenchmarkCase {
  return {
    id: c.id,
    version: 1,
    label: `${c.repo}#${c.pr}`,
    tags: ['history', c.kind, c.language, ...c.tags],
    context,
    expectedIssues: causeOf(c),
  };
}

/**
 * Loads cases from the cache, synchronously. Throws when any selected case is
 * missing or stale, naming the fetch command; never touches the network.
 */
export function loadHistoryCases(
  ids?: readonly string[],
  options: { manifest?: HistoryManifest; cacheDir?: string } = {},
): BenchmarkCase[] {
  const manifest = options.manifest ?? readManifest();
  const byId = new Map(manifest.cases.map((c) => [c.id, c]));
  const selected = (ids ?? manifest.cases.map((c) => c.id)).map((id) => {
    const c = byId.get(id);
    if (!c) throw new Error(`Unknown history case id "${id}"`);
    return c;
  });
  const missing: string[] = [];
  const cases: BenchmarkCase[] = [];
  for (const c of selected) {
    const cached = readCached(c, options.cacheDir);
    if (!cached) {
      missing.push(c.id);
      continue;
    }
    const context = toContext(cached);
    const leak = findPostMergeLeak(c, context);
    if (leak) throw new Error(`History case ${c.id} leaks post-merge data: its PR text ${leak}`);
    const causeProblem = findCauseProblem(c, context);
    if (causeProblem) throw new Error(`History case ${c.id} has a cause label the matcher cannot hit: ${causeProblem}`);
    cases.push(toBenchmarkCase(c, context));
  }
  if (missing.length > 0) {
    throw new Error(
      `${missing.length} history case(s) are not in ${path.relative(REPO_ROOT, options.cacheDir ?? HISTORY_CACHE_DIR)}/ ` +
        `(${missing.slice(0, 5).join(', ')}${missing.length > 5 ? ', …' : ''}). ` +
        'Fetch them first with `make eval-history-fetch` (needs a read-only GitHub token; no provider calls).',
    );
  }
  return cases;
}

import { describe, expect, it } from 'vitest';
import {
  EVAL_CASES,
  ISSUE_CATEGORIES,
  ISSUE_SEVERITIES,
  SMOKE_CASE_IDS,
  SUITE_ID,
  SUITE_VERSION,
  estimateContextTokens,
  getCaseById,
  getCaseIds,
  getCases,
  getFullCaseIds,
  getSmokeCaseIds,
  isCleanCase,
  type BenchmarkCase,
} from '../cases.js';
import { evaluateRunQuality } from '../quality.js';
import { lineToDiffPosition } from '../../src/review/diff-analyzer.js';
import { DEFAULT_CONFIG } from '../../src/config/defaults.js';

const REQUIRED_TAGS: Record<string, number> = {
  clean: 2,
  'local-correctness': 2,
  'cross-file': 2,
  security: 1,
  concurrency: 1,
  performance: 1,
  mixed: 1,
};

/** Words that would reveal defects if present in a neutral PR title. */
const REVEALING_TITLE_WORDS = [
  'fix',
  'bug',
  'crash',
  'vulnerab',
  'inject',
  'leak',
  'race',
  'mismatch',
  'off-by-one',
  'undefined',
  'fall-through',
  'quadratic',
  'n+1',
  'perf',
];

/** Secret-shaped values that must never appear in fixture content. */
const CREDENTIAL_PATTERNS: RegExp[] = [
  /\bghp_[A-Za-z0-9]{20,}/,
  /\bgithub_pat_[A-Za-z0-9_]{20,}/,
  /\bsk-[A-Za-z0-9]{20,}/,
  /\bxox[baprs]-[A-Za-z0-9-]{10,}/,
  /\bAKIA[0-9A-Z]{16}/,
  /\bAIza[0-9A-Za-z_-]{20,}/,
  /\bglpat-[A-Za-z0-9_-]{20,}/,
  /-----BEGIN [A-Z ]*PRIVATE KEY-----/,
  /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\./,
];

function allFixtureText(cases: BenchmarkCase[]): string {
  const parts: string[] = [SUITE_ID];
  for (const c of cases) {
    parts.push(c.id, c.label, ...c.tags);
    if (c.knownDistractors) parts.push(...c.knownDistractors);
    const ctx = c.context;
    parts.push(ctx.body, ctx.diff);
    for (const content of ctx.fileContents.values()) parts.push(content);
    for (const issue of c.expectedIssues) {
      parts.push(
        issue.issueId,
        ...issue.acceptedPaths,
        issue.rationale,
        issue.minSeverity,
        issue.maxSeverity,
      );
    }
  }
  return parts.join('\n');
}

describe('eval-cases gold fixture suite', () => {
  it('exports suite metadata and contains exactly 10 deterministic cases with 20 unique gold issues', () => {
    expect(SUITE_ID).toBe('fiscalcr-local-fast-path');
    expect(SUITE_VERSION).toBeGreaterThan(0);
    expect(EVAL_CASES).toHaveLength(10);
    const ids = EVAL_CASES.map((c) => c.id);
    expect(new Set(ids).size).toBe(ids.length);
    const issueIds = EVAL_CASES.flatMap((c) => c.expectedIssues.map((i) => i.issueId));
    expect(issueIds).toHaveLength(20);
    expect(new Set(issueIds).size).toBe(issueIds.length);
    for (const id of [...ids, ...issueIds]) {
      expect(id).toMatch(/^[a-z0-9][a-z0-9-]*$/);
    }
  });

  it('satisfies the canonical matcher contract (eval/quality.ts)', () => {
    for (const c of EVAL_CASES) {
      expect(c.id.length).toBeGreaterThan(0);
      expect(c.version).toBeGreaterThan(0);
      expect(c.label.length).toBeGreaterThan(0);
      expect(c.context).toBeDefined();
      const report = evaluateRunQuality({
        case: c,
        generatedFindings: [],
        retainedFindings: [],
        outputTokens: 1,
      });
      expect(report.postGate.goldIssues).toBe(c.expectedIssues.length);
      // Every fixture issue uses collapsed severity bounds, so the exact
      // severity equals the single bound (matches the matcher's 'exact' grade).
      for (const issue of c.expectedIssues) {
        expect(issue.minSeverity).toBe(issue.maxSeverity);
        expect(issue.expectedSeverity).toBe(issue.minSeverity);
      }
    }
  });

  it('contains exactly two clean cases, closed-world (zero expected issues)', () => {
    const clean = EVAL_CASES.filter((c) => isCleanCase(c));
    expect(clean).toHaveLength(2);
    for (const c of clean) {
      expect(c.expectedIssues).toHaveLength(0);
      expect(isCleanCase(c)).toBe(c.expectedIssues.length === 0);
    }
    for (const c of EVAL_CASES.filter((c) => !isCleanCase(c))) {
      expect(c.expectedIssues.length).toBeGreaterThan(0);
      expect(isCleanCase(c)).toBe(false);
    }
  });

  it('covers every required taxonomy tag with the required minimum count', () => {
    for (const [tag, min] of Object.entries(REQUIRED_TAGS)) {
      const count = EVAL_CASES.filter((c) => c.tags.includes(tag)).length;
      expect(count, `tag "${tag}"`).toBeGreaterThanOrEqual(min);
    }
  });

  it('validates issue shape: severity/category/range/rationale, changed-file refs, commentable lines', () => {
    const sevRank = new Map(ISSUE_SEVERITIES.map((s, i) => [s, i]));
    for (const c of EVAL_CASES) {
      const ctx = c.context;
      const filenames = new Set(ctx.changedFiles.map((f) => f.filename));
      const patches = new Map(ctx.changedFiles.map((f) => [f.filename, f.patch ?? '']));
      for (const issue of c.expectedIssues) {
        expect(issue.acceptedPaths.length).toBeGreaterThan(0);
        expect(issue.acceptedCategories.length).toBeGreaterThan(0);
        expect(issue.acceptedLineRanges.length).toBeGreaterThan(0);
        expect(issue.rationale.trim().length).toBeGreaterThanOrEqual(10);
        expect(sevRank.has(issue.minSeverity)).toBe(true);
        expect(sevRank.has(issue.maxSeverity)).toBe(true);
        expect(sevRank.get(issue.minSeverity)!).toBeLessThanOrEqual(
          sevRank.get(issue.maxSeverity)!,
        );
        for (const cat of issue.acceptedCategories) {
          expect(ISSUE_CATEGORIES).toContain(cat);
        }
        for (const path of issue.acceptedPaths) {
          expect(filenames.has(path), `${c.id}/${issue.issueId}: ${path}`).toBe(true);
          const patch = patches.get(path);
          expect(patch, `${c.id}/${issue.issueId}: no patch for ${path}`).toBeDefined();
          for (const range of issue.acceptedLineRanges) {
            expect(range.startLine).toBeGreaterThanOrEqual(1);
            expect(range.endLine).toBeGreaterThanOrEqual(range.startLine);
            for (let line = range.startLine; line <= range.endLine; line++) {
              const pos = lineToDiffPosition(patch as string, line);
              expect(
                pos.found,
                `${c.id}/${issue.issueId}: line ${line} in ${path} is not commentable`,
              ).toBe(true);
            }
          }
        }
      }
    }
  });

  it('keeps every case under the production fast-path threshold with valid changed files', () => {
    const threshold = DEFAULT_CONFIG.pipeline.fastPathThreshold;
    expect(threshold).toBeGreaterThan(0);
    for (const c of EVAL_CASES) {
      expect(estimateContextTokens(c.context), `${c.id} token estimate`).toBeLessThan(threshold);
      const ctx = c.context;
      expect(ctx.changedFiles.length).toBeGreaterThanOrEqual(1);
      expect(ctx.changedFiles.length).toBeLessThanOrEqual(5);
      for (const f of ctx.changedFiles) {
        expect(['added', 'modified']).toContain(f.status);
        expect(f.additions).toBeGreaterThan(0);
        expect(f.deletions).toBeGreaterThanOrEqual(0);
      }
    }
  });

  it('exposes a deterministic, internally consistent context per case', () => {
    for (const c of EVAL_CASES) {
      const ctx = c.context;
      expect(ctx.changedFiles.length).toBeGreaterThan(0);
      expect(ctx.diff.length).toBeGreaterThan(0);
      // fileContents covers exactly the changed files.
      expect([...ctx.fileContents.keys()].sort()).toEqual(
        ctx.changedFiles.map((f) => f.filename).sort(),
      );
      // The diff embeds every changed-file patch.
      for (const f of ctx.changedFiles) {
        expect(ctx.diff).toContain(f.patch ?? '');
      }
      // The canonical context is a stable object (identical across access).
      expect(c.context).toBe(ctx);
    }
  });

  it('uses neutral PR labels and contains no credential-like content', () => {
    const text = allFixtureText(EVAL_CASES);
    for (const c of EVAL_CASES) {
      const label = c.label.toLowerCase();
      for (const word of REVEALING_TITLE_WORDS) {
        expect(label, `${c.id} label "${c.label}"`).not.toContain(word);
      }
      expect(c.label.length).toBeGreaterThan(0);
      expect(c.context.body.length).toBeGreaterThan(0);
    }
    for (const re of CREDENTIAL_PATTERNS) {
      expect(re.test(text), `credential-like content matched ${re}`).toBe(false);
    }
  });
});

describe('eval-cases selection helpers', () => {
  it('smoke set is exactly 3 representative cases and a subset of the full set', () => {
    expect(SMOKE_CASE_IDS).toHaveLength(3);
    expect(getSmokeCaseIds()).toEqual(SMOKE_CASE_IDS);
    const full = getFullCaseIds();
    expect(full).toHaveLength(10);
    expect(full).toEqual(EVAL_CASES.map((c) => c.id));
    for (const id of SMOKE_CASE_IDS) {
      expect(full).toContain(id);
    }
    const smokeTags = new Set(
      SMOKE_CASE_IDS.flatMap((id) => getCaseById(id).tags),
    );
    expect(smokeTags.has('clean')).toBe(true);
    expect(smokeTags.has('local-correctness')).toBe(true);
    expect(['security', 'mixed', 'cross-file'].some((t) => smokeTags.has(t))).toBe(true);
  });

  it('resolves exact comma-separated selections and throws on empty/unknown', () => {
    expect(getCaseIds('clean-01, clean-02')).toEqual(['clean-01', 'clean-02']);
    expect(getCaseIds('mixed-01')).toEqual(['mixed-01']);
    expect(getCases(['clean-01', 'security-01']).map((c) => c.id)).toEqual([
      'clean-01',
      'security-01',
    ]);
    expect(() => getCaseIds('')).toThrow(/no eval case ids/i);
    expect(() => getCaseIds('   ')).toThrow(/no eval case ids/i);
    expect(() => getCaseIds('clean-01, nope-99')).toThrow(/unknown eval case id\(s\): nope-99/i);
    expect(() => getCaseIds('nope-99')).toThrow(/nope-99/);
    expect(() => getCaseById('nope-99')).toThrow(/nope-99/);
  });
});

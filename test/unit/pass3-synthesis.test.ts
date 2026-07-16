import { describe, expect, it, vi } from 'vitest';
import {
  countBySeverity,
  deterministicScore,
  synthesize,
  validateAndRankFindings,
} from '../../src/pipeline/pass3-synthesis.js';
import { UsageTracker } from '../../src/pipeline/usage.js';
import { DEFAULT_CONFIG } from '../../src/config/defaults.js';
import type { ReviewConfig } from '../../src/config/schema.js';
import type {
  ChangedFile,
  PullRequestContext,
  ReviewAnnotation,
} from '../../src/types/review.js';
import type { GroupReviewOutcome } from '../../src/pipeline/pass2-review.js';

// Patch where new-file lines 1-3 exist in the diff.
const PATCH = '@@ -1,2 +1,3 @@\n line one\n+line two\n+line three';

function changedFile(filename: string): ChangedFile {
  return { filename, status: 'modified', additions: 2, deletions: 0, patch: PATCH };
}

function finding(overrides: Partial<ReviewAnnotation>): ReviewAnnotation {
  return {
    path: 'src/a.ts',
    startLine: 2,
    endLine: 2,
    severity: 'warning',
    category: 'bug',
    title: 'issue',
    body: 'body',
    confidence: 0.9,
    ...overrides,
  };
}

function cfg(overrides: Partial<ReviewConfig> = {}): ReviewConfig {
  return { ...DEFAULT_CONFIG, ...overrides };
}

describe('validateAndRankFindings', () => {
  const files = [changedFile('src/a.ts')];

  it('drops findings on lines not present in the diff', () => {
    const kept = validateAndRankFindings(
      [finding({ endLine: 2, startLine: 2 }), finding({ startLine: 99, endLine: 99, title: 'ghost' })],
      files,
      cfg(),
    );
    expect(kept).toHaveLength(1);
    expect(kept[0].title).toBe('issue');
  });

  it('drops findings for unknown files', () => {
    const kept = validateAndRankFindings([finding({ path: 'nope.ts' })], files, cfg());
    expect(kept).toHaveLength(0);
  });

  it('filters by confidence but keeps low-confidence criticals flagged', () => {
    const kept = validateAndRankFindings(
      [
        finding({ confidence: 0.3, title: 'weak warning' }),
        finding({ confidence: 0.5, severity: 'critical', title: 'weak critical', startLine: 3, endLine: 3, category: 'security' }),
        finding({ confidence: 0.3, severity: 'critical', title: 'too weak critical', category: 'other' }),
      ],
      files,
      cfg(),
    );
    expect(kept.map((f) => f.title)).toEqual(['weak critical']);
    expect(kept[0].body).toContain('low confidence');
  });

  it('dedupes overlapping same-category findings, keeping the stronger one', () => {
    const kept = validateAndRankFindings(
      [
        finding({ severity: 'warning', confidence: 0.7, title: 'weaker' }),
        finding({ severity: 'critical', confidence: 0.9, title: 'stronger' }),
      ],
      files,
      cfg(),
    );
    expect(kept).toHaveLength(1);
    expect(kept[0].title).toBe('stronger');
  });

  it('applies minSeverity and maxAnnotations after ranking', () => {
    const config = cfg({
      review: { ...DEFAULT_CONFIG.review, minSeverity: 'warning', maxAnnotations: 1 },
    });
    const kept = validateAndRankFindings(
      [
        finding({ severity: 'suggestion', title: 'sugg', startLine: 1, endLine: 1 }),
        finding({ severity: 'warning', title: 'warn', startLine: 2, endLine: 2 }),
        finding({ severity: 'critical', title: 'crit', startLine: 3, endLine: 3, category: 'security' }),
      ],
      files,
      config,
    );
    expect(kept).toHaveLength(1);
    expect(kept[0].title).toBe('crit');
  });
});

describe('deterministicScore', () => {
  it('penalizes by severity and clamps', () => {
    expect(deterministicScore({ critical: 0, warning: 0, suggestion: 0, nitpick: 5 })).toBe(100);
    expect(deterministicScore({ critical: 1, warning: 2, suggestion: 3, nitpick: 0 })).toBe(72);
    expect(deterministicScore({ critical: 10, warning: 0, suggestion: 0, nitpick: 0 })).toBe(0);
  });
});

function ctx(files: ChangedFile[]): PullRequestContext {
  return {
    owner: 'o', repo: 'r', pullNumber: 1, baseSha: 'b', headSha: 'h',
    title: 'Test PR', body: '', diff: '', changedFiles: files, fileContents: new Map(),
  };
}

function outcome(label: string, findings: ReviewAnnotation[], failed = false): GroupReviewOutcome {
  return {
    group: { label, files: [], diffOnly: false },
    summary: `${label} summary`,
    findings,
    failed,
  };
}

describe('synthesize', () => {
  it('skips the LLM call for single-group runs', async () => {
    const llm = { chatCompletion: vi.fn() };
    const result = await synthesize(
      llm,
      { ctx: ctx([changedFile('src/a.ts')]), intent: null, outcomes: [outcome('only', [finding({})])], findings: [finding({})] },
      cfg(),
      new UsageTracker(),
    );
    expect(llm.chatCompletion).not.toHaveBeenCalled();
    expect(result.summary).toContain('only summary');
    expect(result.annotations).toHaveLength(1);
  });

  it('applies LLM pruning but never drops criticals', async () => {
    const critical = finding({ severity: 'critical', title: 'crit', category: 'security', startLine: 3, endLine: 3 });
    const dupe = finding({ title: 'dupe', startLine: 1, endLine: 1, category: 'style' });
    const falsePositive = finding({ title: 'fp', startLine: 2, endLine: 2 });
    const findings = [critical, dupe, falsePositive];
    // ids follow array order: f1=critical, f2=dupe, f3=falsePositive
    const llm = {
      chatCompletion: vi.fn(async () => ({
        content: JSON.stringify({
          summary: 'Synthesized summary',
          score: 77,
          walkthrough: [{ path: 'src/a.ts', summary: 'w' }],
          nearDuplicates: [['f3', 'f2']],
          likelyFalsePositives: ['f1'],
        }),
        usage: { input: 10, output: 5, cached: 0 },
      })),
    };
    const result = await synthesize(
      llm,
      {
        ctx: ctx([changedFile('src/a.ts')]),
        intent: null,
        outcomes: [outcome('a', []), outcome('b', [])],
        findings,
      },
      cfg(),
      new UsageTracker(),
    );
    expect(result.summary).toBe('Synthesized summary');
    expect(result.score).toBe(77);
    // f2 dropped as near-duplicate of f3; f1 (critical) kept despite FP flag
    expect(result.annotations.map((f) => f.title).sort()).toEqual(['crit', 'fp']);
    expect(result.walkthrough).toEqual([{ path: 'src/a.ts', summary: 'w' }]);
  });

  it('falls back deterministically when the synthesis call fails', async () => {
    const llm = {
      chatCompletion: vi.fn(async () => {
        throw new Error('LLM down');
      }),
    };
    const findings = [finding({})];
    const result = await synthesize(
      llm,
      {
        ctx: ctx([changedFile('src/a.ts')]),
        intent: { intent: 'The intent', walkthrough: [{ path: 'src/a.ts', summary: 'w' }], groups: [], riskHotspots: [] },
        outcomes: [outcome('a', []), outcome('b', [], true)],
        findings,
      },
      cfg(),
      new UsageTracker(),
    );
    expect(result.summary).toContain('The intent');
    expect(result.summary).toContain('could not be fully reviewed');
    expect(result.score).toBe(deterministicScore(countBySeverity(findings)));
    expect(result.walkthrough).toEqual([{ path: 'src/a.ts', summary: 'w' }]);
    expect(result.annotations).toEqual(findings);
  });
});

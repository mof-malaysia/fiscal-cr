import { describe, expect, it, vi } from 'vitest';
import {
  EMPTY_COUNTS,
  appendFingerprints,
  appendRun,
  applyManualThreadResolution,
  loadReviewState,
  migrateLegacyState,
  parseStateMarker,
  reconcileFindingInventory,
  renderStateMarker,
  replaceStateMarker,
  renderStickyComment,
  saveStickyComment,
  type ReviewState,
} from '../../src/github/review-state.js';
import type { ReviewResult } from '../../src/types/review.js';

function state(overrides: Partial<ReviewState> = {}): ReviewState {
  return {
    v: 2,
    lastReviewedSha: 'abc1234def567890',
    baseSha: 'base000',
    blockingReviewId: 42,
    findings: [{
      fingerprint: 'aaaabbbbccccdddd',
      status: 'open',
      severity: 'critical',
      path: 'src/a.ts',
      startLine: 2,
      endLine: 2,
      title: 'Existing',
      threadId: 'thread-1',
      lastSeenSha: 'abc1234',
      transitions: [{ status: 'open', at: '2026-07-16', source: 'review' }],
    }],
    recentEvents: [],
    autoResolvedThreads: [],
    checkRunId: 9,
    checkRunHeadSha: 'abc1234def567890',
    runs: [{ sha: 'abc1234', at: '2026-07-16', scope: 'full', newFindings: 3, cost: '0.05' }],
    ...overrides,
  };
}

function annotation(overrides: Partial<ReviewResult['annotations'][number]> = {}) {
  return {
    path: 'src/a.ts',
    startLine: 2,
    endLine: 2,
    severity: 'critical' as const,
    category: 'bug' as const,
    title: 'Existing',
    body: 'body',
    ...overrides,
  };
}
function result(): ReviewResult {
  return {
    summary: 'All good',
    score: 90,
    annotations: [],
    findings: [],
    reviewedPaths: [],
    stats: { ...EMPTY_COUNTS },
    tokensUsed: { input: 100, output: 50, cached: 0 },
    intent: 'Adds a feature',
    walkthrough: [{ path: 'src/a.ts', summary: 'tweak' }],
  };
}

describe('state marker', () => {
  it('roundtrips through render + parse', () => {
    const s = state();
    expect(parseStateMarker(`some comment text\n${renderStateMarker(s)}`)).toEqual(s);
  });
  it('parses and replaces markers when JSON contains the marker suffix text', () => {
    const s = state({
      findings: [{ ...state().findings[0], title: 'Message contains --> delimiter text' }],
    });
    const body = `prefix\n${renderStateMarker(s)}\ntrailer`;
    expect(parseStateMarker(body)).toEqual(s);
    const replacement = replaceStateMarker(body, state({ lastReviewedSha: 'next-sha' }));
    expect(replacement).toContain('prefix');
    expect(replacement).toContain('trailer');
    expect(parseStateMarker(replacement)).toMatchObject({ v: 2, lastReviewedSha: 'next-sha' });
  });

  it('returns null for missing, corrupt, or unknown markers', () => {
    expect(parseStateMarker('no marker here')).toBeNull();
    expect(parseStateMarker('<!-- fiscalcr:state:v1 {not json} -->')).toBeNull();
    expect(parseStateMarker('<!-- fiscalcr:state:v1 {"v":99} -->')).toBeNull();
    expect(parseStateMarker('<!-- fiscalcr:state:v1 {"v":1,"lastReviewedSha":123} -->')).toBeNull();
  });

  it('fills defaults for missing optional fields', () => {
    const parsed = parseStateMarker(
      '<!-- fiscalcr:state:v1 {"v":1,"lastReviewedSha":"a","baseSha":"b","postedFingerprints":[],"openCounts":{}} -->',
    );
    expect(parsed).not.toBeNull();
    expect(parsed!.blockingReviewId).toBeNull();
    expect(parsed!.openCounts).toEqual(EMPTY_COUNTS);
    expect(parsed!.runs).toEqual([]);
  });
  it('migrates v1 without fabricating lifecycle history', () => {
    const legacy = parseStateMarker(
      '<!-- fiscalcr:state:v1 {"v":1,"lastReviewedSha":"a","baseSha":"b","postedFingerprints":["old"],"openCounts":{"critical":1}} -->',
    );
    expect(legacy?.v).toBe(1);
    const migrated = migrateLegacyState(legacy as Extract<typeof legacy, { v: 1 }>);
    expect(migrated).toMatchObject({
      v: 2,
      findings: [],
      checkRunId: null,
      migratedFromV1: true,
    });
  });
});

describe('FIFO caps', () => {
  it('caps fingerprints at 300, dropping the oldest', () => {
    const existing = Array.from({ length: 295 }, (_, i) => `fp${i}`);
    const merged = appendFingerprints(existing, ['new1', 'new2', 'new3', 'new4', 'new5', 'new6']);
    expect(merged).toHaveLength(300);
    expect(merged.at(-1)).toBe('new6');
    expect(merged).not.toContain('fp0');
    expect(merged).toContain('fp1');
  });


  it('does not duplicate already-known fingerprints', () => {
    expect(appendFingerprints(['a', 'b'], ['b', 'c'])).toEqual(['a', 'b', 'c']);
  });

  it('caps run history at 20', () => {
    let runs = state().runs;
    for (let i = 0; i < 25; i++) {
      runs = appendRun(runs, { sha: `sha${i}`, at: 'x', scope: 'delta', newFindings: 0, cost: '0' });
    }
    expect(runs).toHaveLength(20);
    expect(runs.at(-1)!.sha).toBe('sha24');
  });
});
describe('finding lifecycle reconciliation', () => {
  it('opens unknown findings, updates severity, fixes only in-scope absences, and reopens terminals', () => {
    const first = reconcileFindingInventory(null, [annotation()], ['src/a.ts'], 'sha1', 'one');
    expect(first.findings[0]).toMatchObject({ status: 'open', severity: 'critical' });
    const fixed = reconcileFindingInventory(firstState(first.findings), [], ['src/a.ts'], 'sha2', 'two');
    expect(fixed.findings[0].status).toBe('fixed');
    const reopened = reconcileFindingInventory(
      firstState(fixed.findings),
      [annotation({ severity: 'warning' })],
      ['src/a.ts'],
      'sha3',
      'three',
    );
    expect(reopened.findings[0]).toMatchObject({ status: 'open', severity: 'warning' });
  });

  it('keeps absent findings open outside the successful manifest', () => {
    const current = reconcileFindingInventory(null, [annotation()], ['src/a.ts'], 'sha1', 'one');
    const next = reconcileFindingInventory(firstState(current.findings), [], ['src/other.ts'], 'sha2', 'two');
    expect(next.findings[0].status).toBe('open');
  });

  it('dismisses only an open finding backed by the current thread', () => {
    const current = reconcileFindingInventory(null, [annotation()], ['src/a.ts'], 'sha1', 'one');
    const withThread = firstState(current.findings.map((finding) => ({ ...finding, threadId: 'thread-1' })));
    const dismissed = applyManualThreadResolution(withThread, {
      fingerprint: withThread.findings[0].fingerprint,
      threadId: 'thread-1',
      eventKey: 'delivery-1',
      at: 'two',
    });
    expect(dismissed.findings[0].status).toBe('dismissed');
    const duplicate = applyManualThreadResolution(dismissed, {
      fingerprint: withThread.findings[0].fingerprint,
      threadId: 'thread-1',
      eventKey: 'delivery-1',
      at: 'three',
    });
    expect(duplicate).toEqual(dismissed);
  });
});

function firstState(findings: ReviewState['findings']): ReviewState {
  return {
    ...state(),
    findings,
  };
}

describe('renderStickyComment', () => {
  it('embeds the state marker, open counts, and run history', () => {
    const body = renderStickyComment({ result: result(), state: state(), demoted: [] });
    expect(parseStateMarker(body)).toEqual(state());
    expect(body).toContain('Open findings: 1');
    expect(body).toContain('critical | 1');
    expect(body).toContain('`abc1234`');
    expect(body).toContain('Walkthrough');
    expect(body).toContain('> Adds a feature');
  });

  it('lists demoted findings when present', () => {
    const body = renderStickyComment({
      result: result(),
      state: state(),
      demoted: [{ path: 'src/x.ts', startLine: 9, severity: 'warning', title: 'Unplaceable' }],
    });
    expect(body).toContain('could not be placed inline');
    expect(body).toContain('`src/x.ts:9` — Unplaceable');
  });
});

describe('loadReviewState / saveStickyComment', () => {
  it('finds the sticky comment by marker, never by author', async () => {
    const octokit = {
      issues: {
        listComments: vi.fn(async () => ({
          data: [
            { id: 1, body: 'human comment' },
            { id: 2, body: `bot noise` },
            { id: 3, body: `summary\n${renderStateMarker(state())}` },
          ],
        })),
      },
    };
    const sticky = await loadReviewState(octokit as never, { owner: 'o', repo: 'r', pullNumber: 1 });
    expect(sticky).toEqual({ commentId: 3, state: state() });
  });

  it('returns commentId with null state for a corrupt marker (treated as no state)', async () => {
    const octokit = {
      issues: {
        listComments: vi.fn(async () => ({
          data: [{ id: 5, body: '<!-- fiscalcr:state:v1 {corrupt -->' }],
        })),
      },
    };
    const sticky = await loadReviewState(octokit as never, { owner: 'o', repo: 'r', pullNumber: 1 });
    expect(sticky).toEqual({ commentId: 5, state: null });
  });

  it('updates in place when a comment id is known', async () => {
    const octokit = {
      issues: {
        updateComment: vi.fn(async () => ({})),
        createComment: vi.fn(),
        listComments: vi.fn(),
      },
    };
    const id = await saveStickyComment(octokit as never, {
      owner: 'o', repo: 'r', pullNumber: 1, commentId: 3, body: 'updated',
    });
    expect(id).toBe(3);
    expect(octokit.issues.updateComment).toHaveBeenCalledWith(
      expect.objectContaining({ comment_id: 3, body: 'updated' }),
    );
    expect(octokit.issues.createComment).not.toHaveBeenCalled();
  });

  it('re-checks for a concurrently created sticky comment before creating', async () => {
    const octokit = {
      issues: {
        listComments: vi.fn(async () => ({
          data: [{ id: 8, body: renderStateMarker(state()) }],
        })),
        updateComment: vi.fn(async () => ({})),
        createComment: vi.fn(),
      },
    };
    const id = await saveStickyComment(octokit as never, {
      owner: 'o', repo: 'r', pullNumber: 1, commentId: null, body: 'body',
    });
    expect(id).toBe(8);
    expect(octokit.issues.updateComment).toHaveBeenCalled();
    expect(octokit.issues.createComment).not.toHaveBeenCalled();
  });

  it('falls back to creating when the sticky comment was deleted', async () => {
    const octokit = {
      issues: {
        updateComment: vi.fn(async () => {
          throw Object.assign(new Error('404'), { status: 404 });
        }),
        createComment: vi.fn(async () => ({ data: { id: 99 } })),
        listComments: vi.fn(async () => ({ data: [] })),
      },
    };
    const id = await saveStickyComment(octokit as never, {
      owner: 'o', repo: 'r', pullNumber: 1, commentId: 3, body: 'body',
    });
    expect(id).toBe(99);
  });

  it('propagates non-404 update failures instead of creating duplicates', async () => {
    const octokit = {
      issues: {
        updateComment: vi.fn(async () => {
          throw Object.assign(new Error('server unavailable'), { status: 503 });
        }),
        createComment: vi.fn(),
        listComments: vi.fn(),
      },
    };
    await expect(saveStickyComment(octokit as never, {
      owner: 'o', repo: 'r', pullNumber: 1, commentId: 3, body: 'body',
    })).rejects.toThrow('server unavailable');
    expect(octokit.issues.createComment).not.toHaveBeenCalled();
  });
});

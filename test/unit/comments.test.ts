import { describe, expect, it, vi } from 'vitest';
import {
  createIncrementalReview,
  createPRReview,
  dismissBlockingReview,
  partitionPlaceable,
} from '../../src/github/comments.js';
import { fingerprintAnnotation } from '../../src/github/fingerprint.js';
import type { ChangedFile, ReviewAnnotation, ReviewResult } from '../../src/types/review.js';
import type { DiagramArtifact } from '../../src/types/diagram.js';

// New-file patch: lines 1-3 are additions → commentable; anything else is not.
const PATCH = '@@ -0,0 +1,3 @@\n+line one\n+line two\n+line three';

function file(filename: string): ChangedFile {
  return { filename, status: 'modified', additions: 3, deletions: 0, patch: PATCH };
}

function binaryFile(filename: string): ChangedFile {
  return { filename, status: 'modified', additions: 0, deletions: 0 };
}

function annotation(overrides: Partial<ReviewAnnotation> = {}): ReviewAnnotation {
  return {
    path: 'src/a.ts',
    startLine: 2,
    endLine: 2,
    severity: 'warning',
    category: 'bug',
    title: 'Something is off',
    body: 'details',
    ...overrides,
  };
}
function diagram(): DiagramArtifact {
  return {
    mode: 'concept',
    nodes: [{ id: 'n1', label: 'Auth handler', change: 'modified', evidence: ['e1'] }],
    edges: [],
    evidence: [{ id: 'e1', path: 'src/auth.ts' }],
    headSha: 'head-sha',
    scope: 'full',
    partial: false,
  };
}
function bigDiagram(): DiagramArtifact {
  return {
    mode: 'concept',
    nodes: Array.from({ length: 200 }, (_, i) => ({
      id: `n${i}`,
      label: `node-${i}-${'x'.repeat(200)}`,
      change: 'context' as const,
      evidence: ['e1'],
    })),
    edges: [],
    evidence: [{ id: 'e1', path: 'src/big.ts' }],
    headSha: 'head-sha',
    scope: 'full',
    partial: false,
  };
}

const params = { owner: 'o', repo: 'r', pullNumber: 1, commitSha: 'head-sha' };

describe('partitionPlaceable', () => {
  it('splits annotations by whether their end line is commentable on the diff', () => {
    const { placeable, demoted } = partitionPlaceable(
      [
        annotation({ endLine: 2 }), // in diff
        annotation({ endLine: 99 }), // out of diff
        annotation({ path: 'src/binary.bin', endLine: 1 }), // file has no patch
      ],
      [file('src/a.ts'), binaryFile('src/binary.bin')],
    );
    expect(placeable).toHaveLength(1);
    expect(demoted).toHaveLength(2);
  });
});

describe('createIncrementalReview', () => {
  it('posts nothing at all when there are no new placeable findings (COMMENT)', async () => {
    const octokit = { pulls: { createReview: vi.fn() } };
    const outcome = await createIncrementalReview(octokit as never, {
      ...params,
      annotations: [annotation({ endLine: 99 })],
      changedFiles: [file('src/a.ts')],
      event: 'COMMENT',
      body: 'body',
    });
    expect(octokit.pulls.createReview).not.toHaveBeenCalled();
    expect(outcome.reviewId).toBeNull();
    expect(outcome.demoted).toHaveLength(1);
  });

  it('still posts a body-only REQUEST_CHANGES with zero placeable findings', async () => {
    const octokit = { pulls: { createReview: vi.fn(async () => ({ data: { id: 11 } })) } };
    const outcome = await createIncrementalReview(octokit as never, {
      ...params,
      annotations: [],
      changedFiles: [file('src/a.ts')],
      event: 'REQUEST_CHANGES',
      body: 'still failing',
    });
    expect(octokit.pulls.createReview).toHaveBeenCalledWith(
      expect.objectContaining({ event: 'REQUEST_CHANGES', comments: [] }),
    );
    expect(outcome.reviewId).toBe(11);
  });

  it('appends a fingerprint marker to every inline comment and excludes nitpicks', async () => {
    const octokit = { pulls: { createReview: vi.fn(async () => ({ data: { id: 12 } })) } };
    const warning = annotation();
    const nitpick = annotation({ severity: 'nitpick', title: 'nit' });
    const outcome = await createIncrementalReview(octokit as never, {
      ...params,
      annotations: [warning, nitpick],
      changedFiles: [file('src/a.ts')],
      event: 'COMMENT',
      body: 'body',
    });
    const call = octokit.pulls.createReview.mock.calls[0][0] as {
      comments: Array<{ body: string }>;
    };
    expect(call.comments).toHaveLength(1);
    expect(call.comments[0].body).toContain(
      `<!-- fiscalcr:fp:v1:${fingerprintAnnotation(warning)} -->`,
    );
    expect(outcome.posted).toEqual([warning]);
    expect(outcome.demoted).toEqual([nitpick]);
  });

  it('falls back to a body-only review when GitHub rejects the inline comments (422)', async () => {
    const createReview = vi
      .fn()
      .mockRejectedValueOnce(Object.assign(new Error('Validation Failed'), { status: 422 }))
      .mockResolvedValueOnce({ data: { id: 13 } });
    const octokit = { pulls: { createReview } };
    const outcome = await createIncrementalReview(octokit as never, {
      ...params,
      annotations: [annotation()],
      changedFiles: [file('src/a.ts')],
      event: 'COMMENT',
      body: 'body',
    });
    expect(createReview).toHaveBeenCalledTimes(2);
    expect(createReview.mock.calls[1][0]).not.toHaveProperty('comments');
    expect(createReview.mock.calls[1][0].body).toContain('could not be placed');
    expect(outcome.reviewId).toBe(13);
    expect(outcome.posted).toEqual([]);
    expect(outcome.demoted).toHaveLength(1);
  });

  it('does not retry body-only for non-validation failures', async () => {
    const createReview = vi.fn().mockRejectedValue(Object.assign(new Error('timeout'), { status: 503 }));
    const octokit = { pulls: { createReview } };
    await expect(createIncrementalReview(octokit as never, {
      ...params,
      annotations: [annotation()],
      changedFiles: [file('src/a.ts')],
      event: 'COMMENT',
      body: 'body',
    })).rejects.toThrow('timeout');
    expect(createReview).toHaveBeenCalledTimes(1);
  });
  it('does not inject a diagram into the incremental review body', async () => {
    const octokit = { pulls: { createReview: vi.fn(async () => ({ data: { id: 99 } })) } };
    await createIncrementalReview(octokit as never, {
      ...params,
      annotations: [annotation()],
      changedFiles: [file('src/a.ts')],
      event: 'COMMENT',
      body: 'incremental summary',
    });
    const call = octokit.pulls.createReview.mock.calls[0][0] as { body: string };
    expect(call.body).toBe('incremental summary');
    expect(call.body).not.toContain('### Concept map');
  });
});

describe('dismissBlockingReview', () => {
  it('dismisses and reports success', async () => {
    const octokit = { pulls: { dismissReview: vi.fn(async () => ({})) } };
    const ok = await dismissBlockingReview(octokit as never, {
      owner: 'o', repo: 'r', pullNumber: 1, reviewId: 7, message: 'done',
    });
    expect(ok).toBe(true);
    expect(octokit.pulls.dismissReview).toHaveBeenCalledWith(
      expect.objectContaining({ review_id: 7, message: 'done' }),
    );
  });

  it('degrades gracefully when dismissal is forbidden', async () => {
    const octokit = {
      pulls: {
        dismissReview: vi.fn(async () => {
          throw new Error('403');
        }),
      },
    };
    const ok = await dismissBlockingReview(octokit as never, {
      owner: 'o', repo: 'r', pullNumber: 1, reviewId: 7, message: 'done',
    });
    expect(ok).toBe(false);
  });
});

describe('createPRReview (legacy mode)', () => {
  const result: ReviewResult = {
    summary: 'Legacy summary',
    score: 75,
    annotations: [annotation({ severity: 'critical' })],
    stats: { critical: 1, warning: 0, suggestion: 0, nitpick: 0 },
    tokensUsed: { input: 10, output: 5, cached: 0 },
  };

  it('posts one full review per run with REQUEST_CHANGES on criticals', async () => {
    const octokit = { pulls: { createReview: vi.fn(async () => ({ data: { id: 1 } })) } };
    await createPRReview(octokit as never, {
      ...params,
      result,
      failOn: 'critical',
    });
    const call = octokit.pulls.createReview.mock.calls[0][0] as { body: string };
    expect(call.body).toContain('📊 Review telemetry & cost');
    expect(call.body).toContain('| Input tokens | 10 |');
    expect(call.body).toContain('| Estimated cost |');
    expect(octokit.pulls.createReview).toHaveBeenCalledWith(
      expect.objectContaining({
        event: 'REQUEST_CHANGES',
        comments: [expect.objectContaining({ path: 'src/a.ts', line: 2 })],
      }),
    );
  });
  it('places the optional diagram between the summary and walkthrough', async () => {
    const octokit = { pulls: { createReview: vi.fn(async () => ({ data: { id: 1 } })) } };
    await createPRReview(octokit as never, {
      ...params,
      result: {
        ...result,
        walkthrough: [{ path: 'src/a.ts', summary: 'tweak' }],
        diagram: diagram(),
      },
      failOn: 'never',
    });
    const call = octokit.pulls.createReview.mock.calls[0][0] as { body: string };
    expect(call.body).toContain('### Concept map');
    expect(call.body).toContain('```mermaid');
    expect(call.body).not.toContain('> Adds a feature');
    expect(call.body.indexOf('### Concept map')).toBeGreaterThan(call.body.indexOf('Legacy summary'));
    expect(call.body.indexOf('### Concept map')).toBeLessThan(call.body.indexOf('Walkthrough'));
    expect(call.body.indexOf('Walkthrough')).toBeLessThan(call.body.indexOf('| Severity | Count |'));
  });
  it('keeps the 422 fallback body within the cap, omitting the optional diagram when needed', async () => {
    const createReview = vi
      .fn()
      .mockRejectedValueOnce(Object.assign(new Error('Validation Failed'), { status: 422 }))
      .mockResolvedValueOnce({ data: { id: 1 } });
    const octokit = { pulls: { createReview } };
    await createPRReview(octokit as never, {
      ...params,
      result: {
        ...result,
        summary: 'x'.repeat(58_000),
        walkthrough: [{ path: 'src/a.ts', summary: 'tweak' }],
        diagram: bigDiagram(),
      },
      failOn: 'never',
    });
    const fallbackCall = createReview.mock.calls[1][0] as { body: string };
    // The 422 retry appends a fallback note; the whole body must stay within the cap.
    expect(fallbackCall.body).toContain('could not be placed');
    expect(Buffer.byteLength(fallbackCall.body, 'utf8')).toBeLessThanOrEqual(60_000);
    // Only the optional diagram is dropped to make room — findings are preserved.
    expect(fallbackCall.body).not.toContain('### Concept map');
    expect(fallbackCall.body).toContain('| 🔴 critical | 1 |');
  });
});

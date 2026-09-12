import { describe, expect, it, vi } from 'vitest';
import {
  listFiscalcrThreads,
  replyToFixedReviewComments,
  resolveOutdatedThreads,
} from '../../src/github/threads.js';
import { fingerprintMarker } from '../../src/github/fingerprint.js';
import { logger } from '../../src/utils/logger.js';

const FP_A = 'aaaaaaaaaaaaaaaa';
const FP_B = 'bbbbbbbbbbbbbbbb';

function threadNode(input: {
  id: string;
  path: string;
  fp?: string;
  isResolved?: boolean;
  isOutdated?: boolean;
  line?: number | null;
  originalLine?: number | null;
  severity?: string;
}) {
  const body = input.fp
    ? `🔴 **[${input.severity ?? 'critical'}]** Title\n\nbody\n\n${fingerprintMarker(input.fp)}`
    : 'a human thread';
  return {
    id: input.id,
    isResolved: input.isResolved ?? false,
    isOutdated: input.isOutdated ?? false,
    path: input.path,
    line: input.line ?? null,
    originalLine: input.originalLine ?? null,
    comments: { nodes: [{ body }] },
  };
}

function graphqlOctokit(nodes: unknown[], opts: { failMutations?: boolean } = {}) {
  const graphql = vi.fn(async (query: string, variables?: { threadId?: string }) => {
    if (query.includes('reviewThreads')) {
      return {
        repository: {
          pullRequest: {
            reviewThreads: {
              pageInfo: { hasNextPage: false, endCursor: null },
              nodes,
            },
          },
        },
      };
    }
    if (opts.failMutations) throw new Error('403 Resource not accessible');
    if (query.includes('resolveReviewThread')) {
      return {
        resolveReviewThread: {
          thread: { id: variables?.threadId ?? '', isResolved: true },
        },
      };
    }
    if (query.includes('addPullRequestReviewThreadReply')) {
      return { addPullRequestReviewThreadReply: { comment: { id: 'audit-1' } } };
    }
    return {};
  });
  return { graphql, octokit: { graphql } as never };
}

const params = {
  owner: 'o',
  repo: 'r',
  pullNumber: 1,
  headSha: 'abcdef1234567890',
};

describe('listFiscalcrThreads', () => {
  it('keeps only threads with a fingerprint marker and parses severity', async () => {
    const { octokit } = graphqlOctokit([
      threadNode({ id: 't1', path: 'src/a.ts', fp: FP_A, severity: 'warning' }),
      threadNode({ id: 't2', path: 'src/b.ts' }), // human thread — no marker
    ]);
    const threads = await listFiscalcrThreads(octokit, params);
    expect(threads).toEqual([
      {
        id: 't1',
        isResolved: false,
        isOutdated: false,
        path: 'src/a.ts',
        line: null,
        originalLine: null,
        fingerprint: FP_A,
        severity: 'warning',
      },
    ]);
  });

  it('excludes outdated threads from the current-thread view', async () => {
    const { octokit } = graphqlOctokit([
      threadNode({ id: 'current', path: 'src/a.ts', fp: FP_A }),
      threadNode({ id: 'outdated', path: 'src/a.ts', fp: FP_B, isOutdated: true }),
    ]);

    const threads = await listFiscalcrThreads(octokit, params);
    expect(threads.map((thread) => thread.id)).toEqual(['current']);
  });
});
describe('replyToFixedReviewComments', () => {
  function replyOctokit(
    pages: Array<Array<{ id: number; body?: string; path?: string; in_reply_to_id?: number | null }>>,
    createReply?: (input: { comment_id: number; body: string }) => Promise<{ data: { id: number } }>,
  ) {
    const listReviewComments = vi.fn(async ({ page }: { page: number }) => ({
      data: pages[page - 1] ?? [],
    }));
    const createReplyForReviewComment =
      createReply ?? vi.fn(async () => ({ data: { id: 999 } }));
    const octokit = { pulls: { listReviewComments, createReplyForReviewComment } } as never;
    return { octokit, listReviewComments, createReplyForReviewComment };
  }
  const base = { owner: 'o', repo: 'r', pullNumber: 1 } as const;

  it('paginates review comments and replies to the latest matching root with a hidden marker', async () => {
    const firstPage = Array.from({ length: 100 }, (_, index) => ({
      id: index + 1,
      body: 'unrelated review comment',
      path: 'src/other.ts',
    }));
    const { octokit, createReplyForReviewComment } = replyOctokit([
      firstPage,
      [{ id: 201, body: fingerprintMarker(FP_A), path: 'src/a.ts' }],
    ]);

    const result = await replyToFixedReviewComments(octokit, {
      ...base,
      fixedFindings: [{ fingerprint: FP_A, fixedAtSha: 'abcdef1234567890' }],
    });

    expect(result).toEqual({ attempted: 1, replied: 1, failed: 0, unavailable: false });
    expect(createReplyForReviewComment).toHaveBeenCalledWith(
      expect.objectContaining({
        owner: 'o',
        repo: 'r',
        pull_number: 1,
        comment_id: 201,
        body: expect.stringContaining('✅ Finding fixed — code changed in `abcdef1`.'),
      }),
    );
    const call = createReplyForReviewComment.mock.calls.find(([c]) => c.comment_id === 201);
    expect(call?.[0].body).toContain('<!-- fiscalcr:resolution:v1 201:abcdef1234567890 -->');
  });

  it('does not re-acknowledge a root that already carries the exact resolution marker', async () => {
    const { octokit, createReplyForReviewComment } = replyOctokit([
      [
        { id: 301, body: fingerprintMarker(FP_A), path: 'src/a.ts' },
        {
          id: 302,
          body: '✅ Finding fixed — code changed in `oldsha`.\n\n<!-- fiscalcr:resolution:v1 301:oldsha -->',
          path: 'src/a.ts',
          in_reply_to_id: 301,
        },
      ],
    ]);
    const result = await replyToFixedReviewComments(octokit, {
      ...base,
      fixedFindings: [{ fingerprint: FP_A, fixedAtSha: 'oldsha' }],
    });
    expect(result).toEqual({ attempted: 0, replied: 0, failed: 0, unavailable: false });
    expect(createReplyForReviewComment).not.toHaveBeenCalled();
  });

  it('re-acknowledges when an existing reply lacks the exact hidden marker', async () => {
    const { octokit, createReplyForReviewComment } = replyOctokit([
      [
        { id: 301, body: fingerprintMarker(FP_A), path: 'src/a.ts' },
        {
          id: 302,
          body: '✅ Finding fixed — code changed in `oldsha`.',
          path: 'src/a.ts',
          in_reply_to_id: 301,
        },
      ],
    ]);
    const result = await replyToFixedReviewComments(octokit, {
      ...base,
      fixedFindings: [{ fingerprint: FP_A, fixedAtSha: 'oldsha' }],
    });
    expect(result).toMatchObject({ attempted: 1, replied: 1 });
    expect(createReplyForReviewComment).toHaveBeenCalledWith(expect.objectContaining({ comment_id: 301 }));
    const call = createReplyForReviewComment.mock.calls.find(([c]) => c.comment_id === 301);
    expect(call?.[0].body).toContain('<!-- fiscalcr:resolution:v1 301:oldsha -->');
  });

  it('does not suppress when a marker references a different root', async () => {
    const { octokit, createReplyForReviewComment } = replyOctokit([
      [
        { id: 301, body: fingerprintMarker(FP_A), path: 'src/a.ts' },
        {
          id: 302,
          body: '✅ Finding fixed — code changed in `oldsha`.\n\n<!-- fiscalcr:resolution:v1 999:oldsha -->',
          path: 'src/a.ts',
          in_reply_to_id: 301,
        },
      ],
    ]);
    const result = await replyToFixedReviewComments(octokit, {
      ...base,
      fixedFindings: [{ fingerprint: FP_A, fixedAtSha: 'oldsha' }],
    });
    expect(result).toMatchObject({ attempted: 1, replied: 1 });
    const call = createReplyForReviewComment.mock.calls.find(([c]) => c.comment_id === 301);
    expect(call?.[0].body).toContain('<!-- fiscalcr:resolution:v1 301:oldsha -->');
  });

  it('replies only to the latest root per fingerprint, never to a reply comment', async () => {
    const { octokit, createReplyForReviewComment } = replyOctokit([
      [
        { id: 201, body: fingerprintMarker(FP_A), path: 'src/a.ts' },
        { id: 301, body: fingerprintMarker(FP_A), path: 'src/a.ts' },
        { id: 401, body: 'a manual reply', path: 'src/a.ts', in_reply_to_id: 201 },
      ],
    ]);
    const result = await replyToFixedReviewComments(octokit, {
      ...base,
      fixedFindings: [{ fingerprint: FP_A, fixedAtSha: 'sha1' }],
    });
    expect(result).toEqual({ attempted: 1, replied: 1, failed: 0, unavailable: false });
    expect(createReplyForReviewComment).toHaveBeenCalledTimes(1);
    expect(createReplyForReviewComment).toHaveBeenCalledWith(expect.objectContaining({ comment_id: 301 }));
  });

  it('only acknowledges fingerprints in fixedFindings and ignores reply comments', async () => {
    const { octokit, createReplyForReviewComment } = replyOctokit([
      [
        { id: 101, body: fingerprintMarker(FP_A), path: 'src/a.ts' },
        { id: 102, body: fingerprintMarker(FP_B), path: 'src/b.ts' },
        { id: 500, body: `reply text\n${fingerprintMarker(FP_A)}`, path: 'src/a.ts', in_reply_to_id: 101 },
      ],
    ]);
    const result = await replyToFixedReviewComments(octokit, {
      ...base,
      fixedFindings: [{ fingerprint: FP_A, fixedAtSha: 'sha1' }],
    });
    expect(result).toEqual({ attempted: 1, replied: 1, failed: 0, unavailable: false });
    expect(createReplyForReviewComment).toHaveBeenCalledTimes(1);
    expect(createReplyForReviewComment).toHaveBeenCalledWith(expect.objectContaining({ comment_id: 101 }));
  });

  it('detects existing markers across paginated pages before acknowledging', async () => {
    const firstPage = [
      { id: 201, body: fingerprintMarker(FP_A), path: 'src/a.ts' },
      ...Array.from({ length: 99 }, (_, index) => ({
        id: 1000 + index,
        body: 'unrelated review comment',
        path: 'src/other.ts',
      })),
    ];
    const { octokit, createReplyForReviewComment } = replyOctokit([
      firstPage,
      [
        {
          id: 202,
          body: '✅ Finding fixed — code changed in `oldsha`.\n\n<!-- fiscalcr:resolution:v1 201:oldsha -->',
          path: 'src/a.ts',
          in_reply_to_id: 201,
        },
      ],
    ]);
    const result = await replyToFixedReviewComments(octokit, {
      ...base,
      fixedFindings: [{ fingerprint: FP_A, fixedAtSha: 'oldsha' }],
    });
    expect(result).toEqual({ attempted: 0, replied: 0, failed: 0, unavailable: false });
    expect(createReplyForReviewComment).not.toHaveBeenCalled();
  });

  it('posts a commitless acknowledgement when no fix SHA is known', async () => {
    const { octokit, createReplyForReviewComment } = replyOctokit([
      [{ id: 201, body: fingerprintMarker(FP_A), path: 'src/a.ts' }],
    ]);
    const result = await replyToFixedReviewComments(octokit, {
      ...base,
      fixedFindings: [{ fingerprint: FP_A }],
    });
    expect(result).toMatchObject({ attempted: 1, replied: 1 });
    const call = createReplyForReviewComment.mock.calls.find(([c]) => c.comment_id === 201);
    expect(call?.[0].body).toContain('✅ Finding fixed.');
    expect(call?.[0].body).toContain('<!-- fiscalcr:resolution:v1 201:unknown -->');
    expect(call?.[0].body).not.toContain('code changed in');
  });

  it('survives a REST transport failure and counts it without aborting other roots', async () => {
    const listReviewComments = vi.fn(async ({ page }: { page: number }) => ({
      data:
        page === 1
          ? [
              { id: 201, body: fingerprintMarker(FP_A), path: 'src/a.ts' },
              { id: 301, body: fingerprintMarker(FP_B), path: 'src/b.ts' },
            ]
          : [],
    }));
    const createReplyForReviewComment = vi.fn(async (input: { comment_id: number }) => {
      if (input.comment_id === 201) throw new Error('503');
      return { data: { id: 999 } };
    });
    const octokit = { pulls: { listReviewComments, createReplyForReviewComment } } as never;
    const result = await replyToFixedReviewComments(octokit, {
      ...base,
      fixedFindings: [
        { fingerprint: FP_A, fixedAtSha: 'a' },
        { fingerprint: FP_B, fixedAtSha: 'b' },
      ],
    });
    expect(result).toMatchObject({ attempted: 2, replied: 1, failed: 1, unavailable: true });
    expect(createReplyForReviewComment).toHaveBeenCalledTimes(2);
    expect(createReplyForReviewComment).toHaveBeenCalledWith(expect.objectContaining({ comment_id: 301 }));
  });

  it('reports unavailable when the comment listing transport fails', async () => {
    const listReviewComments = vi.fn(async () => {
      throw new Error('403');
    });
    const createReplyForReviewComment = vi.fn(async () => ({ data: { id: 1 } }));
    const octokit = { pulls: { listReviewComments, createReplyForReviewComment } } as never;
    const result = await replyToFixedReviewComments(octokit, {
      ...base,
      fixedFindings: [{ fingerprint: FP_A, fixedAtSha: 'a' }],
    });
    expect(result).toEqual({ attempted: 0, replied: 0, failed: 0, unavailable: true });
    expect(createReplyForReviewComment).not.toHaveBeenCalled();
  });
});

describe('resolveOutdatedThreads', () => {
  it('resolves only unresolved outdated threads covered by current or original lines', async () => {
    const { octokit, graphql } = graphqlOctokit([
      threadNode({ id: 'gone', path: 'src/a.ts', fp: FP_A, isOutdated: true, line: null, originalLine: 464 }),
      threadNode({ id: 'still', path: 'src/a.ts', fp: FP_B, line: 464, originalLine: 464 }),
      threadNode({ id: 'other', path: 'src/untouched.ts', fp: FP_A, isOutdated: true, line: 464, originalLine: 464 }),
      threadNode({ id: 'outside', path: 'src/a.ts', fp: FP_A, isOutdated: true, line: 500, originalLine: 500 }),
      threadNode({ id: 'done', path: 'src/a.ts', fp: FP_A, isResolved: true, line: null, originalLine: 464 }),
    ]);
    const resolved = await resolveOutdatedThreads(octokit, {
      owner: 'o', repo: 'r', pullNumber: 1,
      changedPaths: new Set(['src/a.ts']),
      reviewedRanges: [{ path: 'src/a.ts', startLine: 464, endLine: 464 }],
      currentFingerprints: new Set([FP_B]),
    });
    expect(resolved.resolved.map((t) => t.id)).toEqual(['gone']);
    const resolveIndex = graphql.mock.calls.findIndex(([q]) => (q as string).includes('resolveReviewThread'));
    expect(resolveIndex).toBeGreaterThan(-1);
    expect(graphql.mock.calls[resolveIndex][1]).toEqual({ threadId: 'gone' });
    expect(graphql.mock.calls.some(([q]) => (q as string).includes('addPullRequestReviewThreadReply'))).toBe(false);
  });
  it('resolves an explicitly fixed finding regardless of stale thread coordinates', async () => {
    const { octokit } = graphqlOctokit([
      threadNode({ id: 'fixed', path: 'src/a.ts', fp: FP_A, isOutdated: true, line: 500, originalLine: 500 }),
    ]);
    const resolved = await resolveOutdatedThreads(octokit, {
      owner: 'o', repo: 'r', pullNumber: 1,
      changedPaths: new Set(['src/a.ts']),
      reviewedRanges: [{ path: 'src/a.ts', startLine: 1, endLine: 2 }],
      currentFingerprints: new Set(),
      fixedFingerprints: new Set([FP_A]),
    });
    expect(resolved.resolved.map((thread) => thread.id)).toEqual(['fixed']);
  });
  it('resolves deletion-only coverage using original thread lines', async () => {
    const { octokit } = graphqlOctokit([
      threadNode({ id: 'deleted', path: 'src/a.ts', fp: FP_A, isOutdated: true, line: null, originalLine: 7 }),
    ]);
    const resolved = await resolveOutdatedThreads(octokit, {
      owner: 'o', repo: 'r', pullNumber: 1,
      changedPaths: new Set(['src/a.ts']),
      reviewedRanges: [
        { path: 'src/a.ts', startLine: 8, endLine: 8, originalStartLine: 7, originalEndLine: 7 },
      ],
      currentFingerprints: new Set(),
    });
    expect(resolved.resolved.map((thread) => thread.id)).toEqual(['deleted']);
  });
  it('degrades to empty when listing fails (403 on default token)', async () => {
    const octokit = {
      graphql: vi.fn(async () => {
        throw new Error('403 Resource not accessible by integration');
      }),
    } as never;
    const resolved = await resolveOutdatedThreads(octokit, {
      owner: 'o', repo: 'r', pullNumber: 1,
      changedPaths: new Set(['src/a.ts']),
      currentFingerprints: new Set(),
    });
    expect(resolved).toMatchObject({ attempted: 0, resolved: [], failed: 0, unavailable: true });
  });
  it('does not report a thread resolved without GitHub confirmation', async () => {
    const graphql = vi.fn(async (query: string) => {
      if (query.includes('reviewThreads')) {
        return {
          repository: {
            pullRequest: {
              reviewThreads: {
                pageInfo: { hasNextPage: false, endCursor: null },
                nodes: [threadNode({ id: 'gone', path: 'src/a.ts', fp: FP_A })],
              },
            },
          },
        };
      }
      if (query.includes('resolveReviewThread')) {
        return { resolveReviewThread: { thread: { id: 'gone', isResolved: false } } };
      }
      return {};
    });
    const warning = vi.spyOn(logger, 'warn');
    const resolved = await resolveOutdatedThreads({ graphql } as never, {
      owner: 'o', repo: 'r', pullNumber: 1,
      changedPaths: new Set(['src/a.ts']),
      currentFingerprints: new Set(),
    });
    expect(resolved).toMatchObject({ attempted: 1, resolved: [], failed: 1 });
    expect(graphql.mock.calls.filter(([query]) => (query as string).includes('addPullRequestReviewThreadReply'))).toHaveLength(0);
    expect(warning).toHaveBeenCalled();
    warning.mockRestore();
  });
  it('reports unresolved thread cleanup failures', async () => {
    const nodes = [
      threadNode({ id: 'failed', path: 'src/a.ts', fp: FP_A }),
      threadNode({ id: 'resolved', path: 'src/a.ts', fp: FP_B }),
    ];
    let mutations = 0;
    const octokit = {
      graphql: vi.fn(async (query: string, variables?: { threadId?: string }) => {
        if (query.includes('reviewThreads')) {
          return {
            repository: {
              pullRequest: {
                reviewThreads: { pageInfo: { hasNextPage: false, endCursor: null }, nodes },
              },
            },
          };
        }
        mutations++;
        if (query.includes('resolveReviewThread')) {
          if (mutations === 1) throw new Error('403');
          return {
            resolveReviewThread: {
              thread: { id: variables?.threadId ?? '', isResolved: true },
            },
          };
        }
        return {};
      }),
    } as never;
    const warning = vi.spyOn(logger, 'warn');
    const resolved = await resolveOutdatedThreads(octokit, {
      owner: 'o', repo: 'r', pullNumber: 1,
      changedPaths: new Set(['src/a.ts']),
      currentFingerprints: new Set(),
    });
    expect(resolved.resolved.map((t) => t.id)).toEqual(['resolved']);
    expect(resolved).toMatchObject({ attempted: 2, failed: 1 });
    expect(warning).toHaveBeenCalled();
    warning.mockRestore();
  });
});

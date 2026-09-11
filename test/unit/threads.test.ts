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
  it('paginates review comments and replies to a matching root comment', async () => {
    const firstPage = Array.from({ length: 100 }, (_, index) => ({
      id: index + 1,
      body: 'unrelated review comment',
      path: 'src/other.ts',
    }));
    const listReviewComments = vi.fn(async ({ page }: { page: number }) => ({
      data:
        page === 1
          ? firstPage
          : page === 2
            ? [{ id: 201, body: fingerprintMarker(FP_A), path: 'src/a.ts' }]
            : [],
    }));
    const createReplyForReviewComment = vi.fn(async () => ({ data: { id: 202 } }));
    const octokit = { pulls: { listReviewComments, createReplyForReviewComment } } as never;

    await replyToFixedReviewComments(octokit, {
      ...params,
      fixedFingerprints: new Set([FP_A]),
    });

    expect(listReviewComments.mock.calls.map(([input]) => input)).toEqual([
      { owner: 'o', repo: 'r', pull_number: 1, per_page: 100, page: 1 },
      { owner: 'o', repo: 'r', pull_number: 1, per_page: 100, page: 2 },
    ]);
    expect(createReplyForReviewComment).toHaveBeenCalledWith({
      owner: 'o',
      repo: 'r',
      pull_number: 1,
      comment_id: 201,
      body: '✅ Already handled — finding fixed in `abcdef1`.',
    });
  });

  it('does not duplicate an existing inline resolution reply', async () => {
    const listReviewComments = vi.fn(async () => ({
      data: [
        { id: 301, body: fingerprintMarker(FP_A), path: 'src/a.ts' },
        {
          id: 302,
          body: '✅ Already handled — finding fixed in `old-sha`.',
          path: 'src/a.ts',
          in_reply_to_id: 301,
        },
      ],
    }));
    const createReplyForReviewComment = vi.fn(async () => ({ data: { id: 303 } }));
    const octokit = { pulls: { listReviewComments, createReplyForReviewComment } } as never;

    await replyToFixedReviewComments(octokit, {
      ...params,
      fixedFingerprints: new Set([FP_A]),
    });

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
      ...params,
      changedPaths: new Set(['src/a.ts']),
      reviewedRanges: [{ path: 'src/a.ts', startLine: 464, endLine: 464 }],
      currentFingerprints: new Set([FP_B]),
    });
    expect(resolved.resolved.map((t) => t.id)).toEqual(['gone']);
    const resolveIndex = graphql.mock.calls.findIndex(([q]) => (q as string).includes('resolveReviewThread'));
    const replyIndex = graphql.mock.calls.findIndex(([q]) =>
      (q as string).includes('addPullRequestReviewThreadReply'),
    );
    expect(resolveIndex).toBeGreaterThan(-1);
    expect(replyIndex).toBe(resolveIndex + 1);
    expect(graphql.mock.calls[resolveIndex][1]).toEqual({ threadId: 'gone' });
    expect(graphql.mock.calls[replyIndex][1]).toMatchObject({
      threadId: 'gone',
      body: expect.stringContaining('abcdef1'),
    });
  });
  it('resolves an explicitly fixed finding regardless of stale thread coordinates', async () => {
    const { octokit, graphql } = graphqlOctokit([
      threadNode({ id: 'fixed', path: 'src/a.ts', fp: FP_A, isOutdated: true, line: 500, originalLine: 500 }),
    ]);

    const resolved = await resolveOutdatedThreads(octokit, {
      changedPaths: new Set(['src/a.ts']),
      reviewedRanges: [{ path: 'src/a.ts', startLine: 1, endLine: 2 }],
      currentFingerprints: new Set(),
      fixedFingerprints: new Set([FP_A]),
      headSha: 'abcdef1234567890',
    });

    expect(resolved.resolved.map((thread) => thread.id)).toEqual(['fixed']);
    const reply = graphql.mock.calls.find(([query]) =>
      (query as string).includes('addPullRequestReviewThreadReply'),
    );
    expect(reply?.[1]).toMatchObject({
      threadId: 'fixed',
      body: '✅ Already handled — finding fixed in `abcdef1`.',
    });
  });

  it('resolves deletion-only coverage using original thread lines', async () => {
    const { octokit } = graphqlOctokit([
      threadNode({ id: 'deleted', path: 'src/a.ts', fp: FP_A, isOutdated: true, line: null, originalLine: 7 }),
    ]);
    const resolved = await resolveOutdatedThreads(octokit, {
      ...params,
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
      ...params,
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
      throw new Error('audit reply must not run after an unconfirmed resolve');
    });
    const warning = vi.spyOn(logger, 'warn');

    const resolved = await resolveOutdatedThreads({ graphql } as never, {
      ...params,
      changedPaths: new Set(['src/a.ts']),
      currentFingerprints: new Set(),
    });

    expect(resolved).toMatchObject({ attempted: 1, resolved: [], failed: 1 });
    expect(graphql.mock.calls.filter(([query]) => (query as string).includes('addPullRequestReviewThreadReply'))).toHaveLength(0);
    expect(warning).toHaveBeenCalledWith(
      expect.objectContaining({ threadId: 'gone' }),
      'Could not resolve review thread — skipping',
    );
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
        return { addPullRequestReviewThreadReply: { comment: { id: 'audit-1' } } };
      }),
    } as never;
    const warning = vi.spyOn(logger, 'warn');

    const resolved = await resolveOutdatedThreads(octokit, {
      ...params,
      changedPaths: new Set(['src/a.ts']),
      currentFingerprints: new Set(),
    });

    expect(resolved.resolved.map((t) => t.id)).toEqual(['resolved']);
    expect(warning).toHaveBeenCalledWith(
      expect.objectContaining({ failed: 1, attempted: 2 }),
      '1 outdated inline thread could not be resolved',
    );
    warning.mockRestore();
  });
});

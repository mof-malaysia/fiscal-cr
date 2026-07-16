import { describe, expect, it, vi } from 'vitest';
import { listFiscalcrThreads, resolveOutdatedThreads } from '../../src/github/threads.js';
import { fingerprintMarker } from '../../src/github/fingerprint.js';

const FP_A = 'aaaaaaaaaaaaaaaa';
const FP_B = 'bbbbbbbbbbbbbbbb';

function threadNode(input: {
  id: string;
  path: string;
  fp?: string;
  isResolved?: boolean;
  severity?: string;
}) {
  const body = input.fp
    ? `🔴 **[${input.severity ?? 'critical'}]** Title\n\nbody\n\n${fingerprintMarker(input.fp)}`
    : 'a human thread';
  return {
    id: input.id,
    isResolved: input.isResolved ?? false,
    path: input.path,
    comments: { nodes: [{ body }] },
  };
}

function graphqlOctokit(nodes: unknown[], opts: { failMutations?: boolean } = {}) {
  const graphql = vi.fn(async (query: string) => {
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
      { id: 't1', isResolved: false, path: 'src/a.ts', fingerprint: FP_A, severity: 'warning' },
    ]);
  });
});

describe('resolveOutdatedThreads', () => {
  it('resolves unresolved threads on changed paths whose finding did not recur', async () => {
    const { octokit, graphql } = graphqlOctokit([
      threadNode({ id: 'gone', path: 'src/a.ts', fp: FP_A }), // fixed → resolve
      threadNode({ id: 'still', path: 'src/a.ts', fp: FP_B }), // recurred → keep
      threadNode({ id: 'other', path: 'src/untouched.ts', fp: FP_A }), // path not in scope → keep
      threadNode({ id: 'done', path: 'src/a.ts', fp: FP_A, isResolved: true }), // already resolved
    ]);
    const resolved = await resolveOutdatedThreads(octokit, {
      ...params,
      changedPaths: new Set(['src/a.ts']),
      currentFingerprints: new Set([FP_B]),
    });
    expect(resolved.map((t) => t.id)).toEqual(['gone']);
    const mutation = graphql.mock.calls.find(([q]) => (q as string).includes('resolveReviewThread'));
    expect(mutation).toBeDefined();
    expect(mutation![1]).toMatchObject({ threadId: 'gone', body: expect.stringContaining('abcdef1') });
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
    expect(resolved).toEqual([]);
  });

  it('skips threads whose resolve mutation fails, resolving the rest', async () => {
    const nodes = [
      threadNode({ id: 't1', path: 'src/a.ts', fp: FP_A }),
      threadNode({ id: 't2', path: 'src/a.ts', fp: FP_B }),
    ];
    let mutations = 0;
    const octokit = {
      graphql: vi.fn(async (query: string) => {
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
        if (mutations === 1) throw new Error('403');
        return {};
      }),
    } as never;
    const resolved = await resolveOutdatedThreads(octokit, {
      ...params,
      changedPaths: new Set(['src/a.ts']),
      currentFingerprints: new Set(),
    });
    expect(resolved.map((t) => t.id)).toEqual(['t2']);
  });
});

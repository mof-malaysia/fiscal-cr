import { describe, expect, it, vi } from 'vitest';
import { createActionOctokit } from '../../action/github-client.js';
import { listFiscalcrThreads } from '../../src/github/threads.js';
import type { FiscalcrOctokit } from '../../src/github/client.js';

function restClient(): Omit<FiscalcrOctokit, 'graphql'> {
  return {
    checks: {} as FiscalcrOctokit['checks'],
    issues: {} as FiscalcrOctokit['issues'],
    pulls: {} as FiscalcrOctokit['pulls'],
    repos: {} as FiscalcrOctokit['repos'],
  };
}

describe('Action GitHub client', () => {
  it('preserves GraphQL alongside the REST endpoint namespaces', async () => {
    const graphql = vi.fn(async () => ({
      repository: {
        pullRequest: {
          reviewThreads: {
            pageInfo: { hasNextPage: false, endCursor: null },
            nodes: [{
              id: 'thread-1',
              isResolved: false,
              path: 'src/a.ts',
              line: 4,
              comments: { nodes: [{ body: '**[warning]** issue <!-- fiscalcr:fp:v1:abcdef0123456789 -->' }] },
            }],
          },
        },
      },
    }));
    const rest = restClient();
    const client = createActionOctokit({ rest, graphql });

    expect(client.graphql).toBe(graphql);
    await expect(listFiscalcrThreads(client, { owner: 'owner', repo: 'repo', pullNumber: 1 }))
      .resolves.toMatchObject([{ id: 'thread-1', fingerprint: 'abcdef0123456789' }]);
    expect(graphql).toHaveBeenCalledOnce();
  });

  it('degrades cleanly when a host has no GraphQL capability', async () => {
    const client = createActionOctokit({
      rest: restClient(),
      graphql: undefined,
    });

    await expect(listFiscalcrThreads(client, { owner: 'owner', repo: 'repo', pullNumber: 1 }))
      .resolves.toEqual([]);
  });
});

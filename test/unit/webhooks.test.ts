import { beforeEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_CONFIG } from '../../src/config/defaults.js';
import { createLLMProvider } from '../../src/providers/factory.js';
import { ReviewOrchestrator } from '../../src/review/orchestrator.js';
import { loadConfig } from '../../src/config/loader.js';
import { registerWebhooks, handleFiscalcrThreadEvent } from '../../src/github/webhooks.js';
import { fingerprintMarker } from '../../src/github/fingerprint.js';
import { parseStateMarker, renderStateMarker, type ReviewState } from '../../src/github/review-state.js';

vi.mock('../../src/config/loader.js', () => ({
  loadConfig: vi.fn(),
}));

vi.mock('../../src/providers/factory.js', () => ({
  createLLMProvider: vi.fn(() => ({ chatCompletion: vi.fn() })),
}));

vi.mock('../../src/review/orchestrator.js', () => ({
  ReviewOrchestrator: vi.fn().mockImplementation(() => ({
    reviewPullRequest: vi.fn(),
  })),
}));

describe('App review-request webhook', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('uses default provider stages when App provider overrides the repo provider', async () => {
    const config = structuredClone(DEFAULT_CONFIG);
    config.provider = 'kimi';
    config.review.auto.onReviewRequest = true;
    vi.mocked(loadConfig).mockResolvedValue(config);

    const webhooks = { on: vi.fn() };
    registerWebhooks(webhooks as never, {
      apiKey: 'test-key',
      provider: 'anthropic',
      getInstallationOctokit: vi.fn().mockResolvedValue({}),
    });

    const handler = webhooks.on.mock.calls.find(
      ([event]) => event === 'pull_request.review_requested',
    )?.[1] as ((event: { payload: unknown }) => Promise<void>) | undefined;
    expect(handler).toBeDefined();

    await handler!({
      payload: {
        installation: { id: 1 },
        repository: { owner: { login: 'owner' }, name: 'repo' },
        pull_request: { number: 7, head: { sha: 'head-sha' } },
      },
    });

    expect(vi.mocked(createLLMProvider)).toHaveBeenCalledWith(
      expect.objectContaining({
        provider: 'anthropic',
        model: 'claude-opus-5',
      }),
    );
    expect(vi.mocked(ReviewOrchestrator)).toHaveBeenCalledWith(
      expect.anything(),
      expect.anything(),
      expect.objectContaining({ provider: 'anthropic' }),
      expect.objectContaining({
        pricingContext: expect.objectContaining({
          provider: 'anthropic',
          model: 'claude-opus-5',
        }),
      }),
    );
  });

  it('registers resolved and unresolved review-thread events', () => {
    const webhooks = { on: vi.fn() };
    registerWebhooks(webhooks as never, {
      apiKey: 'test-key',
      provider: 'anthropic',
      getInstallationOctokit: vi.fn().mockResolvedValue({}),
    });

    const events = webhooks.on.mock.calls.map(([event]) => event);
    expect(events).toContainEqual([
      'pull_request_review_thread.resolved',
      'pull_request_review_thread.unresolved',
    ]);
  });
});


describe('FiscalCR review-thread lifecycle webhook', () => {
  it('dismisses and reopens a matching current FiscalCR thread', async () => {
    const state: ReviewState = {
      v: 2,
      lastReviewedSha: 'old',
      baseSha: 'base',
      blockingReviewId: null,
      findings: [{
        fingerprint: 'aaaaaaaaaaaaaaaa',
        status: 'open',
        severity: 'critical',
        path: 'src/a.ts',
        startLine: 2,
        endLine: 2,
        title: 'Issue',
        threadId: 'thread-1',
        lastSeenSha: 'old',
        transitions: [{ status: 'open', at: 'one', source: 'review' }],
      }],
      recentEvents: [],
      autoResolvedThreads: [],
      checkRunId: null,
      checkRunHeadSha: null,
      runs: [],
    };
    let body = `summary\n${renderStateMarker(state)}`;
    const updateComment = vi.fn(async ({ body: nextBody }: { body: string }) => {
      body = nextBody;
    });
    let threadResolved = true;
    const graphql = vi.fn(async (query: string) => {
      if (query.includes('reviewThreads')) {
        return {
          repository: {
            pullRequest: {
              reviewThreads: {
                pageInfo: { hasNextPage: false, endCursor: null },
                nodes: [{
                  id: 'thread-1',
                  isResolved: threadResolved,
                  isOutdated: false,
                  path: 'src/a.ts',
                  comments: { nodes: [{ body: `**[critical]** Issue\n${fingerprintMarker('aaaaaaaaaaaaaaaa')}` }] },
                }],
              },
            },
          },
        };
      }
      return {};
    });
    const octokit = {
      issues: {
        listComments: vi.fn(async () => ({
          data: [{ id: 3, body, performed_via_github_app: { id: 1 } }],
        })),
        updateComment,
        createComment: vi.fn(),
      },
      graphql,
    };
    const input = {
      owner: 'o',
      repo: 'r',
      pullNumber: 1,
      headSha: 'new',
      threadId: 'thread-1',
      action: 'resolved' as const,
      eventId: 'delivery-1',
    };
    await handleFiscalcrThreadEvent(octokit as never, input);
    expect(parseStateMarker(body)!.findings[0].status).toBe('dismissed');
    expect(updateComment).toHaveBeenCalledTimes(1);
    threadResolved = false;
    await handleFiscalcrThreadEvent(octokit as never, {
      ...input,
      action: 'unresolved',
      eventId: 'delivery-2',
    });
    expect(parseStateMarker(body)!.findings[0].status).toBe('open');
    expect(updateComment).toHaveBeenCalledTimes(2);
    await handleFiscalcrThreadEvent(octokit as never, input);
    expect(updateComment).toHaveBeenCalledTimes(2);
  });

  it('migrates a v1 marker when a resolved thread arrives before the next review', async () => {
    const legacy = {
      v: 1 as const,
      lastReviewedSha: 'old',
      baseSha: 'base',
      blockingReviewId: null,
      postedFingerprints: ['bbbbbbbbbbbbbbbb'],
      openCounts: { critical: 0, warning: 0, suggestion: 1, nitpick: 0 },
      runs: [],
    };
    let body = `summary\n${renderStateMarker(legacy)}`;
    const updateComment = vi.fn(async ({ body: nextBody }: { body: string }) => {
      body = nextBody;
    });
    const octokit = {
      issues: {
        listComments: vi.fn(async () => ({
          data: [{ id: 3, body, performed_via_github_app: { id: 1 } }],
        })),
        updateComment,
      },
      graphql: vi.fn(async (query: string) => {
        if (!query.includes('reviewThreads')) return {};
        return {
          repository: {
            pullRequest: {
              reviewThreads: {
                pageInfo: { hasNextPage: false, endCursor: null },
                nodes: [{
                  id: 'thread-legacy',
                  isResolved: true,
                  isOutdated: false,
                  path: 'src/legacy.ts',
                  comments: { nodes: [{ body: `**[suggestion]** old\n${fingerprintMarker('bbbbbbbbbbbbbbbb')}` }] },
                }],
              },
            },
          },
        };
      }),
    };

    await handleFiscalcrThreadEvent(octokit as never, {
      owner: 'o',
      repo: 'r',
      pullNumber: 1,
      headSha: 'new',
      threadId: 'thread-legacy',
      action: 'resolved',
      eventId: 'delivery-legacy',
    });

    const migrated = parseStateMarker(body);
    expect(migrated?.v).toBe(2);
    if (migrated?.v === 2) {
      expect(migrated.migratedFromV1).toBe(true);
      expect(migrated.findings[0]).toMatchObject({
        fingerprint: 'bbbbbbbbbbbbbbbb',
        status: 'dismissed',
        threadId: 'thread-legacy',
      });
    }
    expect(updateComment).toHaveBeenCalledTimes(1);
  });

  it('serializes concurrent resolutions for the same pull request', async () => {
    const finding = (fingerprint: string, threadId: string) => ({
      fingerprint,
      status: 'open' as const,
      severity: 'warning' as const,
      path: `src/${threadId}.ts`,
      startLine: 1,
      endLine: 1,
      title: threadId,
      threadId,
      lastSeenSha: 'old',
      transitions: [{ status: 'open' as const, at: 'one', source: 'review' as const }],
    });
    const state: ReviewState = {
      v: 2,
      lastReviewedSha: 'old',
      baseSha: 'base',
      blockingReviewId: null,
      findings: [
        finding('cccccccccccccccc', 'thread-1'),
        finding('dddddddddddddddd', 'thread-2'),
      ],
      recentEvents: [],
      autoResolvedThreads: [],
      checkRunId: null,
      checkRunHeadSha: null,
      runs: [],
    };
    let body = `summary\n${renderStateMarker(state)}`;
    const updateComment = vi.fn(async ({ body: nextBody }: { body: string }) => {
      body = nextBody;
    });
    const octokit = {
      issues: {
        listComments: vi.fn(async () => ({
          data: [{ id: 3, body, performed_via_github_app: { id: 1 } }],
        })),
        updateComment,
      },
      graphql: vi.fn(async (query: string) => {
        if (!query.includes('reviewThreads')) return {};
        return {
          repository: {
            pullRequest: {
              reviewThreads: {
                pageInfo: { hasNextPage: false, endCursor: null },
                nodes: [
                  ['thread-1', 'cccccccccccccccc'],
                  ['thread-2', 'dddddddddddddddd'],
                ].map(([id, fingerprint]) => ({
                  id,
                  isResolved: true,
                  isOutdated: false,
                  path: `src/${id}.ts`,
                  comments: { nodes: [{ body: `**[warning]** issue\n${fingerprintMarker(fingerprint)}` }] },
                })),
              },
            },
          },
        };
      }),
    };

    await Promise.all([
      handleFiscalcrThreadEvent(octokit as never, {
        owner: 'o', repo: 'r', pullNumber: 1, headSha: 'new',
        threadId: 'thread-1', action: 'resolved', eventId: 'delivery-1',
      }),
      handleFiscalcrThreadEvent(octokit as never, {
        owner: 'o', repo: 'r', pullNumber: 1, headSha: 'new',
        threadId: 'thread-2', action: 'resolved', eventId: 'delivery-2',
      }),
    ]);

    const finalState = parseStateMarker(body);
    expect(finalState?.v).toBe(2);
    if (finalState?.v === 2) expect(finalState.findings.every((finding) => finding.status === 'dismissed')).toBe(true);
    expect(updateComment).toHaveBeenCalledTimes(2);
  });
});
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
});

describe('FiscalCR review-thread lifecycle webhook', () => {
  it('dismisses an open current FiscalCR thread once and ignores unresolved events', async () => {
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
    const graphql = vi.fn(async (query: string) => {
      if (query.includes('reviewThreads')) {
        return {
          repository: {
            pullRequest: {
              reviewThreads: {
                pageInfo: { hasNextPage: false, endCursor: null },
                nodes: [{
                  id: 'thread-1',
                  isResolved: true,
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
        listComments: vi.fn(async () => ({ data: [{ id: 3, body }] })),
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
    await handleFiscalcrThreadEvent(octokit as never, { ...input, action: 'unresolved' });
    expect(updateComment).toHaveBeenCalledTimes(1);
    await handleFiscalcrThreadEvent(octokit as never, input);
    expect(updateComment).toHaveBeenCalledTimes(1);
  });
});
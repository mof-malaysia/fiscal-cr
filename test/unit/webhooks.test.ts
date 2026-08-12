import { beforeEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_CONFIG } from '../../src/config/defaults.js';
import { createLLMProvider } from '../../src/providers/factory.js';
import { ReviewOrchestrator } from '../../src/review/orchestrator.js';
import { loadConfig } from '../../src/config/loader.js';
import { registerWebhooks } from '../../src/github/webhooks.js';

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

  it('applies App provider before resolving provider-default stage models', async () => {
    const config = structuredClone(DEFAULT_CONFIG);
    config.provider = 'kimi';
    config.modelPreset = 'provider-default';
    config.models = {};
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

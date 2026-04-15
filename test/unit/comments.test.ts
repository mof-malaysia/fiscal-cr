import { describe, expect, it, vi } from 'vitest';
import { createPRReview } from '../../src/github/comments.js';
import type { ReviewResult } from '../../src/types/review.js';

describe('createPRReview', () => {
  it('includes provider and model details in the PR review body', async () => {
    const createReview = vi.fn().mockResolvedValue(undefined);
    const octokit = {
      pulls: {
        createReview,
      },
    } as any;

    const result: ReviewResult = {
      summary: 'Looks good overall.',
      score: 92,
      annotations: [],
      stats: { critical: 0, warning: 0, suggestion: 1, nitpick: 0 },
      tokensUsed: { input: 1200, output: 300, cached: 50 },
    };

    await createPRReview(octokit, {
      owner: 'irfancoder',
      repo: 'kimi-code-reviewer',
      pullNumber: 12,
      commitSha: 'abc123',
      result,
      failOn: 'never',
      provider: 'openai-compatible',
      model: 'anthropic/claude-sonnet-4.6',
      baseUrl: 'https://openrouter.ai/api/v1',
    });

    expect(createReview).toHaveBeenCalledTimes(1);
    const payload = createReview.mock.calls[0][0];

    expect(payload.body).toContain('Provider');
    expect(payload.body).toContain('openrouter');
    expect(payload.body).toContain('Model');
    expect(payload.body).toContain('anthropic/claude-sonnet-4.6');
  });
});

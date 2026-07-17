import { describe, expect, it, vi } from 'vitest';
import { runFastPath } from '../../src/pipeline/fast-path.js';
import { UsageTracker } from '../../src/pipeline/usage.js';
import { DEFAULT_CONFIG } from '../../src/config/defaults.js';
import { ReviewError } from '../../src/utils/errors.js';
import type { LLMCompletionResponse, LLMProvider } from '../../src/providers/interface.js';
import type { PullRequestContext } from '../../src/types/review.js';

function context(): PullRequestContext {
  return {
    owner: 'o',
    repo: 'r',
    pullNumber: 1,
    baseSha: 'base',
    headSha: 'head',
    title: 'Add feature',
    body: 'Does things',
    diff: 'the-diff',
    changedFiles: [
      { filename: 'a.ts', status: 'modified', additions: 2, deletions: 0, patch: '@@ -1 +1,2 @@\n a\n+b' },
    ],
    fileContents: new Map([['a.ts', 'a\nb\n']]),
  };
}

function llmReturning(response: LLMCompletionResponse): LLMProvider {
  return { chatCompletion: vi.fn(async () => response) };
}

describe('runFastPath', () => {
  it('throws an actionable truncation error when the response is cut off at the token cap', async () => {
    const llm = llmReturning({
      content: '{"summary":"ok","findings":[', // truncated, unparseable
      usage: { input: 100, output: 8192, cached: 0 },
      finishReason: 'length',
    });

    await expect(
      runFastPath(llm, context(), DEFAULT_CONFIG, new UsageTracker()),
    ).rejects.toThrow(/truncated at the output-token cap/);

    await expect(
      runFastPath(llm, context(), DEFAULT_CONFIG, new UsageTracker()),
    ).rejects.toBeInstanceOf(ReviewError);
  });

  it('parses a complete response normally', async () => {
    const llm = llmReturning({
      content: '{"summary":"looks good","score":95,"findings":[]}',
      usage: { input: 100, output: 50, cached: 0 },
      finishReason: 'stop',
    });

    const result = await runFastPath(llm, context(), DEFAULT_CONFIG, new UsageTracker());
    expect(result.summary).toBe('looks good');
    expect(result.score).toBe(95);
    expect(result.annotations).toEqual([]);
  });
});

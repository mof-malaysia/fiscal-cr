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
  it('salvages the complete findings when the response is truncated mid-array', async () => {
    // Two complete findings, then a third cut off — the model hit the token cap.
    const llm = llmReturning({
      content:
        '{"summary":"partial","score":80,"findings":[' +
        '{"path":"a.ts","startLine":1,"severity":"warning","category":"bug","title":"one"},' +
        '{"path":"a.ts","startLine":2,"severity":"suggestion","category":"style","title":"two"},' +
        '{"path":"a.ts","startLine":3,"severity":"war', // truncated here
      usage: { input: 100, output: 16384, cached: 0 },
      finishReason: 'length',
    });

    const result = await runFastPath(llm, context(), DEFAULT_CONFIG, new UsageTracker());
    // The two fully-emitted findings survive; the partial third is dropped.
    expect(result.annotations).toHaveLength(2);
    expect(result.annotations.map((a) => a.title)).toEqual(['one', 'two']);
    expect(result.summary).toBe('partial');
  });

  it('throws an actionable truncation error when nothing can be salvaged', async () => {
    const llm = llmReturning({
      content: '{"summary":"', // truncated before any complete value
      usage: { input: 100, output: 16384, cached: 0 },
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

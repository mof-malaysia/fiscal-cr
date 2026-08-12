import { describe, expect, it, vi } from 'vitest';
import { runFastPath } from '../../src/pipeline/fast-path.js';
import { UsageTracker, type TelemetryEvent } from '../../src/pipeline/usage.js';
import { DEFAULT_CONFIG } from '../../src/config/defaults.js';
import { ReviewError } from '../../src/utils/errors.js';
import type { ChatCompletionParams, LLMCompletionResponse, LLMProvider } from '../../src/providers/interface.js';
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

  it('records a failed attempted call when the provider rejects', async () => {
    const error = new Error('provider unavailable');
    const llm: LLMProvider = { chatCompletion: vi.fn(async () => Promise.reject(error)) };
    const events: TelemetryEvent[] = [];
    const usage = new UsageTracker((event) => {
      events.push(event);
    });

    await expect(runFastPath(llm, context(), DEFAULT_CONFIG, usage)).rejects.toBe(error);

    expect(usage.calls()).toBe(1);
    expect(events).toEqual([
      { type: 'stage_result', stage: 'fast-path', status: 'failed' },
    ]);
  });

  it('routes to the fastPath stage model and resolves temperature/max-output from it', async () => {
    const chatCompletion = vi.fn(async () => ({
      content: '{"summary":"looks good","score":95,"findings":[]}',
      usage: { input: 100, output: 50, cached: 0 },
      finishReason: 'stop',
    }));
    const llm: LLMProvider = { chatCompletion };

    // fastPath stage model is a non-pinned, non-Kimi model: preferred temperature + conservative cap.
    const config = {
      ...DEFAULT_CONFIG,
      provider: 'openai-compatible' as const,
      baseUrl: 'https://api.example.com/v1',
      models: { fastPath: 'Qwen/Qwen2.5-3B' },
    };
    await runFastPath(llm, context(), config, new UsageTracker());

    const params = chatCompletion.mock.calls[0][0] as ChatCompletionParams;
    expect(params.model).toBe('Qwen/Qwen2.5-3B');
    expect(params.temperature).toBe(0.3);
    expect(params.maxTokens).toBe(32_768);
  });

  it('falls back to the top-level model and its temperature/max-output behavior when fastPath is unset', async () => {
    const chatCompletion = vi.fn(async () => ({
      content: '{"summary":"looks good","score":95,"findings":[]}',
      usage: { input: 100, output: 50, cached: 0 },
      finishReason: 'stop',
    }));
    const llm: LLMProvider = { chatCompletion };

    // Legacy config: no stage overrides → top-level model pins its temperature and gets the Kimi cap.
    const config = { ...DEFAULT_CONFIG, modelPreset: undefined, models: {}, model: 'kimi-for-coding' };
    await runFastPath(llm, context(), config, new UsageTracker());

    const params = chatCompletion.mock.calls[0][0] as ChatCompletionParams;
    expect(params.model).toBe('kimi-for-coding');
    expect(params.temperature).toBeUndefined();
    expect(params.maxTokens).toBe(65_536);
  });

  it('routes to the anthropic preset fastPath model with preferred temperature and conservative cap', async () => {
    const chatCompletion = vi.fn(async () => ({
      content: '{"summary":"looks good","score":95,"findings":[]}',
      usage: { input: 100, output: 50, cached: 0 },
      finishReason: 'stop',
    }));
    const llm: LLMProvider = { chatCompletion };

    const config = {
      ...DEFAULT_CONFIG,
      provider: 'anthropic' as const,
      modelPreset: 'anthropic',
      models: {},
      model: 'legacy-model',
    };
    await runFastPath(llm, context(), config, new UsageTracker());

    const params = chatCompletion.mock.calls[0][0] as ChatCompletionParams;
    expect(params.model).toBe('claude-sonnet-5');
    expect(params.temperature).toBe(0.3);
    expect(params.maxTokens).toBe(32_768);
  });

  it('routes to the openai preset fastPath model, omitting temperature for the reasoning model', async () => {
    const chatCompletion = vi.fn(async () => ({
      content: '{"summary":"looks good","score":95,"findings":[]}',
      usage: { input: 100, output: 50, cached: 0 },
      finishReason: 'stop',
    }));
    const llm: LLMProvider = { chatCompletion };

    const config = {
      ...DEFAULT_CONFIG,
      provider: 'openai' as const,
      modelPreset: 'openai',
      models: {},
      model: 'legacy-model',
    };
    await runFastPath(llm, context(), config, new UsageTracker());

    const params = chatCompletion.mock.calls[0][0] as ChatCompletionParams;
    expect(params.model).toBe('gpt-5.6-terra');
    expect(params.temperature).toBeUndefined();
    expect(params.maxTokens).toBe(32_768);
  });

  it('provider-default selects the kimi preset fastPath model for the kimi provider', async () => {
    const chatCompletion = vi.fn(async () => ({
      content: '{"summary":"looks good","score":95,"findings":[]}',
      usage: { input: 100, output: 50, cached: 0 },
      finishReason: 'stop',
    }));
    const llm: LLMProvider = { chatCompletion };

    const config = {
      ...DEFAULT_CONFIG,
      provider: 'kimi' as const,
      modelPreset: 'provider-default',
      models: {},
      model: 'legacy-model',
    };
    await runFastPath(llm, context(), config, new UsageTracker());

    const params = chatCompletion.mock.calls[0][0] as ChatCompletionParams;
    expect(params.model).toBe('k3-256k');
    expect(params.temperature).toBeUndefined();
    expect(params.maxTokens).toBe(65_536);
  });

  it('routes to a custom preset fastPath model and falls back for unset stages', async () => {
    const chatCompletion = vi.fn(async () => ({
      content: '{"summary":"looks good","score":95,"findings":[]}',
      usage: { input: 100, output: 50, cached: 0 },
      finishReason: 'stop',
    }));
    const llm: LLMProvider = { chatCompletion };

    // Custom presets may be partial: only fastPath is pinned, so the fast path call
    // resolves to the custom value while everything else stays on the top-level model.
    const config = {
      ...DEFAULT_CONFIG,
      provider: 'openai-compatible' as const,
      baseUrl: 'https://api.example.com/v1',
      modelPreset: 'team',
      modelPresets: { team: { fastPath: 'team-fast-path' } },
      models: {},
      model: 'legacy-model',
    };
    await runFastPath(llm, context(), config, new UsageTracker());

    const params = chatCompletion.mock.calls[0][0] as ChatCompletionParams;
    expect(params.model).toBe('team-fast-path');
    expect(params.temperature).toBe(0.3);
    expect(params.maxTokens).toBe(32_768);
  });
});

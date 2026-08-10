import { describe, expect, it } from 'vitest';
import type { LLMCompletionResponse, LLMProvider } from '../../src/providers/interface.js';
import type { ReviewResult } from '../../src/types/review.js';
import {
  REQUIRED_CONTRACT_KEYS,
  associateCallStages,
  buildRunMetrics,
  captureFromError,
  captureFromResponse,
  promptCallMetadata,
  wrapCapturingProvider,
  type CapturedCall,
  type RunMetrics,
} from '../metrics.js';

// ---------------------------------------------------------------------------
// Fixtures / helpers

const CHANGED_PATHS = ['src/utils/retry.ts', 'src/utils/cache.ts'];

const FULL_JSON = JSON.stringify({
  intent: 'Adds a Redis cache and retry backoff to the review pipeline.',
  summary: 'Good change overall.',
  score: 82,
  walkthrough: [
    { path: 'src/utils/retry.ts', summary: 'adds backoff' },
    { path: 'src/utils/cache.ts', summary: 'adds a cache' },
  ],
  findings: [
    {
      path: 'src/utils/retry.ts',
      startLine: 13,
      endLine: 13,
      severity: 'warning',
      category: 'bug',
      title: 'sleep is not defined',
      body: 'sleep is not imported or defined anywhere.',
    },
  ],
});

const GOOD_RESULT: ReviewResult = {
  summary: 'Good change overall.',
  score: 82,
  annotations: [
    {
      path: 'src/utils/retry.ts',
      startLine: 13,
      endLine: 13,
      severity: 'warning',
      category: 'bug',
      title: 'sleep is not defined',
      body: 'sleep is not imported or defined anywhere.',
    },
  ],
  stats: { critical: 0, warning: 1, suggestion: 0, nitpick: 0 },
  tokensUsed: { input: 100, output: 50, cached: 0 },
  walkthrough: [
    { path: 'src/utils/retry.ts', summary: 'adds backoff' },
    { path: 'src/utils/cache.ts', summary: 'adds a cache' },
  ],
  intent: 'Adds a Redis cache and retry backoff to the review pipeline.',
  callCount: 1,
};

function response(content: string): LLMCompletionResponse {
  return { content, usage: { input: 100, output: 50, cached: 0 }, finishReason: 'stop' };
}

function fastMetrics(captures: CapturedCall[], result: ReviewResult = GOOD_RESULT): RunMetrics {
  return buildRunMetrics({
    experimental: false,
    pairIndex: 0,
    runIndex: 0,
    durationMs: 1000,
    tokens: { input: 100, output: 50, cached: 0 },
    providerCalls: captures.length,
    captures,
    result,
    route: 'fast-path',
    stageOutcomes: [],
    changedFilePaths: CHANGED_PATHS,
  });
}

function multiMetrics(captures: CapturedCall[], result: ReviewResult = GOOD_RESULT): RunMetrics {
  return buildRunMetrics({
    experimental: false,
    pairIndex: 0,
    runIndex: 0,
    durationMs: 1000,
    tokens: { input: 100, output: 50, cached: 0 },
    providerCalls: captures.length,
    captures,
    result,
    route: 'multi-pass',
    stageOutcomes: [
      { stage: 'intent', status: 'success' },
      { stage: 'group-review', status: 'success', groupIndex: 0 },
      { stage: 'synthesis', status: 'success' },
    ],
    changedFilePaths: CHANGED_PATHS,
  });
}

// ---------------------------------------------------------------------------
// promptCallMetadata

describe('promptCallMetadata', () => {
  it('hashes + measures messages deterministically without storing content', () => {
    const messages = [
      { role: 'system', content: 'You are a reviewer.' },
      { role: 'user', content: 'Review this diff.' },
    ];
    const a = promptCallMetadata(messages);
    const b = promptCallMetadata(messages);
    expect(a).toEqual(b);
    expect(a.messageCount).toBe(2);
    expect(a.chars).toBe('You are a reviewer.'.length + 'Review this diff.'.length);
    expect(a.estimatedTokens).toBeGreaterThan(0);
    expect(a.messages).toHaveLength(2);
    for (const m of a.messages) {
      expect(m.sha256).toMatch(/^[0-9a-f]{64}$/);
      expect(m.chars).toBeGreaterThan(0);
    }
    // Different content => different hash.
    expect(a.messages[0].sha256).not.toBe(
      promptCallMetadata([{ role: 'system', content: 'different' }]).messages[0].sha256,
    );
    // Empty messages => zero counts, no throw.
    expect(promptCallMetadata([])).toEqual({
      messageCount: 0,
      chars: 0,
      estimatedTokens: 0,
      messages: [],
    });
  });
});

// ---------------------------------------------------------------------------
// captureFromError

describe('captureFromError', () => {
  it('records a failed call with zeroed usage and no raw content', () => {
    const capture = captureFromError(
      { code: 'ECONNRESET', message: 'connection reset' },
      1,
      250,
      promptCallMetadata([{ role: 'user', content: 'prompt' }]),
    );
    expect(capture.failed).toBe(true);
    expect(capture.error).toEqual({ code: 'ECONNRESET', message: 'connection reset' });
    expect(capture.rawChars).toBe(0);
    expect(capture.usage).toEqual({ input: 0, output: 0, cached: 0 });
    expect(capture.parseSuccess).toBe(false);
    expect(capture.generatedFindings).toBe(0);
    expect(capture.topLevelKeys).toEqual([]);
    expect(capture.request?.messageCount).toBe(1);
    expect(capture.finishReason).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// wrapCapturingProvider

describe('wrapCapturingProvider', () => {
  it('captures request metadata before awaiting and response metadata on success', async () => {
    const calls: Array<{ order: number; hasRequest: boolean; hasResponse: boolean; hasError: boolean }> = [];
    const inner: LLMProvider = {
      chatCompletion: async (params) => {
        expect(params.messages.length).toBeGreaterThan(0);
        return response(FULL_JSON);
      },
    };
    const wrapped = wrapCapturingProvider(inner, (info) =>
      calls.push({
        order: info.order,
        hasRequest: info.request !== undefined,
        hasResponse: info.response !== undefined,
        hasError: info.error !== undefined,
      }),
    );
    await wrapped.chatCompletion({ messages: [{ role: 'user', content: 'hi' }] } as never);
    expect(calls).toHaveLength(1);
    expect(calls[0]).toEqual({ order: 1, hasRequest: true, hasResponse: true, hasError: false });
  });

  it('captures a sanitized rejection and rethrows the original error', async () => {
    const calls: Array<{ order: number; hasRequest: boolean; hasResponse: boolean; hasError: boolean }> = [];
    const boom = new Error('rate limited');
    const inner: LLMProvider = {
      chatCompletion: async () => {
        throw boom;
      },
    };
    const wrapped = wrapCapturingProvider(inner, (info) =>
      calls.push({
        order: info.order,
        hasRequest: info.request !== undefined,
        hasResponse: info.response !== undefined,
        hasError: info.error !== undefined,
      }),
    );
    await expect(
      wrapped.chatCompletion({ messages: [{ role: 'user', content: 'hi' }] } as never),
    ).rejects.toBe(boom);
    expect(calls).toHaveLength(1);
    expect(calls[0]).toEqual({ order: 1, hasRequest: true, hasResponse: false, hasError: true });
  });

  it('orders calls sequentially across multiple invocations', async () => {
    const orders: number[] = [];
    const inner: LLMProvider = { chatCompletion: async () => response(FULL_JSON) };
    const wrapped = wrapCapturingProvider(inner, (info) => orders.push(info.order));
    await wrapped.chatCompletion({ messages: [] } as never);
    await wrapped.chatCompletion({ messages: [] } as never);
    expect(orders).toEqual([1, 2]);
  });

  it('assigns unique invocation order to concurrent calls settling out of order', async () => {
    const orders: number[] = [];
    let resolveSlow!: (r: LLMCompletionResponse) => void;
    let rejectFast!: (e: Error) => void;
    const inner: LLMProvider = {
      chatCompletion: async (params) =>
        new Promise<LLMCompletionResponse>((resolve, reject) => {
          // Discriminate by the user message: 'slow' resolves last, 'fast' rejects first.
          const tag = params.messages[0]?.content ?? '';
          if (tag === 'slow') {
            resolveSlow = resolve;
          } else {
            rejectFast = reject;
          }
        }),
    };
    const wrapped = wrapCapturingProvider(inner, (info) => orders.push(info.order));

    const slow = wrapped.chatCompletion({ messages: [{ role: 'user', content: 'slow' }] } as never);
    const fast = wrapped.chatCompletion({ messages: [{ role: 'user', content: 'fast' }] } as never);

    // The SECOND invocation's callback fires before the FIRST invocation's:
    // without an immutable pre-await snapshot both would report order 2.
    rejectFast(new Error('rate limited'));
    await expect(fast).rejects.toThrow('rate limited');
    resolveSlow(response(FULL_JSON));
    await expect(slow).resolves.toBeDefined();

    // Both orders are unique and cover 1..2 in whatever settle order.
    expect([...orders].sort((a, b) => a - b)).toEqual([1, 2]);
    expect(new Set(orders).size).toBe(2);
  });
});

// ---------------------------------------------------------------------------
// captureFromResponse

describe('captureFromResponse', () => {
  it('extracts metadata without persisting raw content', () => {
    const capture = captureFromResponse(response(FULL_JSON), 1, 100);
    expect(capture.failed).toBe(false);
    expect(capture.parseSuccess).toBe(true);
    expect(capture.generatedFindings).toBe(1);
    expect(capture.topLevelKeys).toEqual(
      expect.arrayContaining(['intent', 'summary', 'score', 'walkthrough', 'findings']),
    );
    expect(capture.rawChars).toBe(FULL_JSON.length);
    expect(capture.finishReason).toBe('stop');
    expect(capture.usage).toEqual({ input: 100, output: 50, cached: 0 });
  });
});

// ---------------------------------------------------------------------------
// buildRunMetrics — route-aware

describe('buildRunMetrics (fast-path)', () => {
  it('records contract/concision metrics and generated findings from the single response', () => {
    const m = fastMetrics([captureFromResponse(response(FULL_JSON), 1, 100)]);
    expect(m.route).toBe('fast-path');
    expect(m.providerCalls).toBe(1);
    expect(m.parseSuccess).toBe(true);
    expect(m.contractComplete).toBe(true);
    expect(m.generatedFindings).toBe(1);
    expect(m.retainedFindings).toBe(1);
    expect(m.retentionRate).toBe(1);
    expect(m.walkthroughCoverage).toBe(1);
    expect(m.conciseCompliant).toBe(true);
    expect(m.zeroFindingsKind).toBeNull(); // findings present
    expect(m.degraded).toBe(false);
    expect(m.stageOutcomes).toEqual([]);
    expect(m.finishReason).toBe('stop');
  });

  it('classifies zero-finding fast-path runs (genuine vs fallback)', () => {
    const zero = JSON.stringify({
      intent: 'Adds a cache.',
      summary: 'No issues.',
      score: 90,
      walkthrough: [
        { path: 'src/utils/retry.ts', summary: 'a' },
        { path: 'src/utils/cache.ts', summary: 'b' },
      ],
      findings: [],
    });
    expect(fastMetrics([captureFromResponse(response(zero), 1, 100)]).zeroFindingsKind).toBe('genuine');
    expect(fastMetrics([captureFromResponse(response('garbage'), 1, 100)]).zeroFindingsKind).toBe(
      'parser-fallback',
    );
  });
});

describe('buildRunMetrics (multi-pass)', () => {
  it('nulls fast-path-only contract metrics and flattens group findings', () => {
    // Group responses carry a findings array but no fast-path contract keys.
    const group = JSON.stringify({
      summary: 'group 1',
      findings: [
        {
          path: 'src/utils/retry.ts',
          startLine: 13,
          endLine: 13,
          severity: 'warning',
          category: 'bug',
          title: 'sleep is not defined',
          body: 'sleep is not imported or defined anywhere.',
        },
      ],
    });
    const intent = '{"intent":"x"}';
    const synthesis = '{"summary":"synthesis"}';
    const m = multiMetrics([
      { ...captureFromResponse(response(intent), 1, 100), stage: 'intent' },
      { ...captureFromResponse(response(group), 2, 100), stage: 'group-review' },
      { ...captureFromResponse(response(synthesis), 3, 100), stage: 'synthesis' },
    ]);
    expect(m.route).toBe('multi-pass');
    expect(m.providerCalls).toBe(3);
    // Fast-path-only metrics are null — never false evidence.
    expect(m.parseSuccess).toBeNull();
    expect(m.contractComplete).toBeNull();
    expect(m.conciseCompliant).toBeNull();
    expect(m.zeroFindingsKind).toBeNull();
    expect(m.intentWords).toBeNull();
    expect(m.walkthroughCoverage).toBeNull();
    // Generated findings come from flattened group responses.
    expect(m.generatedFindings).toBe(1);
    expect(m.findings).toHaveLength(1);
    // rawChars sums all successful responses.
    expect(m.rawChars).toBe(intent.length + group.length + synthesis.length);
    // Stage outcomes drive the degraded flag.
    expect(m.degraded).toBe(false);
    expect(m.stageOutcomes).toHaveLength(3);
  });

  it('flags degraded when any stage failed but a review was still produced', () => {
    const m = buildRunMetrics({
      experimental: false,
      pairIndex: 0,
      runIndex: 0,
      durationMs: 1000,
      tokens: { input: 100, output: 50, cached: 0 },
      providerCalls: 2,
      captures: [captureFromResponse(response('{}'), 1, 100)],
      result: GOOD_RESULT,
      route: 'multi-pass',
      stageOutcomes: [
        { stage: 'intent', status: 'success' },
        { stage: 'group-review', status: 'failed', groupIndex: 0 },
        { stage: 'synthesis', status: 'success' },
      ],
      changedFilePaths: CHANGED_PATHS,
    });
    expect(m.degraded).toBe(true);
  });

  it('only counts findings from group-review captures, never intent/synthesis', () => {
    // Adversarial: intent and synthesis responses contain findings-shaped JSON.
    const findings = JSON.stringify({ findings: [{ path: 'src/utils/retry.ts', startLine: 1, endLine: 1, severity: 'warning', category: 'bug', title: 'x', body: 'y' }] });
    const group = '{"summary":"group"}';
    const m = multiMetrics([
      { ...captureFromResponse(response(findings), 1, 100), stage: 'intent' },
      { ...captureFromResponse(response(group), 2, 100), stage: 'group-review' },
      { ...captureFromResponse(response(findings), 3, 100), stage: 'synthesis' },
    ]);
    // parseFastPathResponse-style scanning would count 2; stage truth counts 0.
    expect(m.generatedFindings).toBe(0);
    expect(m.findings).toHaveLength(0);
    expect(m.providerCalls).toBe(3);
  });

  it('associateCallStages maps captures to stages in fire order, skipping failures', async () => {
    const ok1 = captureFromResponse(response('{"intent":"a"}'), 1, 100);
    const boom = captureFromError({ code: 'ECONNRESET', message: 'boom' }, 2, 50, promptCallMetadata([]));
    const ok3 = captureFromResponse(response('{"summary":"b"}'), 3, 100);
    const tagged = associateCallStages([ok1, boom, ok3], [
      { stage: 'intent' },
      { stage: 'synthesis' },
    ]);
    expect(tagged[0].stage).toBe('intent');
    // Failed capture keeps stage undefined and consumes no stage.
    expect(tagged[1].stage).toBeUndefined();
    expect(tagged[1].failed).toBe(true);
    expect(tagged[2].stage).toBe('synthesis');
    // Original arrays are not mutated.
    expect(ok1.stage).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// captureFromError inside buildRunMetrics

describe('buildRunMetrics with failed captures', () => {
  it('counts failed calls toward providerCalls but not rawChars/findings', () => {
    const ok = captureFromResponse(response(FULL_JSON), 1, 100);
    const failed = captureFromError({ code: 'ECONNRESET', message: 'reset' }, 2, 50);
    const m = fastMetrics([ok, failed]);
    expect(m.providerCalls).toBe(2);
    expect(m.rawChars).toBe(FULL_JSON.length); // failed call contributes 0
    expect(m.generatedFindings).toBe(1);
    expect(m.degraded).toBe(false); // stage events, not captures, drive degraded
  });
});
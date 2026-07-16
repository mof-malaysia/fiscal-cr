import { describe, expect, it, vi } from 'vitest';
import { ResilientProvider } from '../../src/providers/resilient.js';
import { LLMApiError } from '../../src/utils/errors.js';
import type { ChatCompletionParams, LLMProvider } from '../../src/providers/interface.js';

const OK = { content: '{}', usage: { input: 1, output: 1, cached: 0 } };
const PARAMS: ChatCompletionParams = { messages: [{ role: 'user', content: 'hi' }] };

function providerFailing(errors: unknown[]): LLMProvider & { calls: number } {
  const stub = {
    calls: 0,
    async chatCompletion() {
      const err = errors[stub.calls++];
      if (err) throw err;
      return OK;
    },
  };
  return stub;
}

describe('ResilientProvider', () => {
  it('passes through a successful call', async () => {
    const inner = providerFailing([]);
    const provider = new ResilientProvider(inner);
    await expect(provider.chatCompletion(PARAMS)).resolves.toEqual(OK);
    expect(inner.calls).toBe(1);
  });

  it.each([
    ['429 rate limit', new LLMApiError('rate limited', 429)],
    ['500 server error', new LLMApiError('server error', 500)],
    ['503 unavailable', new LLMApiError('unavailable', 503)],
    ['timeout abort', Object.assign(new Error('aborted'), { name: 'AbortError' })],
    ['network failure', new TypeError('fetch failed')],
  ])('retries on %s', async (_label, error) => {
    const inner = providerFailing([error]);
    const provider = new ResilientProvider(inner, { maxRetries: 2, maxBackoffMs: 1 });
    await expect(provider.chatCompletion(PARAMS)).resolves.toEqual(OK);
    expect(inner.calls).toBe(2);
  });

  it.each([
    ['400 bad request', new LLMApiError('bad request', 400)],
    ['401 unauthorized', new LLMApiError('unauthorized', 401)],
    ['404 not found', new LLMApiError('not found', 404)],
    ['generic error', new Error('logic bug')],
  ])('does not retry on %s', async (_label, error) => {
    const inner = providerFailing([error, error, error, error]);
    const provider = new ResilientProvider(inner, { maxRetries: 3, maxBackoffMs: 1 });
    await expect(provider.chatCompletion(PARAMS)).rejects.toBe(error);
    expect(inner.calls).toBe(1);
  });

  it('gives up after maxRetries and throws the last error', async () => {
    const errors = Array.from({ length: 5 }, (_, i) => new LLMApiError(`fail ${i}`, 500));
    const inner = providerFailing(errors);
    const provider = new ResilientProvider(inner, { maxRetries: 2, maxBackoffMs: 1 });
    await expect(provider.chatCompletion(PARAMS)).rejects.toThrow('fail 2');
    expect(inner.calls).toBe(3); // initial + 2 retries
  });

  it('honors Retry-After for the backoff wait', async () => {
    vi.useFakeTimers();
    try {
      const inner = providerFailing([new LLMApiError('rate limited', 429, '', 5_000)]);
      const provider = new ResilientProvider(inner, { maxRetries: 1 });
      const pending = provider.chatCompletion(PARAMS);
      // guard against unhandled rejection noise while timers are frozen
      pending.catch(() => {});

      await vi.advanceTimersByTimeAsync(4_999);
      expect(inner.calls).toBe(1);
      await vi.advanceTimersByTimeAsync(1);
      await expect(pending).resolves.toEqual(OK);
      expect(inner.calls).toBe(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it('backs off exponentially with jitter within bounds', async () => {
    vi.useFakeTimers();
    try {
      const inner = providerFailing([
        new LLMApiError('a', 500),
        new LLMApiError('b', 500),
      ]);
      const provider = new ResilientProvider(inner, { maxRetries: 3 });
      const pending = provider.chatCompletion(PARAMS);
      pending.catch(() => {});

      // attempt 0: delay in [500, 1000]
      await vi.advanceTimersByTimeAsync(1_000);
      expect(inner.calls).toBe(2);
      // attempt 1: delay in [1000, 2000]
      await vi.advanceTimersByTimeAsync(2_000);
      await expect(pending).resolves.toEqual(OK);
      expect(inner.calls).toBe(3);
    } finally {
      vi.useRealTimers();
    }
  });
});

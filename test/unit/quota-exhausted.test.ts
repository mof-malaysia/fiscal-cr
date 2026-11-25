import { describe, expect, it } from 'vitest';
import { isApiQuotaExhausted, LLMApiError, ReviewError } from '../../src/utils/errors.js';

const quotaBody = JSON.stringify({
  type: 'error',
  error: {
    type: 'invalid_request_error',
    message: 'You have reached your specified API usage limits. You will regain access on 2026-12-01 at 00:00 UTC.',
  },
});

describe('isApiQuotaExhausted', () => {
  it('matches the Anthropic usage-limit 400', () => {
    const err = new LLMApiError('Anthropic API error: 400 Bad Request', 400, quotaBody);
    expect(isApiQuotaExhausted(err)).toBe(true);
  });

  it('matches OpenAI-style insufficient_quota on 429', () => {
    expect(isApiQuotaExhausted(new LLMApiError('x', 429, '{"error":{"code":"insufficient_quota"}}'))).toBe(true);
  });

  it('matches any 402 Payment Required', () => {
    expect(isApiQuotaExhausted(new LLMApiError('x', 402, '{"error":{"message":"Insufficient Balance"}}'))).toBe(true);
  });

  it('sees through ReviewError.cause', () => {
    const cause = new LLMApiError('x', 400, quotaBody);
    expect(isApiQuotaExhausted(new ReviewError('All review groups failed', 'review-pass', cause))).toBe(true);
  });

  it('does not match other API or non-API errors', () => {
    expect(isApiQuotaExhausted(new LLMApiError('bad schema', 400, '{"error":{"message":"max_tokens too large"}}'))).toBe(false);
    expect(isApiQuotaExhausted(new LLMApiError('usage limit', 500, quotaBody))).toBe(false);
    expect(isApiQuotaExhausted(new ReviewError('boom', 'x'))).toBe(false);
    expect(isApiQuotaExhausted('usage limits')).toBe(false);
  });
});

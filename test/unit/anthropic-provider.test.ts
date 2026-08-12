import { afterEach, describe, expect, it, vi } from 'vitest';
import { AnthropicProvider } from '../../src/providers/anthropic.js';

const response = (body: unknown, init?: ResponseInit) =>
  new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
    ...init,
  });

describe('AnthropicProvider', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('lowers system messages and normalizes native usage', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
      response({
        content: [
          { type: 'thinking', thinking: 'internal' },
          { type: 'text', text: '{"summary":"ok"}' },
        ],
        stop_reason: 'max_tokens',
        usage: {
          input_tokens: 100,
          cache_read_input_tokens: 20,
          cache_creation_input_tokens: 5,
          output_tokens: 7,
        },
      }),
    );

    const provider = new AnthropicProvider({
      apiKey: 'test-key',
      model: 'claude-sonnet-4.5',
      baseUrl: 'https://api.anthropic.com/v1/',
      userAgent: 'FiscalCR-Test/1.0',
      modelParams: { top_p: 0.9, max_tokens: 1 },
    });
    const result = await provider.chatCompletion({
      messages: [
        { role: 'system', content: 'You are a code reviewer.' },
        { role: 'user', content: 'Review this change.' },
      ],
      responseFormat: { type: 'json_object' },
      maxTokens: 2_048,
      temperature: 0.3,
    });

    expect(fetchMock).toHaveBeenCalledWith(
      'https://api.anthropic.com/v1/messages',
      expect.objectContaining({
        headers: expect.objectContaining({
          'X-Api-Key': 'test-key',
          'anthropic-version': '2023-06-01',
          'User-Agent': 'FiscalCR-Test/1.0',
        }),
      }),
    );
    const body = JSON.parse(String(fetchMock.mock.calls[0][1]?.body));
    expect(body.model).toBe('claude-sonnet-4.5');
    expect(body.max_tokens).toBe(2_048);
    expect(body.max_tokens).not.toBe(1);
    expect(body.top_p).toBe(0.9);
    expect(body.temperature).toBe(0.3);
    expect(body.system).toContain('You are a code reviewer.');
    expect(body.system).toContain('single valid JSON object');
    expect(body.messages).toEqual([{ role: 'user', content: 'Review this change.' }]);
    expect(body.response_format).toBeUndefined();

    expect(result).toEqual({
      content: '{"summary":"ok"}',
      usage: { input: 125, output: 7, cached: 20 },
      finishReason: 'length',
    });
  });

  it('surfaces Anthropic errors and Retry-After for the resilient wrapper', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
      response({ error: { type: 'rate_limit_error', message: 'slow down' } }, {
        status: 429,
        statusText: 'Too Many Requests',
        headers: { 'retry-after': '3' },
      }),
    );

    const provider = new AnthropicProvider({
      apiKey: 'test-key',
      model: 'claude-sonnet-4.5',
      baseUrl: 'https://api.anthropic.com/v1',
    });

    await expect(provider.chatCompletion({ messages: [{ role: 'user', content: 'hi' }] }))
      .rejects.toMatchObject({ statusCode: 429, retryAfterMs: 3_000 });
  });
});

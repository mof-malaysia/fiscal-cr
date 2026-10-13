import { afterEach, describe, expect, it, vi } from 'vitest';
import { AnthropicProvider, anthropicApiKeyAuth as apiKeyAuth } from '../../src/providers/anthropic.js';
import { bearerAuth } from '../../src/providers/auth.js';

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
      auth: apiKeyAuth('test-key'),
      model: 'claude-sonnet-4.5',
      baseUrl: 'https://api.anthropic.com/v1/',
      userAgent: 'FiscalCR-Test/1.0',
      modelParams: { top_p: 0.9, max_tokens: 1 },
      promptCache: '1h',
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
    expect(body.system).toHaveLength(1);
    expect(body.system[0].text).toContain('You are a code reviewer.');
    expect(body.system[0].text).toContain('single valid JSON object');
    expect(body.system[0].cache_control).toEqual({ type: 'ephemeral', ttl: '1h' });
    expect(body.messages).toEqual([{ role: 'user', content: 'Review this change.' }]);
    expect(body.response_format).toBeUndefined();

    expect(result).toEqual({
      content: '{"summary":"ok"}',
      usage: { input: 125, output: 7, cached: 20, cacheWrite: { tokens: 5, premium: 0.25 } },
      finishReason: 'length',
    });
  });

  it.each([
    ['5m', [{ type: 'text', text: 'sys', cache_control: { type: 'ephemeral' } }]],
    ['off', 'sys'],
  ] as const)('honors promptCache=%s for the system prompt', async (promptCache, expected) => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
      response({ content: [{ type: 'text', text: 'ok' }], usage: { input_tokens: 1, output_tokens: 1 } }),
    );
    const provider = new AnthropicProvider({
      auth: apiKeyAuth('test-key'),
      model: 'claude-sonnet-5-5',
      baseUrl: 'https://api.anthropic.com/v1',
      promptCache,
    });
    await provider.chatCompletion({
      messages: [
        { role: 'system', content: 'sys' },
        { role: 'user', content: 'hi' },
      ],
    });

    const body = JSON.parse(String(fetchMock.mock.calls[0][1]?.body));
    expect(body.system).toEqual(expected);
  });

  it('reports cache writes split by TTL', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
      response({
        content: [{ type: 'text', text: 'ok' }],
        usage: {
          input_tokens: 50,
          cache_creation_input_tokens: 1_000,
          cache_creation: { ephemeral_5m_input_tokens: 0, ephemeral_1h_input_tokens: 1_000 },
          output_tokens: 1,
        },
      }),
    );
    const provider = new AnthropicProvider({
      auth: apiKeyAuth('test-key'),
      model: 'claude-opus-5-5',
      baseUrl: 'https://api.anthropic.com/v1',
    });
    const result = await provider.chatCompletion({ messages: [{ role: 'user', content: 'hi' }] });

    expect(result.usage).toEqual({
      input: 1_050,
      output: 1,
      cached: 0,
      cacheWrite: { tokens: 1_000, premium: 1 },
    });
  });

  it('sends a per-call model override in the request payload', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
      response({
        content: [{ type: 'text', text: 'ok' }],
        usage: { input_tokens: 1, output_tokens: 1 },
      }),
    );

    const provider = new AnthropicProvider({
      auth: apiKeyAuth('test-key'),
      model: 'claude-sonnet-4.5',
      baseUrl: 'https://api.anthropic.com/v1',
    });
    await provider.chatCompletion({
      messages: [{ role: 'user', content: 'hi' }],
      model: 'claude-haiku-4.5',
    });

    const body = JSON.parse(String(fetchMock.mock.calls[0][1]?.body));
    expect(body.model).toBe('claude-haiku-4.5');
  });

  it('uses the constructor model when no per-call override is given', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
      response({
        content: [{ type: 'text', text: 'ok' }],
        usage: { input_tokens: 1, output_tokens: 1 },
      }),
    );

    const provider = new AnthropicProvider({
      auth: apiKeyAuth('test-key'),
      model: 'claude-sonnet-4.5',
      baseUrl: 'https://api.anthropic.com/v1',
    });
    await provider.chatCompletion({ messages: [{ role: 'user', content: 'hi' }] });

    const body = JSON.parse(String(fetchMock.mock.calls[0][1]?.body));
    expect(body.model).toBe('claude-sonnet-4.5');
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
      auth: apiKeyAuth('test-key'),
      model: 'claude-sonnet-4.5',
      baseUrl: 'https://api.anthropic.com/v1',
    });

    await expect(provider.chatCompletion({ messages: [{ role: 'user', content: 'hi' }] }))
      .rejects.toMatchObject({ statusCode: 429, retryAfterMs: 3_000 });
  });
  it('sends the auth source headers instead of an API key', async () => {
    const fetchMock = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(response({ content: [{ type: 'text', text: 'ok' }] }));
    const provider = new AnthropicProvider({
      auth: bearerAuth('sk-ant-oat01-x'),
      model: 'claude-opus-5-5',
      baseUrl: 'https://api.anthropic.com/v1',
    });

    await provider.chatCompletion({ messages: [{ role: 'user', content: 'hi' }] });

    const headers = fetchMock.mock.calls[0]?.[1]?.headers as Record<string, string>;
    expect(headers).toMatchObject({ Authorization: 'Bearer sk-ant-oat01-x' });
    expect(headers).not.toHaveProperty('X-Api-Key');
  });
});

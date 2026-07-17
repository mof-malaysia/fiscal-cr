import { afterEach, describe, expect, it, vi } from 'vitest';
import { OpenAICompatibleProvider } from '../../src/providers/openai-compatible.js';

describe('OpenAICompatibleProvider', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('does not send an explicit max_tokens cap', async () => {
    const fetchMock = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            choices: [{ message: { content: '{"summary":"ok","score":100,"annotations":[]}' } }],
            usage: { prompt_tokens: 1000, completion_tokens: 200, cached_tokens: 0 },
          }),
          { status: 200, statusText: 'OK' },
        ),
      );

    const provider = new OpenAICompatibleProvider({
      apiKey: 'test-key',
      model: 'Qwen/Qwen2.5-3B-Instruct',
      baseUrl: 'https://chat.alifaiman.cloud/v1',
    });

    const result = await provider.chatCompletion({
      messages: [
        { role: 'system', content: 'You are a code reviewer.' },
        {
          role: 'user',
          content: 'Please review this diff and respond in JSON. '.repeat(40),
        },
      ],
      responseFormat: { type: 'json_object' },
    });

    expect(result.content).toContain('summary');
    expect(fetchMock).toHaveBeenCalledTimes(1);

    const body = JSON.parse(String(fetchMock.mock.calls[0][1]?.body));

    expect(body.max_tokens).toBeUndefined();
  });

  it('surfaces finish_reason so truncation is detectable', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          choices: [{ message: { content: '{"summary":"ok"' }, finish_reason: 'length' }],
          usage: { prompt_tokens: 1000, completion_tokens: 8192, cached_tokens: 0 },
        }),
        { status: 200, statusText: 'OK' },
      ),
    );

    const provider = new OpenAICompatibleProvider({
      apiKey: 'k',
      model: 'm',
      baseUrl: 'https://api.example.com/v1',
    });
    const result = await provider.chatCompletion({
      messages: [{ role: 'user', content: 'hi' }],
    });

    expect(result.finishReason).toBe('length');
  });

  it('sends the default User-Agent and client name', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
      new Response(JSON.stringify({ choices: [{ message: { content: 'ok' } }] }), {
        status: 200,
      }),
    );

    const provider = new OpenAICompatibleProvider({
      apiKey: 'k',
      model: 'm',
      baseUrl: 'https://api.example.com/v1',
    });
    await provider.chatCompletion({ messages: [{ role: 'user', content: 'hi' }] });

    const headers = fetchMock.mock.calls[0][1]?.headers as Record<string, string>;
    expect(headers['User-Agent']).toBe('fiscalcr/1.0');
    expect(headers['X-Client-Name']).toBe('fiscalcr');
  });

  it('sends a custom User-Agent verbatim and omits X-Client-Name (whitelisted endpoints)', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
      new Response(JSON.stringify({ choices: [{ message: { content: 'ok' } }] }), {
        status: 200,
      }),
    );

    const provider = new OpenAICompatibleProvider({
      apiKey: 'k',
      model: 'gated-model',
      baseUrl: 'https://api.example.com/v1',
      userAgent: 'MyCodingAgent/2.1.0',
    });
    await provider.chatCompletion({ messages: [{ role: 'user', content: 'hi' }] });

    const headers = fetchMock.mock.calls[0][1]?.headers as Record<string, string>;
    expect(headers['User-Agent']).toBe('MyCodingAgent/2.1.0');
    expect(headers['X-Client-Name']).toBeUndefined();
  });
});

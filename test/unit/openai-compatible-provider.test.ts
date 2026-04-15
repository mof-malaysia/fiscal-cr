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

  it('retries once without structured output when OpenRouter returns an empty completion', async () => {
    const fetchMock = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            choices: [{ message: { content: '' } }],
            usage: { prompt_tokens: 0, completion_tokens: 0, cached_tokens: 0 },
          }),
          { status: 200, statusText: 'OK' },
        ),
      )
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            choices: [{ message: { content: '{"summary":"retry ok","score":90,"annotations":[]}' } }],
            usage: { prompt_tokens: 1200, completion_tokens: 180, cached_tokens: 0 },
          }),
          { status: 200, statusText: 'OK' },
        ),
      );

    const provider = new OpenAICompatibleProvider({
      apiKey: 'test-key',
      model: 'nvidia/nemotron-3-super-120b-a12b:free',
      baseUrl: 'https://openrouter.ai/api/v1',
    });

    const result = await provider.chatCompletion({
      messages: [{ role: 'user', content: 'Review this PR' }],
      responseFormat: { type: 'json_object' },
    });

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(result.content).toContain('retry ok');

    const firstBody = JSON.parse(String(fetchMock.mock.calls[0][1]?.body));
    const secondBody = JSON.parse(String(fetchMock.mock.calls[1][1]?.body));

    expect(firstBody.plugins).toEqual([{ id: 'response-healing' }]);
    expect(secondBody.response_format).toBeUndefined();
  });
});

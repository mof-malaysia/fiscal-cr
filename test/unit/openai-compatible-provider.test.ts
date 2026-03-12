import { afterEach, describe, expect, it, vi } from 'vitest';
import { OpenAICompatibleProvider } from '../../src/providers/openai-compatible.js';

describe('OpenAICompatibleProvider', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('retries with reduced max_tokens when model reports max_total_tokens limit', async () => {
    const initialMaxTokens = 4000;
    const maxTotalTokens = 2048;

    const fetchMock = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            error: {
              message:
                `max_tokens=${initialMaxTokens} cannot be greater than max_model_len=max_total_tokens=${maxTotalTokens}`,
              type: 'BadRequestError',
              param: 'max_tokens',
              code: 400,
            },
          }),
          { status: 400, statusText: 'Bad Request' },
        ),
      )
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
      maxTokens: initialMaxTokens,
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
    expect(fetchMock).toHaveBeenCalledTimes(2);

    const firstBody = JSON.parse(String(fetchMock.mock.calls[0][1]?.body));
    const secondBody = JSON.parse(String(fetchMock.mock.calls[1][1]?.body));

    expect(firstBody.max_tokens).toBe(initialMaxTokens);
    expect(secondBody.max_tokens).toBeLessThan(initialMaxTokens);
    expect(secondBody.max_tokens).toBeGreaterThan(0);
  });
});

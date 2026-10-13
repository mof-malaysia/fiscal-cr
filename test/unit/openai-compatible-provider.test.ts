import { afterEach, describe, expect, it, vi } from 'vitest';
import { bearerAuth } from '../../src/providers/auth.js';
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
      auth: bearerAuth('test-key'),
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
  it('reads cached tokens from OpenRouter prompt token details', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          choices: [{ message: { content: 'ok' } }],
          usage: {
            prompt_tokens: 1_000,
            completion_tokens: 200,
            cached_tokens: 5,
            prompt_tokens_details: { cached_tokens: 800 },
          },
        }),
        { status: 200, statusText: 'OK' },
      ),
    );

    const provider = new OpenAICompatibleProvider({
      auth: bearerAuth('test-key'),
      model: 'meta/muse-spark-1.3-contributor',
      baseUrl: 'https://openrouter.ai/api/v1',
    });

    const result = await provider.chatCompletion({
      messages: [{ role: 'user', content: 'Review this diff.' }],
    });

    expect(result.usage).toEqual({ input: 1_000, output: 200, cached: 800 });
  });

  it('emits max_completion_tokens (not max_tokens) when configured for OpenAI', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
      new Response(JSON.stringify({ choices: [{ message: { content: 'ok' } }] }), {
        status: 200,
      }),
    );

    const provider = new OpenAICompatibleProvider({
      auth: bearerAuth('k'),
      model: 'gpt-5',
      baseUrl: 'https://api.openai.com/v1',
      completionTokenParam: 'max_completion_tokens',
    });
    await provider.chatCompletion({
      messages: [{ role: 'user', content: 'hi' }],
      maxTokens: 4096,
    });

    const body = JSON.parse(String(fetchMock.mock.calls[0][1]?.body));
    expect(body.max_completion_tokens).toBe(4096);
    expect(body.max_tokens).toBeUndefined();
  });

  it('defaults to max_tokens for the completion-token cap', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
      new Response(JSON.stringify({ choices: [{ message: { content: 'ok' } }] }), {
        status: 200,
      }),
    );

    const provider = new OpenAICompatibleProvider({
      auth: bearerAuth('k'),
      model: 'm',
      baseUrl: 'https://api.example.com/v1',
    });
    await provider.chatCompletion({
      messages: [{ role: 'user', content: 'hi' }],
      maxTokens: 4096,
    });

    const body = JSON.parse(String(fetchMock.mock.calls[0][1]?.body));
    expect(body.max_tokens).toBe(4096);
    expect(body.max_completion_tokens).toBeUndefined();
  });

  it('merges operator modelParams into the request body', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
      new Response(JSON.stringify({ choices: [{ message: { content: 'ok' } }] }), {
        status: 200,
      }),
    );

    const provider = new OpenAICompatibleProvider({
      auth: bearerAuth('k'),
      model: 'gpt-5',
      baseUrl: 'https://api.openai.com/v1',
      modelParams: { reasoning_effort: 'high', top_p: 0.9, seed: 42 },
    });
    await provider.chatCompletion({ messages: [{ role: 'user', content: 'hi' }] });

    const body = JSON.parse(String(fetchMock.mock.calls[0][1]?.body));
    expect(body.reasoning_effort).toBe('high');
    expect(body.top_p).toBe(0.9);
    expect(body.seed).toBe(42);
  });

  it('sends release-tuned params for the model, with operator modelParams winning', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockImplementation(
      async () => new Response(JSON.stringify({ choices: [{ message: { content: 'ok' } }] }), { status: 200 }),
    );
    const messages = [{ role: 'user' as const, content: 'hi' }];

    const releaseOnly = new OpenAICompatibleProvider({
      auth: bearerAuth('k'),
      model: 'gpt-6.1-sol',
      baseUrl: 'https://api.openai.com/v1',
    });
    await releaseOnly.chatCompletion({ messages, model: 'gpt-6-luna' });

    const overridden = new OpenAICompatibleProvider({
      auth: bearerAuth('k'),
      model: 'gpt-6.1-sol',
      baseUrl: 'https://api.openai.com/v1',
      modelParams: { reasoning_effort: 'high' },
    });
    await overridden.chatCompletion({ messages, model: 'gpt-6-luna' });

    const bodies = fetchMock.mock.calls.map(([, init]) => JSON.parse(String(init?.body)));
    expect(bodies[0].reasoning_effort).toBe('max');
    expect(bodies[1].reasoning_effort).toBe('high');
  });

  it('strips pipeline-managed keys from modelParams (no re-triggering the max_tokens 400)', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
      new Response(JSON.stringify({ choices: [{ message: { content: 'ok' } }] }), {
        status: 200,
      }),
    );

    const provider = new OpenAICompatibleProvider({
      auth: bearerAuth('k'),
      model: 'gpt-5',
      baseUrl: 'https://api.openai.com/v1',
      completionTokenParam: 'max_completion_tokens',
      modelParams: {
        reasoning_effort: 'low',
        max_tokens: 123,
        temperature: 1.5,
        stream: true,
        model: 'evil-override',
      },
    });
    await provider.chatCompletion({
      messages: [{ role: 'user', content: 'hi' }],
      maxTokens: 4096,
      temperature: 0.3,
    });

    const body = JSON.parse(String(fetchMock.mock.calls[0][1]?.body));
    // Passthrough survives.
    expect(body.reasoning_effort).toBe('low');
    // Reserved keys are dropped / kept under pipeline control.
    expect(body.max_tokens).toBeUndefined();
    expect(body.stream).toBeUndefined();
    expect(body.model).toBe('gpt-5');
    expect(body.max_completion_tokens).toBe(4096);
    expect(body.temperature).toBe(0.3);
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
      auth: bearerAuth('k'),
      model: 'm',
      baseUrl: 'https://api.example.com/v1',
    });
    const result = await provider.chatCompletion({
      messages: [{ role: 'user', content: 'hi' }],
    });

    expect(result.finishReason).toBe('length');
  });

  it('sends a per-call model override in the request payload', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
      new Response(JSON.stringify({ choices: [{ message: { content: 'ok' } }] }), {
        status: 200,
      }),
    );

    const provider = new OpenAICompatibleProvider({
      auth: bearerAuth('k'),
      model: 'constructor-model',
      baseUrl: 'https://api.example.com/v1',
    });
    await provider.chatCompletion({
      messages: [{ role: 'user', content: 'hi' }],
      model: 'fast-model',
    });

    const body = JSON.parse(String(fetchMock.mock.calls[0][1]?.body));
    expect(body.model).toBe('fast-model');
  });

  it('uses the constructor model when no per-call override is given', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
      new Response(JSON.stringify({ choices: [{ message: { content: 'ok' } }] }), {
        status: 200,
      }),
    );

    const provider = new OpenAICompatibleProvider({
      auth: bearerAuth('k'),
      model: 'constructor-model',
      baseUrl: 'https://api.example.com/v1',
    });
    await provider.chatCompletion({ messages: [{ role: 'user', content: 'hi' }] });

    const body = JSON.parse(String(fetchMock.mock.calls[0][1]?.body));
    expect(body.model).toBe('constructor-model');
  });

  it('sends the default User-Agent and client name', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
      new Response(JSON.stringify({ choices: [{ message: { content: 'ok' } }] }), {
        status: 200,
      }),
    );

    const provider = new OpenAICompatibleProvider({
      auth: bearerAuth('k'),
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
      auth: bearerAuth('k'),
      model: 'gated-model',
      baseUrl: 'https://api.example.com/v1',
      userAgent: 'MyCodingAgent/2.1.0',
    });
    await provider.chatCompletion({ messages: [{ role: 'user', content: 'hi' }] });

    const headers = fetchMock.mock.calls[0][1]?.headers as Record<string, string>;
    expect(headers['User-Agent']).toBe('MyCodingAgent/2.1.0');
    expect(headers['X-Client-Name']).toBeUndefined();
  });

  describe('prompt caching', () => {
    function okResponse(promptTokensDetails: Record<string, number> = {}): Response {
      return new Response(
        JSON.stringify({
          choices: [{ message: { content: 'ok' } }],
          usage: {
            prompt_tokens: 2_000,
            completion_tokens: 1,
            prompt_tokens_details: promptTokensDetails,
          },
        }),
        { status: 200 },
      );
    }

    async function send(config: Partial<ConstructorParameters<typeof OpenAICompatibleProvider>[0]>) {
      const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
        okResponse({ cached_tokens: 0, cache_write_tokens: 1_000 }),
      );
      const provider = new OpenAICompatibleProvider({
        auth: bearerAuth('test-key'),
        model: 'anthropic/claude-sonnet-5-5',
        baseUrl: 'https://openrouter.ai/api/v1',
        ...config,
      });
      const result = await provider.chatCompletion({
        messages: [
          { role: 'system', content: 'sys' },
          { role: 'user', content: 'hi' },
        ],
      });
      return { body: JSON.parse(String(fetchMock.mock.calls[0][1]?.body)), result };
    }

    it('marks the system prompt with cache_control and bills writes at the TTL', async () => {
      const { body, result } = await send({ cacheStyle: 'cache-control', promptCache: '1h' });

      expect(body.messages).toEqual([
        {
          role: 'system',
          content: [{ type: 'text', text: 'sys', cache_control: { type: 'ephemeral', ttl: '1h' } }],
        },
        { role: 'user', content: 'hi' },
      ]);
      expect(body.prompt_cache_options).toBeUndefined();
      expect(result.usage).toMatchObject({ cacheWrite1h: 1_000 });
    });

    it('uses the default 5m cache_control shape', async () => {
      const { body, result } = await send({ cacheStyle: 'cache-control', promptCache: '5m' });

      expect(body.messages[0].content[0].cache_control).toEqual({ type: 'ephemeral' });
      expect(result.usage).toMatchObject({ cacheWrite5m: 1_000 });
    });

    it('sends prompt_cache_options to Kimi; 5m writes carry no premium', async () => {
      const oneHour = await send({ cacheStyle: 'kimi', promptCache: '1h' });
      expect(oneHour.body.prompt_cache_options).toEqual({ mode: 'implicit', ttl: '1h' });
      expect(oneHour.body.messages[0]).toEqual({ role: 'system', content: 'sys' });
      expect(oneHour.result.usage).toMatchObject({ cacheWrite1h: 1_000 });

      const fiveMinutes = await send({ cacheStyle: 'kimi', promptCache: '5m' });
      expect(fiveMinutes.body.prompt_cache_options).toEqual({ mode: 'implicit', ttl: '5m' });
      expect(fiveMinutes.result.usage.cacheWrite5m).toBeUndefined();
      expect(fiveMinutes.result.usage.cacheWrite1h).toBeUndefined();
    });

    it.each([
      ['automatic', '1h'],
      ['cache-control', 'off'],
      ['cache-control', undefined],
    ] as const)('sends no cache hint for cacheStyle=%s, promptCache=%s', async (cacheStyle, promptCache) => {
      const { body } = await send({ cacheStyle, promptCache });

      expect(body.messages[0]).toEqual({ role: 'system', content: 'sys' });
      expect(body.prompt_cache_options).toBeUndefined();
    });

    it('bills automatic-cache writes (OpenAI GPT-5.6+) at the 1.25x premium', async () => {
      const { result } = await send({ cacheStyle: 'automatic' });

      expect(result.usage).toMatchObject({ cacheWrite5m: 1_000 });
    });
  });
});

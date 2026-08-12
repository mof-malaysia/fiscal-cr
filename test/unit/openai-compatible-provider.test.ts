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

  it('emits max_completion_tokens (not max_tokens) when configured for OpenAI', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
      new Response(JSON.stringify({ choices: [{ message: { content: 'ok' } }] }), {
        status: 200,
      }),
    );

    const provider = new OpenAICompatibleProvider({
      apiKey: 'k',
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
      apiKey: 'k',
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
      apiKey: 'k',
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

  it('strips pipeline-managed keys from modelParams (no re-triggering the max_tokens 400)', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
      new Response(JSON.stringify({ choices: [{ message: { content: 'ok' } }] }), {
        status: 200,
      }),
    );

    const provider = new OpenAICompatibleProvider({
      apiKey: 'k',
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
      apiKey: 'k',
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
      apiKey: 'k',
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
      apiKey: 'k',
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

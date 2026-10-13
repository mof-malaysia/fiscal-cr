import { afterEach, describe, expect, it, vi } from 'vitest';
import { ConfigError } from '../../src/utils/errors.js';
import { createLLMProvider } from '../../src/providers/factory.js';

describe('provider factory', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('creates provider for openai-compatible', () => {
    const provider = createLLMProvider({
      apiKey: 'test-key',
      provider: 'openai-compatible',
      model: 'gpt-4.1-mini',
      baseUrl: 'https://api.openai.com/v1',
    });

    expect(provider).toBeTruthy();
    expect(typeof provider.chatCompletion).toBe('function');
  });

  it('throws ConfigError when openai-compatible has no baseUrl', () => {
    expect(() =>
      createLLMProvider({
        apiKey: 'test-key',
        provider: 'openai-compatible',
        model: 'gpt-4.1-mini',
      }),
    ).toThrowError(ConfigError);

    expect(() =>
      createLLMProvider({
        apiKey: 'test-key',
        provider: 'openai-compatible',
        model: 'gpt-4.1-mini',
      }),
    ).toThrow(/Missing baseUrl/);
  });

  it('creates the openai provider without an explicit baseUrl (default applies)', () => {
    const provider = createLLMProvider({
      apiKey: 'test-key',
      provider: 'openai',
      model: 'gpt-5',
    });

    expect(provider).toBeTruthy();
    expect(typeof provider.chatCompletion).toBe('function');
  });
  it('creates the Anthropic provider with its native Messages endpoint', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
      new Response(JSON.stringify({ content: [{ type: 'text', text: 'ok' }] }), {
        status: 200,
      }),
    );
    const provider = createLLMProvider({
      apiKey: 'test-key',
      provider: 'anthropic',
      model: 'claude-sonnet-4.5',
    });

    await provider.chatCompletion({ messages: [{ role: 'user', content: 'hi' }] });

    expect(fetchMock.mock.calls[0]?.[0]).toBe('https://api.anthropic.com/v1/messages');
  });

  it.each([
    [undefined, [{ type: 'text', text: 'sys', cache_control: { type: 'ephemeral', ttl: '1h' } }]],
    ['5m', [{ type: 'text', text: 'sys', cache_control: { type: 'ephemeral' } }]],
    ['off', 'sys'],
  ] as const)(
    'applies the Anthropic prompt-cache default unless overridden (promptCache=%s)',
    async (promptCache, expected) => {
      const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
        new Response(JSON.stringify({ content: [{ type: 'text', text: 'ok' }] }), { status: 200 }),
      );
      const provider = createLLMProvider({
        apiKey: 'test-key',
        provider: 'anthropic',
        model: 'claude-sonnet-5-5',
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
    },
  );


  it('threads modelParams through to the provider for any provider', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockImplementation(
      async () =>
        new Response(JSON.stringify({ choices: [{ message: { content: 'ok' } }] }), {
          status: 200,
        }),
    );

    for (const provider of ['openai', 'kimi', 'anthropic'] as const) {
      const llm = createLLMProvider({
        apiKey: 'test-key',
        provider,
        model:
          provider === 'openai'
            ? 'gpt-5'
            : provider === 'kimi'
              ? 'kimi-for-coding'
              : 'claude-sonnet-4.5',
        modelParams: { reasoning_effort: 'high' },
      });
      await llm.chatCompletion({ messages: [{ role: 'user', content: 'hi' }] });
    }

    for (const call of fetchMock.mock.calls) {
      const body = JSON.parse(String(call[1]?.body));
      expect(body.reasoning_effort).toBe('high');
    }
  });

  it('throws ConfigError for invalid provider', () => {
    expect(() =>
      createLLMProvider({
        apiKey: 'test-key',
        provider: 'invalid-provider',
        model: 'any-model',
      }),
    ).toThrowError(ConfigError);

    expect(() =>
      createLLMProvider({
        apiKey: 'test-key',
        provider: 'invalid-provider',
        model: 'any-model',
      }),
    ).toThrow(/Invalid provider/);
  });
  const federation = {
    exchange: {
      type: 'anthropic' as const,
      federationRuleId: 'fdrl_1',
      organizationId: 'org-uuid',
      serviceAccountId: 'svac_1',
    },
    getIdentityToken: async () => 'jwt',
  };

  it('exchanges a federated token for the Anthropic provider', async () => {
    const fetchMock = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ access_token: 'sk-ant-oat01-x', expires_in: 600 }), { status: 200 }),
      )
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ content: [{ type: 'text', text: 'ok' }] }), { status: 200 }),
      );
    const provider = createLLMProvider({
      federation,
      provider: 'anthropic',
      model: 'claude-opus-5-5',
    });

    await provider.chatCompletion({ messages: [{ role: 'user', content: 'hi' }] });

    expect(fetchMock.mock.calls[0]?.[0]).toBe('https://api.anthropic.com/v1/oauth/token');
    expect(fetchMock.mock.calls[1]?.[0]).toBe('https://api.anthropic.com/v1/messages');
    expect(fetchMock.mock.calls[1]?.[1]?.headers).toMatchObject({
      Authorization: 'Bearer sk-ant-oat01-x',
    });
  });


  it('requires exactly one credential', () => {
    expect(() =>
      createLLMProvider({ provider: 'anthropic', model: 'claude-opus-5-5' }),
    ).toThrowError(ConfigError);
    expect(() =>
      createLLMProvider({
        apiKey: 'k',
        federation,
        provider: 'anthropic',
        model: 'claude-opus-5-5',
      }),
    ).toThrow(/not both/);
  });
});

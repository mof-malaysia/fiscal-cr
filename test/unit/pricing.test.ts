import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  calculateCostWithPricing,
  FALLBACK_TOKEN_PRICING,
  resolvePricing,
  resolvePricingAsync,
} from '../../src/utils/pricing.js';

describe('resolvePricing', () => {
  it('resolves an exact OpenAI model price', () => {
    expect(resolvePricing({ provider: 'openai', model: 'gpt-4.1-mini' })).toMatchObject({
      source: 'exact',
      matchedModel: 'gpt-4.1-mini',
      pricing: {
        inputPerMillion: 0.4,
        outputPerMillion: 1.6,
        cachedInputPerMillion: 0.1,
      },
    });
  });

  it('resolves a versioned model through its family price', () => {
    expect(resolvePricing({ provider: 'anthropic', model: 'claude-sonnet-4.5-20250929' })).toMatchObject({
      source: 'family',
      matchedModel: 'claude-sonnet-4.5',
    });
  });
  it('resolves the GPT-5.6 Luna, Terra, Sol, and Claude 5 families', () => {
    expect(resolvePricing({ provider: 'openai', model: 'gpt-5.6-luna-20260709' })).toMatchObject({
      source: 'family',
      matchedModel: 'gpt-5.6-luna',
      pricing: { inputPerMillion: 0.1, outputPerMillion: 0.6 },
    });
    expect(resolvePricing({ provider: 'openai', model: 'gpt-5.6-terra-20260709' })).toMatchObject({
      source: 'family',
      matchedModel: 'gpt-5.6-terra',
      pricing: { inputPerMillion: 1, outputPerMillion: 6 },
    });
    expect(resolvePricing({ provider: 'openai', model: 'gpt-5.6-sol-20260709' })).toMatchObject({
      source: 'family',
      matchedModel: 'gpt-5.6-sol',
    });
    expect(resolvePricing({ provider: 'anthropic', model: 'claude-opus-5-20260723' })).toMatchObject({
      source: 'family',
      matchedModel: 'claude-opus-5',
    });
  });

  it('resolves current Kimi Open Platform models without collapsing their rates', () => {
    expect(resolvePricing({ provider: 'kimi', model: 'kimi-k3' })).toMatchObject({
      source: 'exact',
      matchedModel: 'kimi-k3',
      pricing: { inputPerMillion: 3, outputPerMillion: 15, cachedInputPerMillion: 0.3 },
    });
    expect(resolvePricing({ provider: 'kimi', model: 'kimi-k2.6' })).toMatchObject({
      source: 'exact',
      matchedModel: 'kimi-k2.6',
      pricing: { inputPerMillion: 0.95, outputPerMillion: 4, cachedInputPerMillion: 0.16 },
    });
    expect(resolvePricing({ provider: 'kimi', model: 'kimi-k2.7-code' })).toMatchObject({
      source: 'exact',
      matchedModel: 'kimi-k2.7-code',
      pricing: { inputPerMillion: 0.95, outputPerMillion: 4, cachedInputPerMillion: 0.19 },
    });
    expect(resolvePricing({ provider: 'kimi', model: 'kimi-k2.7-code-highspeed' })).toMatchObject({
      source: 'exact',
      matchedModel: 'kimi-k2.7-code-highspeed',
      pricing: { inputPerMillion: 1.9, outputPerMillion: 8, cachedInputPerMillion: 0.38 },
    });
  });

  it('uses OpenRouter pricing for an OpenRouter endpoint', () => {
    expect(resolvePricing({
      provider: 'openai-compatible',
      baseUrl: 'https://openrouter.ai/api/v1',
      model: 'openai/gpt-4.1-mini:online',
    })).toMatchObject({ source: 'exact', matchedModel: 'openai/gpt-4.1-mini' });
  });

  it('uses the fallback for unknown custom endpoints', () => {
    expect(resolvePricing({ provider: 'openai-compatible', model: 'vendor/private-model' })).toMatchObject({
      source: 'fallback',
      pricing: FALLBACK_TOKEN_PRICING,
    });
  });
});
afterEach(() => {
  vi.unstubAllGlobals();
});

describe('resolvePricingAsync', () => {
  it('fetches and caches an unknown OpenRouter model price', async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({
      data: {
        id: 'vendor/future-model',
        pricing: {
          prompt: '0.000003',
          completion: '0.000012',
          input_cache_read: '0.0000003',
          overrides: [{
            min_prompt_tokens: 272_000,
            prompt: '0.000006',
            completion: '0.000024',
            input_cache_read: '0.0000006',
          }],
        },
      },
    }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    }));
    vi.stubGlobal('fetch', fetchMock);

    const context = {
      provider: 'openai-compatible',
      baseUrl: 'https://openrouter.ai/api/v1',
      model: 'vendor/future-model',
    };
    const first = await resolvePricingAsync(context);
    const second = await resolvePricingAsync(context);

    expect(first).toMatchObject({
      source: 'remote',
      matchedModel: 'vendor/future-model',
      pricing: {
        inputPerMillion: 3,
        outputPerMillion: 12,
        cachedInputPerMillion: 0.3,
        tiers: [{
          minPromptTokens: 272_000,
          inputPerMillion: 6,
          outputPerMillion: 24,
          cachedInputPerMillion: 0.6,
        }],
      },
    });
    expect(second).toEqual(first);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock).toHaveBeenCalledWith(
      'https://openrouter.ai/api/v1/model/vendor/future-model',
      expect.objectContaining({ headers: { Accept: 'application/json' } }),
    );
  });

  it('falls back when the OpenRouter lookup is unavailable', async () => {
    const fetchMock = vi.fn(async () => new Response('', { status: 503 }));
    vi.stubGlobal('fetch', fetchMock);

    const result = await resolvePricingAsync({
      provider: 'openai-compatible',
      baseUrl: 'https://openrouter.ai/api/v1',
      model: 'vendor/unavailable-model',
    });

    expect(result.source).toBe('fallback');
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('falls back to prompt pricing for omitted cache-read rates', async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({
      data: {
        id: 'vendor/no-cache-price',
        pricing: { prompt: '0.000003', completion: '0.000012' },
      },
    }), { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);

    const result = await resolvePricingAsync({
      provider: 'openai-compatible',
      baseUrl: 'https://openrouter.ai/api/v1',
      model: 'vendor/no-cache-price',
    });
    expect(result.pricing.cachedInputPerMillion).toBe(3);
  });

  it('does not treat an OpenRouter-looking path as an OpenRouter host', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    const result = await resolvePricingAsync({
      provider: 'openai-compatible',
      baseUrl: 'https://internal.example.com/openrouter.ai/v1',
      model: 'vendor/private-model',
    });
    expect(result.source).toBe('fallback');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('rejects malformed OpenRouter prices instead of treating them as free', async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({
      data: {
        id: 'vendor/malformed-model',
        pricing: { prompt: '', completion: null },
      },
    }), { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);

    const result = await resolvePricingAsync({
      provider: 'openai-compatible',
      baseUrl: 'https://openrouter.ai/api/v1',
      model: 'vendor/malformed-model',
    });

    expect(result.source).toBe('fallback');
  });
});

describe('calculateCostWithPricing', () => {
  it('charges cached input at the cache-hit rate', () => {
    expect(calculateCostWithPricing(
      { input: 1_000_000, output: 100_000, cached: 400_000 },
      { inputPerMillion: 2, outputPerMillion: 8, cachedInputPerMillion: 0.5 },
    )).toBeCloseTo(1.2 + 0.2 + 0.8, 8);
  });
  it('uses the highest matching long-context tier', () => {
    expect(calculateCostWithPricing(
      { input: 300_000, output: 100_000, cached: 100_000 },
      {
        inputPerMillion: 3,
        outputPerMillion: 12,
        cachedInputPerMillion: 0.3,
        tiers: [{
          minPromptTokens: 272_000,
          inputPerMillion: 6,
          outputPerMillion: 24,
          cachedInputPerMillion: 0.6,
        }],
      },
    )).toBeCloseTo(3.66, 8);
});
});

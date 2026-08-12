import { describe, expect, it } from 'vitest';
import {
  calculateCostWithPricing,
  FALLBACK_TOKEN_PRICING,
  resolvePricing,
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

describe('calculateCostWithPricing', () => {
  it('charges cached input at the cache-hit rate', () => {
    expect(calculateCostWithPricing(
      { input: 1_000_000, output: 100_000, cached: 400_000 },
      { inputPerMillion: 2, outputPerMillion: 8, cachedInputPerMillion: 0.5 },
    )).toBeCloseTo(1.2 + 0.2 + 0.8, 8);
  });
});

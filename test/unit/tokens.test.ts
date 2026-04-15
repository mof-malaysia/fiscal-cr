import { describe, it, expect } from 'vitest';
import { estimateTokens, calculateCost } from '../../src/utils/tokens.js';

describe('estimateTokens', () => {
  it('should estimate English text tokens (~4 chars/token)', () => {
    const text = 'Hello world this is a test';
    const tokens = estimateTokens(text);
    expect(tokens).toBeGreaterThan(0);
    expect(tokens).toBeLessThan(text.length); // should be compressed
  });

  it('should estimate CJK text tokens (~2 chars/token)', () => {
    const text = '這是一個測試';
    const tokens = estimateTokens(text);
    expect(tokens).toBe(3); // 6 CJK chars / 2
  });

  it('should handle mixed text', () => {
    const text = 'Hello 世界';
    const tokens = estimateTokens(text);
    expect(tokens).toBeGreaterThan(0);
  });

  it('should handle empty string', () => {
    expect(estimateTokens('')).toBe(0);
  });
});

describe('calculateCost', () => {
  it('should calculate cost from the pricing catalog for the default Kimi model', () => {
    const cost = calculateCost({
      input: 1_000_000,
      output: 1_000_000,
      cached: 0,
    });

    expect(cost).toBeCloseTo(3.6, 2);
  });

  it('should resolve popular OpenAI models from the pricing catalog', () => {
    const cost = calculateCost(
      {
        input: 1_000_000,
        output: 1_000_000,
        cached: 0,
      },
      {
        provider: 'openai-compatible',
        model: 'gpt-4o-mini',
      },
    );

    expect(cost).toBeCloseTo(0.75, 2);
  });

  it('should resolve OpenRouter models from the pricing catalog', () => {
    const cost = calculateCost(
      {
        input: 1_000_000,
        output: 1_000_000,
        cached: 0,
      },
      {
        provider: 'openai-compatible',
        model: 'openai/gpt-4o-mini',
        baseUrl: 'https://openrouter.ai/api/v1',
      },
    );

    expect(cost).toBeCloseTo(0.75, 2);
  });

  it('should resolve newly added GPT-5.4 mini pricing', () => {
    const cost = calculateCost(
      {
        input: 1_000_000,
        output: 1_000_000,
        cached: 0,
      },
      {
        provider: 'openai-compatible',
        model: 'gpt-5.4-mini',
      },
    );

    expect(cost).toBeCloseTo(5.25, 2);
  });

  it('should resolve Claude Sonnet 4.6 pricing by model name', () => {
    const cost = calculateCost(
      {
        input: 1_000_000,
        output: 1_000_000,
        cached: 0,
      },
      {
        provider: 'openai-compatible',
        model: 'claude-sonnet-4.6',
      },
    );

    expect(cost).toBeCloseTo(18, 2);
  });

  it('should resolve OpenRouter Claude Sonnet 4.6 pricing', () => {
    const cost = calculateCost(
      {
        input: 1_000_000,
        output: 1_000_000,
        cached: 0,
      },
      {
        provider: 'openai-compatible',
        model: 'anthropic/claude-sonnet-4.6',
        baseUrl: 'https://openrouter.ai/api/v1',
      },
    );

    expect(cost).toBeCloseTo(18, 2);
  });

  it('should account for cached tokens', () => {
    const costWithCache = calculateCost(
      {
        input: 500_000,
        output: 100_000,
        cached: 500_000,
      },
      {
        provider: 'openai-compatible',
        model: 'gpt-4o-mini',
      },
    );

    const costWithoutCache = calculateCost(
      {
        input: 1_000_000,
        output: 100_000,
        cached: 0,
      },
      {
        provider: 'openai-compatible',
        model: 'gpt-4o-mini',
      },
    );

    expect(costWithCache).toBeLessThan(costWithoutCache);
  });
});

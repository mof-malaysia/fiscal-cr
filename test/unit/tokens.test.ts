import { describe, it, expect } from 'vitest';
import { estimateTokens, calculateCost, roundCost } from '../../src/utils/tokens.js';

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

describe('roundCost', () => {
  it('rounds costs to four decimal places', () => {
    expect(roundCost(0.023456789123)).toBe(0.0235);
    expect(roundCost(2.29)).toBe(2.29);
  });
});

describe('calculateCost', () => {
  it('should calculate cost based on token usage', () => {
    const cost = calculateCost({
      input: 1_000_000,
      output: 1_000_000,
      cached: 0,
    });
    // input: $0.39 + output: $1.90 = $2.29
    expect(cost).toBeCloseTo(2.29, 2);
  });

  it('should account for cached tokens', () => {
    const costWithCache = calculateCost({
      input: 500_000,
      output: 100_000,
      cached: 500_000,
    });
    const costWithoutCache = calculateCost({
      input: 1_000_000,
      output: 100_000,
      cached: 0,
    });
    expect(costWithCache).toBeLessThan(costWithoutCache);
  });
});

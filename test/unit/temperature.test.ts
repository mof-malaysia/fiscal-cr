import { describe, expect, it } from 'vitest';
import { reviewTemperature } from '../../src/pipeline/temperature.js';
import { DEFAULT_CONFIG } from '../../src/config/defaults.js';

describe('reviewTemperature', () => {
  it('defaults to the pipeline-preferred temperature for models that accept one', () => {
    // DEFAULT_CONFIG's model pins its own temperature, so use one that doesn't.
    const config = { ...DEFAULT_CONFIG, model: 'Qwen/Qwen2.5-3B' };
    expect(reviewTemperature(config)).toBe(0.3);
    expect(reviewTemperature(config, 0.5)).toBe(0.5);
  });

  it('omits temperature entirely for kimi preset models that pin their own', () => {
    for (const model of ['kimi-for-coding', 'kimi-for-coding-highspeed']) {
      expect(reviewTemperature({ ...DEFAULT_CONFIG, model })).toBeUndefined();
    }
  });

  it('keeps the preferred temperature for Anthropic preset models', () => {
    for (const model of ['claude-haiku-4.5', 'claude-sonnet-4.5']) {
      expect(reviewTemperature({ ...DEFAULT_CONFIG, model })).toBe(0.3);
    }
  });

  it('omits temperature for OpenAI preset models (o-series, gpt-5)', () => {
    for (const model of ['o1', 'o1-mini', 'o3', 'o3-mini', 'o4-mini', 'gpt-5', 'gpt-5-mini']) {
      expect(reviewTemperature({ ...DEFAULT_CONFIG, model })).toBeUndefined();
    }
  });

  it('keeps the preferred temperature for non-reasoning OpenAI models', () => {
    for (const model of ['gpt-4o', 'gpt-4.1', 'gpt-4-turbo']) {
      expect(reviewTemperature({ ...DEFAULT_CONFIG, model })).toBe(0.3);
    }
  });

  it('an explicit config temperature always wins', () => {
    expect(reviewTemperature({ ...DEFAULT_CONFIG, temperature: 1 })).toBe(1);
    expect(
      reviewTemperature({ ...DEFAULT_CONFIG, model: 'kimi-for-coding', temperature: 1 }),
    ).toBe(1);
    expect(reviewTemperature({ ...DEFAULT_CONFIG, temperature: 0 })).toBe(0);
  });
});

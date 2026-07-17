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

  it('omits temperature entirely for models that pin their own (kimi-for-coding)', () => {
    const config = { ...DEFAULT_CONFIG, model: 'kimi-for-coding' };
    expect(reviewTemperature(config)).toBeUndefined();
  });

  it('an explicit config temperature always wins', () => {
    expect(reviewTemperature({ ...DEFAULT_CONFIG, temperature: 1 })).toBe(1);
    expect(
      reviewTemperature({ ...DEFAULT_CONFIG, model: 'kimi-for-coding', temperature: 1 }),
    ).toBe(1);
    expect(reviewTemperature({ ...DEFAULT_CONFIG, temperature: 0 })).toBe(0);
  });
});

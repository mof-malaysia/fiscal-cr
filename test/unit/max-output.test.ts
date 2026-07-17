import { describe, expect, it } from 'vitest';
import { reviewMaxOutputTokens } from '../../src/pipeline/max-output.js';
import { DEFAULT_CONFIG } from '../../src/config/defaults.js';
import type { ReviewConfig } from '../../src/config/schema.js';

function withConfig(overrides: Partial<ReviewConfig>): ReviewConfig {
  return { ...DEFAULT_CONFIG, ...overrides };
}

describe('reviewMaxOutputTokens', () => {
  it('gives Kimi models a larger cap by default', () => {
    expect(reviewMaxOutputTokens(DEFAULT_CONFIG)).toBe(32_768);
    expect(reviewMaxOutputTokens(withConfig({ provider: 'kimi', model: 'kimi-k3' }))).toBe(32_768);
    expect(
      reviewMaxOutputTokens(withConfig({ provider: 'openai-compatible', model: 'kimi-for-coding' })),
    ).toBe(32_768);
  });

  it('uses a conservative cap for non-Kimi models', () => {
    expect(
      reviewMaxOutputTokens(withConfig({ provider: 'openai-compatible', model: 'Qwen/Qwen2.5-3B' })),
    ).toBe(16_384);
  });

  it('honors an explicit override for any model', () => {
    const cfg = withConfig({
      pipeline: { ...DEFAULT_CONFIG.pipeline, maxOutputTokens: 8_192 },
    });
    expect(reviewMaxOutputTokens(cfg)).toBe(8_192);
  });
});

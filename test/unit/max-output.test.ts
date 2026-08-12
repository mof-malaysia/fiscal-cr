import { describe, expect, it } from 'vitest';
import { reviewMaxOutputTokens } from '../../src/pipeline/max-output.js';
import { DEFAULT_CONFIG } from '../../src/config/defaults.js';
import type { ReviewConfig } from '../../src/config/schema.js';

function withConfig(overrides: Partial<ReviewConfig>): ReviewConfig {
  return { ...DEFAULT_CONFIG, ...overrides };
}

describe('reviewMaxOutputTokens', () => {
  it('gives Kimi models a larger cap by default', () => {
    expect(reviewMaxOutputTokens(DEFAULT_CONFIG)).toBe(65_536);
    expect(reviewMaxOutputTokens(withConfig({ provider: 'kimi', model: 'kimi-k3' }))).toBe(65_536);
    expect(
      reviewMaxOutputTokens(withConfig({ provider: 'openai-compatible', model: 'kimi-for-coding' })),
    ).toBe(65_536);
  });

  it('uses a conservative cap for non-Kimi models', () => {
    expect(
      reviewMaxOutputTokens(withConfig({ provider: 'openai-compatible', model: 'Qwen/Qwen2.5-3B' })),
    ).toBe(32_768);
  });

  it('uses the conservative cap for Anthropic and OpenAI preset models', () => {
    expect(
      reviewMaxOutputTokens(withConfig({ provider: 'anthropic', model: 'claude-haiku-4.5' })),
    ).toBe(32_768);
    expect(
      reviewMaxOutputTokens(withConfig({ provider: 'anthropic', model: 'claude-sonnet-4.5' })),
    ).toBe(32_768);
    expect(reviewMaxOutputTokens(withConfig({ provider: 'openai', model: 'gpt-5-mini' }))).toBe(32_768);
    expect(reviewMaxOutputTokens(withConfig({ provider: 'openai', model: 'gpt-5' }))).toBe(32_768);
  });

  it('keeps the Kimi cap for the kimi preset high-speed intent model', () => {
    expect(reviewMaxOutputTokens(withConfig({ model: 'kimi-for-coding-highspeed' }))).toBe(65_536);
    expect(
      reviewMaxOutputTokens(withConfig({ provider: 'openai-compatible', model: 'kimi-for-coding-highspeed' })),
    ).toBe(65_536);
  });

  it('honors an explicit override for any model', () => {
    const cfg = withConfig({
      pipeline: { ...DEFAULT_CONFIG.pipeline, maxOutputTokens: 8_192 },
    });
    expect(reviewMaxOutputTokens(cfg)).toBe(8_192);
  });
});

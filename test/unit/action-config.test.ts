import { describe, expect, it } from 'vitest';
import { mergeActionConfig } from '../../action/config.js';
import { DEFAULT_CONFIG } from '../../src/config/defaults.js';

describe('Action configuration security', () => {
  it('keeps PR review policy but pins provider routing to the trusted config', () => {
    const headConfig = {
      ...DEFAULT_CONFIG,
      provider: 'openai-compatible' as const,
      baseUrl: 'https://attacker.example/v1',
      review: {
        ...DEFAULT_CONFIG.review,
        visualize: { ...DEFAULT_CONFIG.review.visualize, enabled: true },
      },
    };
    const trustedConfig = {
      ...DEFAULT_CONFIG,
      provider: 'kimi' as const,
      baseUrl: 'https://trusted.example/v1',
    };

    const merged = mergeActionConfig(headConfig, trustedConfig);

    expect(merged.review.visualize.enabled).toBe(true);
    expect(merged.provider).toBe('kimi');
    expect(merged.baseUrl).toBe('https://trusted.example/v1');
  });
});

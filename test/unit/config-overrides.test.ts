import { describe, expect, it } from 'vitest';
import { DEFAULT_CONFIG } from '../../src/config/defaults.js';
import { applyModelOverride, applyProviderOverride } from '../../src/config/overrides.js';
import { modelForRole } from '../../src/config/schema.js';

describe('runtime config overrides', () => {
  it('routes provider-default through an explicit provider override', () => {
    const config = {
      ...DEFAULT_CONFIG,
      provider: 'kimi' as const,
      modelPreset: 'provider-default',
      models: {},
    };

    applyProviderOverride(config, 'openai');

    expect(config.provider).toBe('openai');
    expect(modelForRole(config, 'intent')).toBe('gpt-5.6-terra');
    expect(modelForRole(config, 'groupReview')).toBe('gpt-5.6-sol');
  });

  it('pins every stage for an explicit global model override', () => {
    const config = { ...DEFAULT_CONFIG, models: {} };

    applyModelOverride(config, 'custom-model');

    expect(config.model).toBe('custom-model');
    expect(config.models).toEqual({
      intent: 'custom-model',
      fastPath: 'custom-model',
      groupReview: 'custom-model',
      synthesis: 'custom-model',
    });
  });
});

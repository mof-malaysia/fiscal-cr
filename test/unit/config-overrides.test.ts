import { describe, expect, it } from 'vitest';
import { PROVIDER_DEFAULT_MODELS } from '../../src/config/provider-models.js';
import { DEFAULT_CONFIG } from '../../src/config/defaults.js';
import { applyModelOverride, applyProviderOverride } from '../../src/config/overrides.js';
import { modelForRole } from '../../src/config/schema.js';

describe('runtime config overrides', () => {
  it('resolves release-pinned models from an explicit provider override', () => {
    const config = {
      ...DEFAULT_CONFIG,
      provider: 'kimi' as const,
      models: {},
    };

    applyProviderOverride(config, 'openai');

    expect(config.provider).toBe('openai');
    expect(modelForRole(config, 'intent')).toBe(PROVIDER_DEFAULT_MODELS.openai.intent);
    expect(modelForRole(config, 'groupReview')).toBe(PROVIDER_DEFAULT_MODELS.openai.groupReview);
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

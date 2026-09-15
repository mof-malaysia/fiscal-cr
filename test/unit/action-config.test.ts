import { describe, expect, it } from 'vitest';
import { ConfigError } from '../../src/utils/errors.js';
import {
  applyActionReviewConfig,
  commentModeFromActionInput,
  visualizeFromActionInput,
} from '../../action/review-config.js';
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

function actionCore(inputs: Record<string, string>) {
  return {
    getInput: (name: string) => inputs[name] ?? '',
    getBooleanInput: (name: string) => inputs[name] === 'true',
  };
}

describe('Action review configuration inputs', () => {
  it('preserves repository settings when inputs are absent', () => {
    const config = {
      ...DEFAULT_CONFIG,
      review: {
        ...DEFAULT_CONFIG.review,
        visualize: { ...DEFAULT_CONFIG.review.visualize, enabled: true },
        comments: { ...DEFAULT_CONFIG.review.comments, mode: 'legacy' as const },
      },
    };
    const core = actionCore({});

    applyActionReviewConfig(config, {
      visualize: visualizeFromActionInput(core),
      comments: commentModeFromActionInput(core),
    });

    expect(config.review.visualize.enabled).toBe(true);
    expect(config.review.comments.mode).toBe('legacy');
  });

  it('applies explicit visualization and comment inputs', () => {
    const config = {
      ...DEFAULT_CONFIG,
      review: {
        ...DEFAULT_CONFIG.review,
        visualize: { ...DEFAULT_CONFIG.review.visualize, enabled: true },
        comments: { ...DEFAULT_CONFIG.review.comments, mode: 'legacy' as const },
      },
    };
    const core = actionCore({ visualize: 'false', comments: 'sticky' });

    applyActionReviewConfig(config, {
      visualize: visualizeFromActionInput(core),
      comments: commentModeFromActionInput(core),
    });

    expect(config.review.visualize.enabled).toBe(false);
    expect(config.review.comments.mode).toBe('sticky');
  });

  it('rejects unsupported comment modes', () => {
    expect(() =>
      commentModeFromActionInput(actionCore({ comments: 'threaded' })),
    ).toThrowError(ConfigError);
  });
});

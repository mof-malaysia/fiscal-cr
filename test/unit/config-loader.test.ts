import { describe, expect, it, vi } from 'vitest';
import { PROVIDER_DEFAULT_MODELS } from '../../src/config/provider-models.js';
import { loadConfig } from '../../src/config/loader.js';
import { DEFAULT_CONFIG } from '../../src/config/defaults.js';
import { modelForRole } from '../../src/config/schema.js';
import { ConfigError } from '../../src/utils/errors.js';
import { logger } from '../../src/utils/logger.js';

function yamlOctokit(yaml: string): any {
  return {
    repos: {
      getContent: vi.fn().mockResolvedValue({
        data: { content: Buffer.from(yaml, 'utf8').toString('base64'), encoding: 'base64' },
      }),
    },
  };
}

describe('loadConfig', () => {
  it('loads a config from a custom path', async () => {
    const getContent = vi.fn().mockResolvedValue({
      data: {
        content: Buffer.from('language: ja\nprovider: openai-compatible\nmodel: gpt-4.1-mini\nexperimental: true\n', 'utf8').toString('base64'),
        encoding: 'base64',
      },
    });

    const octokit = {
      repos: {
        getContent,
      },
    } as any;

    const config = await loadConfig(octokit, 'mof-malaysia', 'fiscal-cr', 'fiscalcr.yaml');

    expect(getContent).toHaveBeenCalledWith({
      owner: 'mof-malaysia',
      repo: 'fiscal-cr',
      path: 'fiscalcr.yaml',
    });
    expect(config.language).toBe('ja');
    expect(config.provider).toBe('openai-compatible');
    expect(config.experimental).toBe(true);
  });

  it('passes the reviewed ref when loading PR-head config', async () => {
    const getContent = vi.fn().mockResolvedValue({
      data: {
        content: Buffer.from('model: pr-head-model\n', 'utf8').toString('base64'),
        encoding: 'base64',
      },
    });
    const octokit = { repos: { getContent } } as any;

    const config = await loadConfig(octokit, 'owner', 'repo', '.fiscalcr-review.yml', 'head-sha');

    expect(getContent).toHaveBeenCalledWith({
      owner: 'owner',
      repo: 'repo',
      path: '.fiscalcr-review.yml',
      ref: 'head-sha',
    });
    expect(config.model).toBe('pr-head-model');
  });

  it('keeps arbitrary modelParams keys via passthrough and validates typed ones', async () => {
    const yaml = [
      'provider: openai',
      'model: gpt-5',
      'modelParams:',
      '  reasoning_effort: high',
      '  top_p: 0.9',
      '  seed: 42',
      '',
    ].join('\n');
    const octokit = {
      repos: {
        getContent: vi.fn().mockResolvedValue({
          data: { content: Buffer.from(yaml, 'utf8').toString('base64'), encoding: 'base64' },
        }),
      },
    } as any;

    const config = await loadConfig(octokit, 'mof-malaysia', 'fiscal-cr');

    expect(config.modelParams).toEqual({
      reasoning_effort: 'high',
      top_p: 0.9,
      seed: 42,
    });
  });

  it('rejects an invalid typed modelParams value', async () => {
    const yaml = 'modelParams:\n  reasoning_effort: turbo\n';
    const octokit = {
      repos: {
        getContent: vi.fn().mockResolvedValue({
          data: { content: Buffer.from(yaml, 'utf8').toString('base64'), encoding: 'base64' },
        }),
      },
    } as any;

    await expect(loadConfig(octokit, 'mof-malaysia', 'fiscal-cr')).rejects.toThrow();
  });

  it('falls back to defaults when the config file is missing', async () => {
    const octokit = {
      repos: {
        getContent: vi.fn().mockRejectedValue({ status: 404 }),
      },
    } as any;

    await expect(loadConfig(octokit, 'mof-malaysia', 'fiscal-cr')).resolves.toEqual(DEFAULT_CONFIG);
  });

  it('uses the release-pinned kimi models for all stages when the config file is missing', async () => {
    const octokit = {
      repos: {
        getContent: vi.fn().mockRejectedValue({ status: 404 }),
      },
    } as any;

    const config = await loadConfig(octokit, 'mof-malaysia', 'fiscal-cr');
    expect(config.model).toBeUndefined();
    expect(config.models).toEqual({});
    expect(modelForRole(config, 'intent')).toBe(PROVIDER_DEFAULT_MODELS.kimi.intent);
    expect(modelForRole(config, 'fastPath')).toBe(PROVIDER_DEFAULT_MODELS.kimi.fastPath);
    expect(modelForRole(config, 'groupReview')).toBe(PROVIDER_DEFAULT_MODELS.kimi.groupReview);
    expect(modelForRole(config, 'synthesis')).toBe(PROVIDER_DEFAULT_MODELS.kimi.synthesis);
    expect(modelForRole(config, 'visualize')).toBe(PROVIDER_DEFAULT_MODELS.kimi.visualize);
  });

  it('keeps old configs without a models block valid, defaulting it to {}', async () => {
    const yaml = 'model: gpt-4.1-mini\n';
    const octokit = {
      repos: {
        getContent: vi.fn().mockResolvedValue({
          data: { content: Buffer.from(yaml, 'utf8').toString('base64'), encoding: 'base64' },
        }),
      },
    } as any;

    const config = await loadConfig(octokit, 'mof-malaysia', 'fiscal-cr');
    expect(config.model).toBe('gpt-4.1-mini');
    expect(config.models).toEqual({});
  });

  it('accepts a partial models block and falls each unset stage back to the top-level model', async () => {
    const yaml = 'model: gpt-4.1-mini\nmodels:\n  intent: kimi-for-coding-highspeed\n';
    const octokit = {
      repos: {
        getContent: vi.fn().mockResolvedValue({
          data: { content: Buffer.from(yaml, 'utf8').toString('base64'), encoding: 'base64' },
        }),
      },
    } as any;

    const config = await loadConfig(octokit, 'mof-malaysia', 'fiscal-cr');
    expect(config.models).toEqual({ intent: 'kimi-for-coding-highspeed' });
    expect(modelForRole(config, 'intent')).toBe('kimi-for-coding-highspeed');
    expect(modelForRole(config, 'fastPath')).toBe('gpt-4.1-mini');
    expect(modelForRole(config, 'groupReview')).toBe('gpt-4.1-mini');
    expect(modelForRole(config, 'synthesis')).toBe('gpt-4.1-mini');
  });

  it('accepts overrides for all four stages', async () => {
    const yaml = [
      'model: gpt-4.1-mini',
      'models:',
      '  intent: kimi-for-coding-highspeed',
      '  fastPath: kimi-for-coding',
      '  groupReview: kimi-for-coding',
      '  synthesis: kimi-for-coding',
      '',
    ].join('\n');
    const octokit = {
      repos: {
        getContent: vi.fn().mockResolvedValue({
          data: { content: Buffer.from(yaml, 'utf8').toString('base64'), encoding: 'base64' },
        }),
      },
    } as any;

    const config = await loadConfig(octokit, 'mof-malaysia', 'fiscal-cr');
    expect(modelForRole(config, 'intent')).toBe('kimi-for-coding-highspeed');
    expect(modelForRole(config, 'fastPath')).toBe('kimi-for-coding');
    expect(modelForRole(config, 'groupReview')).toBe('kimi-for-coding');
    expect(modelForRole(config, 'synthesis')).toBe('kimi-for-coding');
  });
  it('allows an explicit visualize model override while defaulting to fastPath', async () => {
    const yaml = [
      'model: fallback-model',
      'models:',
      '  fastPath: fast-model',
      '  visualize: visualize-model',
      '',
    ].join('\n');
    const octokit = {
      repos: {
        getContent: vi.fn().mockResolvedValue({
          data: { content: Buffer.from(yaml, 'utf8').toString('base64'), encoding: 'base64' },
        }),
      },
    } as any;
    const config = await loadConfig(octokit, 'mof-malaysia', 'fiscal-cr');
    expect(modelForRole(config, 'visualize')).toBe('visualize-model');
  });

  it('rejects an empty model stage value', async () => {
    const yaml = 'models:\n  intent: ""\n';
    const octokit = {
      repos: {
        getContent: vi.fn().mockResolvedValue({
          data: { content: Buffer.from(yaml, 'utf8').toString('base64'), encoding: 'base64' },
        }),
      },
    } as any;

    await expect(loadConfig(octokit, 'mof-malaysia', 'fiscal-cr')).rejects.toThrow();
  });

  it('rejects a non-string model stage value', async () => {
    const yaml = 'models:\n  fastPath: 42\n';
    const octokit = {
      repos: {
        getContent: vi.fn().mockResolvedValue({
          data: { content: Buffer.from(yaml, 'utf8').toString('base64'), encoding: 'base64' },
        }),
      },
    } as any;

    await expect(loadConfig(octokit, 'mof-malaysia', 'fiscal-cr')).rejects.toThrow();
  });

  it('rejects the legacy big/small role keys', async () => {
    const yaml = 'models:\n  big: kimi-for-coding\n';
    const octokit = {
      repos: {
        getContent: vi.fn().mockResolvedValue({
          data: { content: Buffer.from(yaml, 'utf8').toString('base64'), encoding: 'base64' },
        }),
      },
    } as any;

    await expect(loadConfig(octokit, 'mof-malaysia', 'fiscal-cr')).rejects.toThrow();
  });

  it('rejects any other unknown model role key', async () => {
    const yaml = 'models:\n  fastpath: kimi-for-coding\n';
    const octokit = {
      repos: {
        getContent: vi.fn().mockResolvedValue({
          data: { content: Buffer.from(yaml, 'utf8').toString('base64'), encoding: 'base64' },
        }),
      },
    } as any;

    await expect(loadConfig(octokit, 'mof-malaysia', 'fiscal-cr')).rejects.toThrow();
  });

  it('uses the release-pinned models for the configured provider when model is unset', async () => {
    const config = await loadConfig(yamlOctokit('provider: anthropic\n'), 'mof-malaysia', 'fiscal-cr');
    expect(modelForRole(config, 'intent')).toBe(PROVIDER_DEFAULT_MODELS.anthropic.intent);
    expect(modelForRole(config, 'fastPath')).toBe(PROVIDER_DEFAULT_MODELS.anthropic.fastPath);
    expect(modelForRole(config, 'groupReview')).toBe(PROVIDER_DEFAULT_MODELS.anthropic.groupReview);
    expect(modelForRole(config, 'synthesis')).toBe(PROVIDER_DEFAULT_MODELS.anthropic.synthesis);
    expect(modelForRole(config, 'visualize')).toBe(PROVIDER_DEFAULT_MODELS.anthropic.visualize);
  });

  it('lets an explicit top-level model override every release-pinned stage', async () => {
    const config = await loadConfig(
      yamlOctokit('provider: anthropic\nmodel: claude-opus-5-5\n'),
      'mof-malaysia',
      'fiscal-cr',
    );
    for (const role of ['intent', 'fastPath', 'groupReview', 'synthesis', 'visualize'] as const) {
      expect(modelForRole(config, role)).toBe('claude-opus-5-5');
    }
  });

  it('prefers an explicit models stage over the top-level model and release defaults', async () => {
    const config = await loadConfig(
      yamlOctokit('models:\n  intent: custom-intent-model\n'),
      'mof-malaysia',
      'fiscal-cr',
    );
    expect(modelForRole(config, 'intent')).toBe('custom-intent-model');
    expect(modelForRole(config, 'fastPath')).toBe(PROVIDER_DEFAULT_MODELS.kimi.fastPath);
    expect(modelForRole(config, 'groupReview')).toBe(PROVIDER_DEFAULT_MODELS.kimi.groupReview);
    expect(modelForRole(config, 'synthesis')).toBe(PROVIDER_DEFAULT_MODELS.kimi.synthesis);
  });

  it('fails model resolution for openai-compatible without a model', async () => {
    const config = await loadConfig(
      yamlOctokit('provider: openai-compatible\n'),
      'mof-malaysia',
      'fiscal-cr',
    );
    expect(() => modelForRole(config, 'groupReview')).toThrow(ConfigError);
    expect(() => modelForRole(config, 'visualize')).toThrow(ConfigError);
  });

  it('ignores removed modelPreset/modelPresets keys with a warning', async () => {
    const warn = vi.spyOn(logger, 'warn').mockImplementation(() => undefined as never);
    const yaml = 'provider: openai\nmodelPreset: kimi\nmodelPresets:\n  team:\n    intent: x\n';
    const config = await loadConfig(yamlOctokit(yaml), 'mof-malaysia', 'fiscal-cr');

    expect(config).not.toHaveProperty('modelPreset');
    expect(config).not.toHaveProperty('modelPresets');
    expect(modelForRole(config, 'groupReview')).toBe(PROVIDER_DEFAULT_MODELS.openai.groupReview);
    expect(warn).toHaveBeenCalledWith(
      { keys: ['modelPreset', 'modelPresets'] },
      expect.stringContaining('Model presets were removed'),
    );
    warn.mockRestore();
  });

  it('rethrows non-404 errors instead of silently defaulting', async () => {
    const octokit = {
      repos: {
        getContent: vi.fn().mockRejectedValue(new Error('GitHub API unavailable')),
      },
    } as any;

    await expect(loadConfig(octokit, 'mof-malaysia', 'fiscal-cr')).rejects.toThrow(
      'GitHub API unavailable',
    );
  });
});
describe('review.visualize.enabled config', () => {
  it('defaults review.visualize.enabled to false', () => {
    expect(DEFAULT_CONFIG.review.visualize.enabled).toBe(false);
  });
  it('defaults visualization complexity thresholds', () => {
    expect(DEFAULT_CONFIG.review.visualize.minChangedFiles).toBe(2);
    expect(DEFAULT_CONFIG.review.visualize.minChangedLines).toBe(20);
  });
  it('defaults visualization output tokens to 2000', () => {
    expect(DEFAULT_CONFIG.review.visualize.maxOutputTokens).toBe(2_000);
  });
  it('defaults visualization mode to auto', () => {
    expect(DEFAULT_CONFIG.review.visualize.mode).toBe('auto');
  });

  it.each(['auto', 'concept', 'implementation'] as const)('accepts visualization mode %s', async (mode) => {
    const yaml = `review:\n  visualize:\n    mode: ${mode}\n`;
    const octokit = {
      repos: {
        getContent: vi.fn().mockResolvedValue({
          data: { content: Buffer.from(yaml, 'utf8').toString('base64'), encoding: 'base64' },
        }),
      },
    } as any;
    const config = await loadConfig(octokit, 'mof-malaysia', 'fiscal-cr');
    expect(config.review.visualize.mode).toBe(mode);
  });

  it('rejects an invalid visualization mode', async () => {
    const yaml = 'review:\n  visualize:\n    mode: files\n';
    const octokit = {
      repos: {
        getContent: vi.fn().mockResolvedValue({
          data: { content: Buffer.from(yaml, 'utf8').toString('base64'), encoding: 'base64' },
        }),
      },
    } as any;
    await expect(loadConfig(octokit, 'mof-malaysia', 'fiscal-cr')).rejects.toThrow();
  });


  it('opts in via review.visualize.enabled: true', async () => {
    const yaml = 'review:\n  visualize:\n    enabled: true\n';
    const octokit = {
      repos: {
        getContent: vi.fn().mockResolvedValue({
          data: { content: Buffer.from(yaml, 'utf8').toString('base64'), encoding: 'base64' },
        }),
      },
    } as any;
    const config = await loadConfig(octokit, 'mof-malaysia', 'fiscal-cr');
    expect(config.review.visualize.enabled).toBe(true);
  });
  it('loads configurable visualization thresholds and output cap', async () => {
    const yaml = [
      'review:',
      '  visualize:',
      '    enabled: true',
      '    maxOutputTokens: 4096',
      '    minChangedFiles: 3',
      '    minChangedLines: 40',
      '',
    ].join('\n');
    const octokit = {
      repos: {
        getContent: vi.fn().mockResolvedValue({
          data: { content: Buffer.from(yaml, 'utf8').toString('base64'), encoding: 'base64' },
        }),
      },
    } as any;
    const config = await loadConfig(octokit, 'mof-malaysia', 'fiscal-cr');
    expect(config.review.visualize).toMatchObject({
      enabled: true,
      maxOutputTokens: 4_096,
      minChangedFiles: 3,
      minChangedLines: 40,
    });
  });

  it('rejects invalid visualization complexity thresholds', async () => {
    const yaml = 'review:\n  visualize:\n    minChangedFiles: 0\n';
    const octokit = {
      repos: {
        getContent: vi.fn().mockResolvedValue({
          data: { content: Buffer.from(yaml, 'utf8').toString('base64'), encoding: 'base64' },
        }),
      },
    } as any;
    await expect(loadConfig(octokit, 'mof-malaysia', 'fiscal-cr')).rejects.toThrow();
  });


  it('rejects a non-boolean (string) review.visualize.enabled', async () => {
    const yaml = 'review:\n  visualize:\n    enabled: \"yes\"\n';
    const octokit = {
      repos: {
        getContent: vi.fn().mockResolvedValue({
          data: { content: Buffer.from(yaml, 'utf8').toString('base64'), encoding: 'base64' },
        }),
      },
    } as any;
    await expect(loadConfig(octokit, 'mof-malaysia', 'fiscal-cr')).rejects.toThrow();
  });

  it('rejects a numeric review.visualize.enabled', async () => {
    const yaml = 'review:\n  visualize:\n    enabled: 1\n';
    const octokit = {
      repos: {
        getContent: vi.fn().mockResolvedValue({
          data: { content: Buffer.from(yaml, 'utf8').toString('base64'), encoding: 'base64' },
        }),
      },
    } as any;
    await expect(loadConfig(octokit, 'mof-malaysia', 'fiscal-cr')).rejects.toThrow();
  });
});

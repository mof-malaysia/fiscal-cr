import { describe, expect, it, vi } from 'vitest';
import { loadConfig } from '../../src/config/loader.js';
import { DEFAULT_CONFIG } from '../../src/config/defaults.js';
import { modelForRole } from '../../src/config/schema.js';

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

  it('defaults all four stage models when the config file is missing', async () => {
    const octokit = {
      repos: {
        getContent: vi.fn().mockRejectedValue({ status: 404 }),
      },
    } as any;

    const config = await loadConfig(octokit, 'mof-malaysia', 'fiscal-cr');
    expect(config.models).toEqual({
      intent: 'kimi-for-coding-highspeed',
      fastPath: 'kimi-for-coding',
      groupReview: 'kimi-for-coding',
      synthesis: 'kimi-for-coding',
    });
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

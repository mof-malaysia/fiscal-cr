import { describe, expect, it, vi } from 'vitest';
import { loadConfig } from '../../src/config/loader.js';
import { DEFAULT_CONFIG } from '../../src/config/defaults.js';

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

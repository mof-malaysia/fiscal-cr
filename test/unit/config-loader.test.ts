import { describe, expect, it, vi } from 'vitest';
import { loadConfig } from '../../src/config/loader.js';
import { DEFAULT_CONFIG } from '../../src/config/defaults.js';

describe('loadConfig', () => {
  it('loads a config from a custom path', async () => {
    const getContent = vi.fn().mockResolvedValue({
      data: {
        content: Buffer.from('language: ja\nprovider: kimi\nmodel: kimi-k2.5\n', 'utf8').toString('base64'),
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
    expect(config.provider).toBe('kimi');
  });

  it('falls back to defaults when the config file is missing', async () => {
    const octokit = {
      repos: {
        getContent: vi.fn().mockRejectedValue({ status: 404 }),
      },
    } as any;

    await expect(loadConfig(octokit, 'mof-malaysia', 'fiscal-cr')).resolves.toEqual(DEFAULT_CONFIG);
  });

  it('accepts openrouter configs with provider-prefixed model names', async () => {
    const getContent = vi.fn().mockResolvedValue({
      data: {
        content: Buffer.from(
          'language: en\nprovider: openrouter\nmodel: nvidia/nemotron-3-super-120b-a12b:free\n',
          'utf8',
        ).toString('base64'),
        encoding: 'base64',
      },
    });

    const octokit = {
      repos: {
        getContent,
      },
    } as any;

    const config = await loadConfig(octokit, 'mof-malaysia', 'fiscal-cr');

    expect(config.provider).toBe('openrouter');
    expect(config.model).toBe('nvidia/nemotron-3-super-120b-a12b:free');
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
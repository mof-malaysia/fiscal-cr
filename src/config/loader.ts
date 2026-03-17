import type { Octokit } from '@octokit/rest';
import YAML from 'yaml';
import { reviewConfigSchema, type ReviewConfig } from './schema.js';
import { DEFAULT_CONFIG } from './defaults.js';
import { ConfigError } from '../utils/errors.js';
import { logger } from '../utils/logger.js';

const CONFIG_FILENAME = '.fiscalcr-review.yml';

export async function loadConfig(
  octokit: Octokit,
  owner: string,
  repo: string,
  configPath: string = CONFIG_FILENAME,
): Promise<ReviewConfig> {
  try {
    const { data } = await octokit.repos.getContent({
      owner,
      repo,
      path: configPath,
    });

    if (!('content' in data) || data.encoding !== 'base64') {
      logger.info('Config file found but not a regular file, using defaults');
      return DEFAULT_CONFIG;
    }

    const content = Buffer.from(data.content, 'base64').toString('utf-8');
    const parsed = parseYaml(content);
    const result = reviewConfigSchema.safeParse(parsed);

    if (!result.success) {
      logger.warn({ errors: result.error.issues }, 'Config validation failed, using defaults');
      throw new ConfigError(`Invalid config: ${result.error.message}`);
    }

    logger.info({ language: result.data.language, model: result.data.model }, 'Config loaded');
    return result.data;
  } catch (err) {
    if (err instanceof ConfigError) throw err;
    // 404 — no config file, use defaults
    logger.info({ configPath }, `No ${configPath} found, using defaults`);
    return DEFAULT_CONFIG;
  }
}

function parseYaml(content: string): Record<string, unknown> {
  const parsed = YAML.parse(content);
  if (parsed == null || typeof parsed !== 'object') return {};
  return parsed as Record<string, unknown>;
}

import { App } from '@octokit/app';
import type { Octokit } from '@octokit/rest';
import { registerWebhooks } from './github/webhooks.js';
import { logger } from './utils/logger.js';

export interface AppConfig {
  githubAppId: string;
  githubPrivateKey: string;
  githubWebhookSecret: string;
  apiKey: string;
  provider?: string;
  model?: string;
  baseUrl?: string;
}

export function createApp(config: AppConfig): App {
  const app = new App({
    appId: config.githubAppId,
    privateKey: config.githubPrivateKey,
    webhooks: { secret: config.githubWebhookSecret },
  });

  registerWebhooks(app.webhooks, {
    apiKey: config.apiKey,
    provider: config.provider,
    model: config.model,
    baseUrl: config.baseUrl,
    getInstallationOctokit: async (installationId: number) => {
      return (await app.getInstallationOctokit(installationId)) as unknown as Octokit;
    },
  });

  logger.info('GitHub App initialized');
  return app;
}

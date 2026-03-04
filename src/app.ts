import { App } from '@octokit/app';
import type { Octokit } from '@octokit/rest';
import { registerWebhooks } from './github/webhooks.js';
import { logger } from './utils/logger.js';

export interface AppConfig {
  githubAppId: string;
  githubPrivateKey: string;
  githubWebhookSecret: string;
  kimiApiKey: string;
  kimiModel?: string;
  kimiBaseUrl?: string;
}

export function createApp(config: AppConfig): App {
  const app = new App({
    appId: config.githubAppId,
    privateKey: config.githubPrivateKey,
    webhooks: { secret: config.githubWebhookSecret },
  });

  registerWebhooks(app.webhooks, {
    kimiApiKey: config.kimiApiKey,
    kimiModel: config.kimiModel,
    kimiBaseUrl: config.kimiBaseUrl,
    getInstallationOctokit: async (installationId: number) => {
      return (await app.getInstallationOctokit(installationId)) as unknown as Octokit;
    },
  });

  logger.info('GitHub App initialized');
  return app;
}

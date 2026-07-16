import type { Octokit } from '@octokit/rest';
import type { Webhooks } from '@octokit/webhooks';
import { ReviewOrchestrator } from '../review/orchestrator.js';
import { loadConfig } from '../config/loader.js';
import { createLLMProvider } from '../providers/factory.js';
import { logger } from '../utils/logger.js';

interface AppContext {
  apiKey: string;
  provider?: string;
  model?: string;
  baseUrl?: string;
  userAgent?: string;
  getInstallationOctokit: (installationId: number) => Promise<Octokit>;
}

type FiscalCRCommand = 'review' | 'help' | 'unknown';

export function registerWebhooks(webhooks: Webhooks, appCtx: AppContext): void {
  // Auto-review on PR opened, new commits pushed, reopened, or marked ready
  webhooks.on(
    [
      'pull_request.opened',
      'pull_request.synchronize',
      'pull_request.reopened',
      'pull_request.ready_for_review',
    ],
    async ({ payload }) => {
      const installationId = payload.installation?.id;
      if (!installationId) return;

      const octokit = await appCtx.getInstallationOctokit(installationId);
      const owner = payload.repository.owner.login;
      const repo = payload.repository.name;
      const pullNumber = payload.pull_request.number;
      const headSha = payload.pull_request.head.sha;
      const isDraft = payload.pull_request.draft;

      logger.info({ owner, repo, pullNumber, action: payload.action }, 'PR event received');

      const config = await loadConfig(octokit, owner, repo);

      if (isDraft && !config.review.auto.drafts) {
        logger.info({ pullNumber }, 'Skipping draft PR');
        return;
      }

      if (!config.review.auto.enabled) return;
      // reopened / ready_for_review follow the onOpen setting.
      if (payload.action !== 'synchronize' && !config.review.auto.onOpen) return;
      if (payload.action === 'synchronize' && !config.review.auto.onPush) return;

      const llm = createLLMProvider({
        apiKey: appCtx.apiKey,
        provider: appCtx.provider ?? config.provider,
        model: appCtx.model ?? config.model,
        baseUrl: appCtx.baseUrl,
        userAgent: appCtx.userAgent ?? config.userAgent,
      });

      const orchestrator = new ReviewOrchestrator(octokit, llm, config);
      await orchestrator.reviewPullRequest({ owner, repo, pullNumber, headSha });
    },
  );

  // @fiscalcr mention in PR/issue comments
  webhooks.on(['issue_comment.created'], async ({ payload }) => {
    const body = payload.comment.body;
    const command = parseFiscalCRCommand(body);
    if (command === 'unknown') return;
    if (!payload.issue.pull_request) return;

    const installationId = payload.installation?.id;
    if (!installationId) return;

    const octokit = await appCtx.getInstallationOctokit(installationId);
    const owner = payload.repository.owner.login;
    const repo = payload.repository.name;
    const pullNumber = payload.issue.number;

    logger.info({ owner, repo, pullNumber, command }, '@fiscalcr mention detected');

    if (command === 'review') {
      const config = await loadConfig(octokit, owner, repo);
      const llm = createLLMProvider({
        apiKey: appCtx.apiKey,
        provider: appCtx.provider ?? config.provider,
        model: appCtx.model ?? config.model,
        baseUrl: appCtx.baseUrl,
        userAgent: appCtx.userAgent ?? config.userAgent,
      });

      const { data: pr } = await octokit.pulls.get({
        owner,
        repo,
        pull_number: pullNumber,
      });

      const orchestrator = new ReviewOrchestrator(octokit, llm, config);
      // An explicit @fiscalcr review always re-reviews the whole PR.
      await orchestrator.reviewPullRequest({
        owner,
        repo,
        pullNumber,
        headSha: pr.head.sha,
        forceFull: true,
      });
    } else if (command === 'help') {
      await octokit.issues.createComment({
        owner,
        repo,
        issue_number: pullNumber,
        body: [
          '## FiscalCR Commands\n',
          '| Command | Description |',
          '|---------|-------------|',
          '| `@fiscalcr review` | Run a full code review on this PR |',
          '| `@fiscalcr help` | Show this help message |',
          '\nPowered by FiscalCR — model-agnostic AI code review.',
        ].join('\n'),
      });
    }
  });

  // Review request
  webhooks.on('pull_request.review_requested', async ({ payload }) => {
    const installationId = payload.installation?.id;
    if (!installationId) return;

    const octokit = await appCtx.getInstallationOctokit(installationId);
    const owner = payload.repository.owner.login;
    const repo = payload.repository.name;
    const pullNumber = payload.pull_request.number;
    const headSha = payload.pull_request.head.sha;

    const config = await loadConfig(octokit, owner, repo);
    if (!config.review.auto.onReviewRequest) return;

    logger.info({ owner, repo, pullNumber }, 'Review requested');

    const llm = createLLMProvider({
      apiKey: appCtx.apiKey,
      provider: appCtx.provider ?? config.provider,
      model: appCtx.model ?? config.model,
      baseUrl: appCtx.baseUrl,
      userAgent: appCtx.userAgent ?? config.userAgent,
    });

    const orchestrator = new ReviewOrchestrator(octokit, llm, config);
    await orchestrator.reviewPullRequest({ owner, repo, pullNumber, headSha });
  });
}

function parseFiscalCRCommand(body: string): FiscalCRCommand {
  const match = body.match(/(?:^|\s)@fiscalcr(?:\s+(\w+))?(?=$|\s|[.,!?:;])/i);
  if (!match) return 'unknown';

  const cmd = match[1]?.toLowerCase();
  if (!cmd) return 'review';
  if (cmd === 'review') return 'review';
  if (cmd === 'help') return 'help';
  return 'unknown';
}

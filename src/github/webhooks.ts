import type { Octokit } from '@octokit/rest';
import type { Webhooks } from '@octokit/webhooks';
import { applyManualThreadResolution, loadReviewState, replaceStateMarker, saveStickyComment } from './review-state.js';
import { listFiscalcrThreads } from './threads.js';
import { ReviewOrchestrator } from '../review/orchestrator.js';
import { loadConfig } from '../config/loader.js';
import { modelForRole } from '../config/schema.js';
import { applyModelOverride, applyProviderOverride } from '../config/overrides.js';
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
      applyProviderOverride(config, appCtx.provider);
      applyModelOverride(config, appCtx.model);

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
        model: modelForRole(config, 'groupReview'),
        baseUrl: appCtx.baseUrl ?? config.baseUrl,
        userAgent: appCtx.userAgent ?? config.userAgent,
        modelParams: config.modelParams,
      });

      const orchestrator = new ReviewOrchestrator(octokit, llm, config, {
        pricingContext: {
          provider: appCtx.provider ?? config.provider,
          model: modelForRole(config, 'groupReview'),
          baseUrl: appCtx.baseUrl ?? config.baseUrl,
        },
      });
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
      applyProviderOverride(config, appCtx.provider);
      applyModelOverride(config, appCtx.model);
      const llm = createLLMProvider({
        apiKey: appCtx.apiKey,
        provider: appCtx.provider ?? config.provider,
        model: modelForRole(config, 'groupReview'),
        baseUrl: appCtx.baseUrl ?? config.baseUrl,
        userAgent: appCtx.userAgent ?? config.userAgent,
        modelParams: config.modelParams,
      });

      const { data: pr } = await octokit.pulls.get({
        owner,
        repo,
        pull_number: pullNumber,
      });

      const orchestrator = new ReviewOrchestrator(octokit, llm, config, {
        pricingContext: {
          provider: appCtx.provider ?? config.provider,
          model: modelForRole(config, 'groupReview'),
          baseUrl: appCtx.baseUrl ?? config.baseUrl,
        },
      });
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
    applyProviderOverride(config, appCtx.provider);
    applyModelOverride(config, appCtx.model);
    if (!config.review.auto.onReviewRequest) return;

    logger.info({ owner, repo, pullNumber }, 'Review requested');

    const llm = createLLMProvider({
      apiKey: appCtx.apiKey,
      provider: appCtx.provider ?? config.provider,
      model: modelForRole(config, 'groupReview'),
      baseUrl: appCtx.baseUrl ?? config.baseUrl,
      userAgent: appCtx.userAgent ?? config.userAgent,
      modelParams: config.modelParams,
    });

    const orchestrator = new ReviewOrchestrator(octokit, llm, config, {
      pricingContext: {
        provider: appCtx.provider ?? config.provider,
        model: modelForRole(config, 'groupReview'),
        baseUrl: appCtx.baseUrl ?? config.baseUrl,
      },
    });
    await orchestrator.reviewPullRequest({ owner, repo, pullNumber, headSha });
  });
  webhooks.on(
    ['pull_request_review_thread.resolved', 'pull_request_review_thread.unresolved'] as unknown as Parameters<
      Webhooks['on']
    >[0],
    async ({ payload, id }) => {
      const event = payload as unknown as ThreadWebhookPayload;
      const installationId = event.installation?.id;
      if (!installationId) return;
      const octokit = await appCtx.getInstallationOctokit(installationId);
      await handleFiscalcrThreadEvent(octokit, {
        owner: event.repository.owner.login,
        repo: event.repository.name,
        pullNumber: event.pull_request.number,
        headSha: event.pull_request.head.sha,
        threadId: event.review_thread?.node_id ?? event.review_thread?.id,
        action: event.action,
        eventId: id,
      });
    },
  );
}

interface ThreadWebhookPayload {
  action: 'resolved' | 'unresolved';
  installation?: { id?: number };
  repository: { owner: { login: string }; name: string };
  pull_request: { number: number; head: { sha: string } };
  review_thread?: { id?: string | number; node_id?: string };
}

export async function handleFiscalcrThreadEvent(
  octokit: Octokit,
  input: {
    owner: string;
    repo: string;
    pullNumber: number;
    headSha: string;
    threadId?: string | number;
    action: 'resolved' | 'unresolved';
    eventId?: string;
  },
): Promise<void> {
  if (!input.threadId || input.action === 'unresolved') return;
  const threadId = String(input.threadId);
  const eventKey = input.eventId ?? `${input.action}:${threadId}:${input.headSha}`;

  for (let attempt = 0; attempt < 2; attempt++) {
    const sticky = await loadReviewState(octokit, input);
    const state = sticky?.state;
    if (!sticky || !state) return;
    if (state.recentEvents.includes(eventKey)) return;
    if (state.autoResolvedThreads.includes(threadId)) return;

    const threads = await listFiscalcrThreads(octokit, input);
    const thread = threads.find((candidate) => candidate.id === threadId);
    if (!thread || !thread.isResolved) return;
    const updated = applyManualThreadResolution(state, {
      fingerprint: thread.fingerprint,
      threadId,
      eventKey,
      at: new Date().toISOString(),
    });
    try {
      await saveStickyComment(octokit, {
        owner: input.owner,
        repo: input.repo,
        pullNumber: input.pullNumber,
        commentId: sticky.commentId,
        body: replaceStateMarker(sticky.body, updated),
      });
      return;
    } catch (err) {
      if (attempt === 1) throw err;
      logger.warn({ err, threadId }, 'Thread event state save failed — rereading and retrying');
    }
  }
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

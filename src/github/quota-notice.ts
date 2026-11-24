import type { ReviewConfig } from '../config/schema.js';
import type { FiscalcrOctokit } from './client.js';
import { quotaExhaustedError, type LLMApiError } from '../utils/errors.js';
import { withReviewStateLock } from './review-state.js';
import { logger } from '../utils/logger.js';

/** Identifies the notice so later runs update it instead of stacking comments. */
export const QUOTA_NOTICE_MARKER = '<!-- fiscalcr:quota-exhausted -->';

type Provider = ReviewConfig['provider'];

/** Provider names as shown to PR readers. Custom endpoint URLs stay private. */
const PROVIDER_LABELS: Record<Provider, string> = {
  anthropic: 'Anthropic',
  openai: 'OpenAI',
  kimi: 'Kimi',
  openrouter: 'OpenRouter',
  'openai-compatible': 'OpenAI-compatible endpoint',
};

const MAX_REASON_LENGTH = 500;

/**
 * Human-readable message from a provider error body. Returns null for bodies
 * without one, so raw responses (HTML, request metadata) never reach the PR.
 */
function providerMessage(err: LLMApiError): string | null {
  try {
    const body = JSON.parse(String(err.responseBody ?? ''));
    const message: unknown = body?.error?.message ?? body?.message ?? body?.error;
    if (typeof message !== 'string') return null;
    // Keep it on one line and unable to close the code fence it is shown in.
    return message.replace(/`/g, "'").replace(/\s+/g, ' ').trim().slice(0, MAX_REASON_LENGTH) || null;
  } catch {
    return null;
  }
}

/** One skipped run: the PR head it would have reviewed. */
export interface SkippedCommit {
  sha: string;
  provider: string;
  /** `YYYY-MM-DD HH:MM` in UTC. */
  skippedAt: string;
}

/** Oldest rows drop first, which keeps the comment far below GitHub's size limit. */
const MAX_ROWS = 100;
const ROW_PATTERN = /^\| ([0-9a-f]{7,40}) \| ([^|]+) \| (\d{4}-\d{2}-\d{2} \d{2}:\d{2}) UTC \|$/gm;

/** The table is its own storage: read rows back from an earlier notice. */
function parseSkippedCommits(body: string): SkippedCommit[] {
  return [...body.matchAll(ROW_PATTERN)].map(([, sha, provider, skippedAt]) => ({
    sha,
    provider,
    skippedAt,
  }));
}

/**
 * Comment template. Keep bot commands out of it: App mode parses every new PR
 * comment for commands, so naming one here would trigger another review.
 */
export function renderQuotaNotice(
  err: LLMApiError,
  provider: Provider,
  headSha: string,
  previousBody = '',
  now = new Date(),
): string {
  const label = PROVIDER_LABELS[provider];
  const skipped = [
    // A re-run of the same commit replaces its row.
    ...parseSkippedCommits(previousBody).filter((commit) => commit.sha !== headSha),
    { sha: headSha, provider: label, skippedAt: now.toISOString().slice(0, 16).replace('T', ' ') },
  ].slice(-MAX_ROWS);
  const reason = providerMessage(err);
  return [
    QUOTA_NOTICE_MARKER,
    `## ⚠️ FiscalCR review skipped: ${label} limit reached`,
    '',
    `Commit \`${headSha.slice(0, 7)}\` was not reviewed because the **${label}** account has run out of API credit or reached its usage limit.`,
    '',
    ...(reason ? [`**Message from ${label}:**`, '```text', reason, '```', ''] : []),
    'Once credit is topped up or the limit resets, re-run the workflow or push a new commit to get a review.',
    '',
    '### Commits not reviewed',
    '',
    '| Commit | Provider | Skipped at |',
    '| --- | --- | --- |',
    // Bare full SHAs: GitHub shortens and links them.
    ...skipped.map((commit) => `| ${commit.sha} | ${commit.provider} | ${commit.skippedAt} UTC |`),
    '',
    '---',
    '*Powered by [FiscalCR](https://github.com/mof-malaysia/fiscal-cr) — model-agnostic AI code review*',
  ].join('\n');
}

async function findNotice(
  octokit: FiscalcrOctokit,
  params: { owner: string; repo: string; pullNumber: number },
): Promise<{ id: number; body?: string } | null> {
  for (let page = 1; ; page++) {
    const { data } = await octokit.issues.listComments({
      owner: params.owner,
      repo: params.repo,
      issue_number: params.pullNumber,
      per_page: 100,
      page,
    });
    const match = data.find(
      (comment) =>
        comment.body?.startsWith(QUOTA_NOTICE_MARKER) &&
        (comment.user?.login === 'github-actions[bot]' || Boolean(comment.performed_via_github_app)),
    );
    if (match) return match;
    if (data.length < 100) return null;
  }
}

/**
 * Create or update the PR's quota notice when `err` is a quota failure.
 * Best effort: a GitHub failure must not mask the review error.
 */
export async function postQuotaNotice(
  octokit: FiscalcrOctokit,
  params: { owner: string; repo: string; pullNumber: number; headSha: string; provider: Provider; err: unknown },
): Promise<void> {
  const { owner, repo, pullNumber, headSha, provider } = params;
  const quotaError = quotaExhaustedError(params.err);
  if (!quotaError) return;

  try {
    // Read-modify-write: serialize so concurrent App runs don't drop rows.
    await withReviewStateLock(`${owner}/${repo}#${pullNumber}`, async () => {
      const previous = await findNotice(octokit, params);
      const body = renderQuotaNotice(quotaError, provider, headSha, previous?.body);
      if (previous) {
        await octokit.issues.updateComment({ owner, repo, comment_id: previous.id, body });
      } else {
        await octokit.issues.createComment({ owner, repo, issue_number: pullNumber, body });
      }
    });
  } catch (err) {
    logger.warn({ err, pullNumber }, 'Could not post quota notice — skipping');
  }
}

import { describe, expect, it, vi } from 'vitest';
import { DEFAULT_CONFIG } from '../../src/config/defaults.js';
import type { FiscalcrOctokit } from '../../src/github/client.js';
import { QUOTA_NOTICE_MARKER, postQuotaNotice, renderQuotaNotice } from '../../src/github/quota-notice.js';
import { ReviewOrchestrator } from '../../src/review/orchestrator.js';
import { isApiQuotaExhausted, LLMApiError, ReviewError } from '../../src/utils/errors.js';

const MESSAGE =
  'You have reached your specified API usage limits. You will regain access on 2026-12-01 at 00:00 UTC.';
const quotaError = () =>
  new LLMApiError(
    'Anthropic API error: 400 Bad Request',
    400,
    JSON.stringify({ type: 'error', error: { message: MESSAGE }, request_id: 'req_secret' }),
  );

function fakeOctokit(comments: unknown[] = []) {
  const content = Buffer.from('x'.repeat(90_000)).toString('base64');
  const patch = '@@ -1,1 +1,3 @@\n a\n+b\n+c';
  const file = (filename: string) => ({ filename, status: 'modified', additions: 200, deletions: 0, patch });
  const issues = {
    listComments: vi.fn(async () => ({ data: comments })),
    createComment: vi.fn(async (_: { body: string }) => ({ data: { id: 9 } })),
    updateComment: vi.fn(async (_: { comment_id: number; body: string }) => ({})),
  };
  const octokit = {
    issues,
    checks: {
      create: vi.fn(async () => ({ data: { id: 42 } })),
      update: vi.fn(async () => ({})),
    },
    pulls: {
      get: vi.fn(async ({ mediaType }: { mediaType?: unknown }) =>
        mediaType
          ? { data: 'the-diff' }
          : { data: { base: { sha: 'base' }, head: { sha: 'abcdef123' }, title: 't', body: '' } },
      ),
      listFiles: vi.fn(async () => ({ data: [file('src/a.ts'), file('lib/b.ts')] })),
    },
    repos: { getContent: vi.fn(async () => ({ data: { content, encoding: 'base64' } })) },
  };
  return { octokit: octokit as unknown as FiscalcrOctokit, issues };
}

const pr = { owner: 'o', repo: 'r', pullNumber: 1, headSha: 'abcdef123' };

describe('renderQuotaNotice', () => {
  it('shows the provider message and commit without raw response data', () => {
    const body = renderQuotaNotice(quotaError(), 'anthropic', pr.headSha);
    expect(body).toContain(MESSAGE);
    expect(body).toContain('`abcdef1`');
    expect(body).not.toContain('req_secret');
    // A bot mention would make App mode treat the notice as a command.
    expect(body).not.toContain('@fiscalcr');
  });

  it.each([
    ['anthropic', 'Anthropic'],
    ['openai', 'OpenAI'],
    ['kimi', 'Kimi'],
    ['openrouter', 'OpenRouter'],
    ['openai-compatible', 'OpenAI-compatible endpoint'],
  ] as const)('names the provider: %s', (provider, label) => {
    const body = renderQuotaNotice(quotaError(), provider, 'a');
    expect(body).toContain(`review skipped: ${label} limit reached`);
    expect(body).toContain(`**${label}** account`);
    expect(body).toContain(`**Message from ${label}:**`);
  });

  it('omits unparseable bodies and keeps the message inside its fence', () => {
    expect(renderQuotaNotice(new LLMApiError('x', 402, '<html>boom</html>'), 'kimi', 'a')).not.toContain('boom');
    const fenced = renderQuotaNotice(new LLMApiError('x', 402, '{"error":{"message":"a\\n```\\nb"}}'), 'kimi', 'a');
    expect(fenced).toContain("```text\na ''' b\n```");
  });
});

describe('commits not reviewed table', () => {
  const at = (hour: string) => new Date(`2026-11-24T${hour}:00:00Z`);
  const row = (sha: string, provider: string, hour: string) =>
    `| ${sha} | ${provider} | 2026-11-24 ${hour}:00 UTC |`;

  it('accumulates commits across runs and providers, one row per commit', () => {
    let body = renderQuotaNotice(quotaError(), 'anthropic', 'aaaaaaa', '', at('01'));
    body = renderQuotaNotice(quotaError(), 'kimi', 'bbbbbbb', body, at('02'));
    body = renderQuotaNotice(quotaError(), 'openai-compatible', 'aaaaaaa', body, at('03'));
    expect(body.match(/^\| [0-9a-f]{7} .*$/gm)).toEqual([
      row('bbbbbbb', 'Kimi', '02'),
      row('aaaaaaa', 'OpenAI-compatible endpoint', '03'),
    ]);
  });

  it('keeps the newest rows when the table is full', () => {
    let body = '';
    for (let i = 0; i < 102; i++) {
      body = renderQuotaNotice(quotaError(), 'kimi', i.toString(16).padStart(40, '0'), body);
    }
    expect(body.match(/^\| [0-9a-f]{40} /gm)).toHaveLength(100);
    expect(body).toContain((101).toString(16).padStart(40, '0'));
  });
});

describe('postQuotaNotice', () => {
  it('updates its own notice instead of stacking, ignoring copies by users', async () => {
    const { octokit, issues } = fakeOctokit([
      { id: 1, body: QUOTA_NOTICE_MARKER, user: { login: 'someone' } },
      { id: 2, body: `${QUOTA_NOTICE_MARKER}\n| ccccccc | Kimi | 2026-11-23 09:00 UTC |`, user: { login: 'github-actions[bot]' } },
    ]);
    await postQuotaNotice(octokit, { ...pr, provider: 'anthropic', err: quotaError() });
    expect(issues.updateComment).toHaveBeenCalledWith(expect.objectContaining({ comment_id: 2 }));
    const { body } = issues.updateComment.mock.calls[0][0];
    expect(body).toContain('| ccccccc | Kimi | 2026-11-23 09:00 UTC |');
    expect(body).toContain('| abcdef123 | Anthropic |');
    expect(issues.createComment).not.toHaveBeenCalled();
  });

  it('does not throw when GitHub rejects the comment', async () => {
    const { octokit, issues } = fakeOctokit();
    issues.createComment.mockRejectedValue(new Error('403'));
    await expect(postQuotaNotice(octokit, { ...pr, provider: 'anthropic', err: quotaError() })).resolves.toBeUndefined();
  });
});

describe('ReviewOrchestrator quota notice', () => {
  const run = async (error: Error, fastPath: boolean) => {
    const { octokit, issues } = fakeOctokit();
    const llm = { chatCompletion: vi.fn(async () => { throw error; }) };
    const config = {
      ...DEFAULT_CONFIG,
      provider: 'openai' as const,
      pipeline: { ...DEFAULT_CONFIG.pipeline, fastPathThreshold: fastPath ? 1_000_000 : 1 },
    };
    const thrown = await new ReviewOrchestrator(octokit, llm, config).reviewPullRequest(pr).catch((e) => e);
    expect(thrown).toBeInstanceOf(ReviewError);
    expect(isApiQuotaExhausted(thrown)).toBe(isApiQuotaExhausted(error));
    const multiPass = llm.chatCompletion.mock.calls.length > 1;
    if (isApiQuotaExhausted(error)) expect(multiPass).toBe(!fastPath);
    return issues;
  };

  it.each([true, false])('comments once when credit runs out (fast path: %s)', async (fastPath) => {
    const issues = await run(quotaError(), fastPath);
    expect(issues.createComment).toHaveBeenCalledTimes(1);
    expect(issues.createComment.mock.calls[0][0].body).toContain(MESSAGE);
    expect(issues.createComment.mock.calls[0][0].body).toContain('**OpenAI** account');
  });

  it('does not comment on other failures', async () => {
    const issues = await run(new LLMApiError('bad key', 401, '{}'), true);
    expect(issues.createComment).not.toHaveBeenCalled();
  });
});

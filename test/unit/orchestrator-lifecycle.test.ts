import { describe, expect, it, vi } from 'vitest';
import { ReviewOrchestrator } from '../../src/review/orchestrator.js';
import { handleFiscalcrThreadEvent } from '../../src/github/webhooks.js';
import { DEFAULT_CONFIG } from '../../src/config/defaults.js';
import type { ReviewConfig } from '../../src/config/schema.js';
import { fingerprintAnnotation, fingerprintMarker } from '../../src/github/fingerprint.js';
import {
  EMPTY_COUNTS,
  parseStateMarker,
  renderStateMarker,
  type LegacyReviewState,
  type ReviewState,
} from '../../src/github/review-state.js';
import type { ReviewAnnotation } from '../../src/types/review.js';

const PATCH = '@@ -1,2 +1,3 @@\n line one\n+line two\n+line three';

const FINDING: ReviewAnnotation = {
  path: 'src/a.ts',
  startLine: 2,
  endLine: 2,
  severity: 'critical',
  category: 'bug',
  title: 'Null deref in handler',
  body: 'Crashes on empty input',
  confidence: 0.95,
};
const FP = fingerprintAnnotation(FINDING);

function priorState(overrides: Partial<ReviewState> = {}): ReviewState {
  return {
    v: 2,
    lastReviewedSha: 'old-sha',
    baseSha: 'base-sha',
    blockingReviewId: 7,
    findings: [{
      fingerprint: FP,
      status: 'open',
      severity: 'critical',
      path: FINDING.path,
      startLine: FINDING.startLine,
      endLine: FINDING.endLine,
      title: FINDING.title,
      threadId: 't1',
      lastSeenSha: 'old-sha',
      transitions: [{ status: 'open', at: '2026-01-01', source: 'review' }],
    }],
    recentEvents: [],
    autoResolvedThreads: [],
    checkRunId: null,
    checkRunHeadSha: null,
    runs: [],
    ...overrides,
  };
}
interface Fixture {
  stickyState?: ReviewState;
  legacyState?: LegacyReviewState;
  compareFiles?: string[];
  changedFiles?: string[];
  threads?: Array<{ id: string; fp: string; path: string; severity: string }>;
}
function fakeOctokit(fixture: Fixture = {}) {
  const stickyBody = fixture.legacyState
    ? `summary\n${renderStateMarker(fixture.legacyState)}`
    : fixture.stickyState
      ? `summary\n${renderStateMarker(fixture.stickyState)}`
      : null;
  return {
    checks: {
      create: vi.fn(async () => ({ data: { id: 42 } })),
      update: vi.fn(async () => ({})),
    },
    pulls: {
      get: vi.fn(async ({ mediaType }: { mediaType?: { format: string } }) => {
        if (mediaType?.format === 'diff') return { data: 'the-diff' };
        return {
          data: {
            base: { sha: 'base-sha' },
            head: { sha: 'new-sha' },
            title: 'Add feature',
            body: 'Does things',
          },
        };
      }),
      listFiles: vi.fn(async ({ page }: { page: number }) =>
        page === 1
          ? {
              data: (fixture.changedFiles ?? ['src/a.ts', 'src/b.ts']).map((filename) => ({
                filename,
                status: 'modified',
                additions: 2,
                deletions: 0,
                patch: PATCH,
              })),
            }
          : { data: [] },
      ),
      createReview: vi.fn(async () => ({ data: { id: 11 } })),
      dismissReview: vi.fn(async () => ({})),
    },
    repos: {
      getContent: vi.fn(async ({ path }: { path: string }) => ({
        data: {
          content: Buffer.from(`// content of ${path}\n`).toString('base64'),
          encoding: 'base64',
        },
      })),
      compareCommitsWithBasehead: vi.fn(async () => ({
        data: {
          status: 'ahead',
          files: (fixture.compareFiles ?? ['src/a.ts']).map((filename) => ({
            filename,
            status: 'modified',
            additions: 2,
            deletions: 0,
            patch: PATCH,
          })),
        },
      })),
    },
    issues: {
      listComments: vi.fn(async () => ({
        data: stickyBody ? [{ id: 3, body: stickyBody, performed_via_github_app: { id: 1 } }] : [],
      })),
      createComment: vi.fn(async () => ({ data: { id: 9 } })),
      updateComment: vi.fn(async () => ({})),
    },
    graphql: vi.fn(async (query: string) => {
      if (query.includes('reviewThreads')) {
        return {
          repository: {
            pullRequest: {
              reviewThreads: {
                pageInfo: { hasNextPage: false, endCursor: null },
                nodes: (fixture.threads ?? []).map((t) => ({
                  id: t.id,
                  isResolved: false,
                  path: t.path,
                  comments: {
                    nodes: [{ body: `🔴 **[${t.severity}]** x\n\n${fingerprintMarker(t.fp)}` }],
                  },
                })),
              },
            },
          },
        };
      }
      return {};
    }),
  };
}

function fastPathLLM(findings: ReviewAnnotation[]) {
  return {
    chatCompletion: vi.fn(async (params: { messages: Array<{ content: string }> }) => ({
      content: JSON.stringify({
        intent: 'Adds a feature',
        summary: 'Reviewed',
        score: 70,
        walkthrough: [{ path: 'src/a.ts', summary: 'changed' }],
        findings,
      }),
      usage: { input: 100, output: 50, cached: 0 },
    })),
  };
}

function cfg(overrides: Partial<ReviewConfig['review']> = {}): ReviewConfig {
  return {
    ...DEFAULT_CONFIG,
    review: { ...DEFAULT_CONFIG.review, ...overrides },
  };
}

const params = { owner: 'o', repo: 'r', pullNumber: 1, headSha: 'new-sha' };

function savedState(octokit: ReturnType<typeof fakeOctokit>): ReviewState | null {
  const update = octokit.issues.updateComment.mock.calls.at(-1)?.[0] as
    | { body: string }
    | undefined;
  const create = octokit.issues.createComment.mock.calls.at(-1)?.[0] as
    | { body: string }
    | undefined;
  const body = update?.body ?? create?.body;
  return body ? parseStateMarker(body) : null;
}

describe('ReviewOrchestrator sticky lifecycle', () => {
  it('first run: full review, blocking review posted, sticky comment created with state', async () => {
    const octokit = fakeOctokit();
    const llm = fastPathLLM([FINDING]);
    const orchestrator = new ReviewOrchestrator(octokit as never, llm, cfg());

    const result = await orchestrator.reviewPullRequest(params);

    // Blocking review with the inline comment + fingerprint marker
    const review = octokit.pulls.createReview.mock.calls[0][0] as {
      event: string;
      comments: Array<{ body: string }>;
    };
    expect(review.event).toBe('REQUEST_CHANGES');
    expect(review.comments).toHaveLength(1);
    expect(review.comments[0].body).toContain(fingerprintMarker(FP));

    // Sticky comment created with persisted state
    const state = savedState(octokit);
    expect(state).toMatchObject({
      lastReviewedSha: 'new-sha',
      baseSha: 'base-sha',
      blockingReviewId: 11,
    });
    expect(state!.findings).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ fingerprint: FP, status: 'open', severity: 'critical' }),
      ]),
    );
    expect(state!.runs).toHaveLength(1);
    expect(state!.runs[0].scope).toBe('full');

    // Check run failed on the critical
    const check = octokit.checks.update.mock.calls.at(-1)?.[0] as { conclusion: string };
    expect(check.conclusion).toBe('failure');
    expect(result.stats.critical).toBe(1);
  });

  it('persists a new inline thread ID for immediate webhook resolution', async () => {
    const octokit = fakeOctokit();
    let stickyBody: string | null = null;
    let threadListCalls = 0;
    let resolved = false;
    octokit.issues.listComments = vi.fn(async () => ({
      data: stickyBody
        ? [{ id: 3, body: stickyBody, performed_via_github_app: { id: 1 } }]
        : [],
    }));
    octokit.issues.createComment = vi.fn(async ({ body }: { body: string }) => {
      stickyBody = body;
      return { data: { id: 3 } };
    });
    octokit.issues.updateComment = vi.fn(async ({ body }: { body: string }) => {
      stickyBody = body;
      return {};
    });
    octokit.graphql = vi.fn(async (query: string) => {
      if (!query.includes('reviewThreads')) return {};
      threadListCalls++;
      const nodes = threadListCalls === 1
        ? []
        : [{
            id: 'new-thread',
            isResolved: resolved,
            isOutdated: false,
            path: FINDING.path,
            comments: { nodes: [{ body: `**[critical]** ${FINDING.title}\n${fingerprintMarker(FP)}` }] },
          }];
      return {
        repository: {
          pullRequest: {
            reviewThreads: {
              pageInfo: { hasNextPage: false, endCursor: null },
              nodes,
            },
          },
        },
      };
    });
    const orchestrator = new ReviewOrchestrator(octokit as never, fastPathLLM([FINDING]), cfg());

    await orchestrator.reviewPullRequest(params);
    expect(savedState(octokit)!.findings.find((finding) => finding.fingerprint === FP)?.threadId).toBe('new-thread');

    resolved = true;
    await handleFiscalcrThreadEvent(octokit as never, {
      owner: 'o',
      repo: 'r',
      pullNumber: 1,
      headSha: 'new-sha',
      threadId: 'new-thread',
      action: 'resolved',
      eventId: 'delivery-new-thread',
    });
    expect(parseStateMarker(stickyBody!)!.v).toBe(2);
    const afterWebhook = parseStateMarker(stickyBody!);
    if (afterWebhook?.v === 2) {
      expect(afterWebhook.findings.find((finding) => finding.fingerprint === FP)?.status).toBe('dismissed');
    }
  });

  it('delta run: recurring finding is deduped, blocking review re-anchored to head', async () => {
    const octokit = fakeOctokit({
      stickyState: priorState(),
      threads: [{ id: 't1', fp: FP, path: 'src/a.ts', severity: 'critical' }],
    });
    const llm = fastPathLLM([FINDING]); // same finding recurs
    const orchestrator = new ReviewOrchestrator(octokit as never, llm, cfg());

    const result = await orchestrator.reviewPullRequest(params);

    // Delta scope: prompt carries the incremental hint, context is path-filtered
    const prompt = llm.chatCompletion.mock.calls[0][0].messages[1].content;
    expect(prompt).toContain('Only files changed since commit `old-sha`'.slice(0, 30));
    expect(prompt).not.toContain('src/b.ts');

    // Recurred finding: not re-posted inline, its thread not resolved
    const review = octokit.pulls.createReview.mock.calls[0][0] as {
      event: string;
      comments: unknown[];
    };
    expect(review.event).toBe('REQUEST_CHANGES');
    expect(review.comments).toHaveLength(0);
    const mutations = octokit.graphql.mock.calls.filter(([q]) =>
      (q as string).includes('resolveReviewThread'),
    );
    expect(mutations).toHaveLength(0);

    // Old blocking review dismissed, new one recorded
    expect(octokit.pulls.dismissReview).toHaveBeenCalledWith(
      expect.objectContaining({ review_id: 7, message: expect.stringContaining('Superseded') }),
    );
    const state = savedState(octokit);
    expect(state!.blockingReviewId).toBe(11);
    expect(state!.findings.find((finding) => finding.fingerprint === FP)?.status).toBe('open');
    expect(state!.runs.at(-1)!.scope).toBe('delta');
    expect(result.stats.critical).toBe(1);

    // Sticky updated in place, not recreated
    expect(octokit.issues.updateComment).toHaveBeenCalledWith(
      expect.objectContaining({ comment_id: 3 }),
    );
    expect(octokit.issues.createComment).not.toHaveBeenCalled();
  });

  it('delta fix candidate: leaves thread open without full coverage', async () => {
    const octokit = fakeOctokit({
      stickyState: priorState(),
      threads: [{ id: 't1', fp: FP, path: 'src/a.ts', severity: 'critical' }],
    });
    const llm = fastPathLLM([]); // the issue is fixed
    const orchestrator = new ReviewOrchestrator(octokit as never, llm, cfg());

    const result = await orchestrator.reviewPullRequest(params);

    const mutations = octokit.graphql.mock.calls.filter(([q]) =>
      (q as string).includes('resolveReviewThread'),
    );
    expect(mutations).toHaveLength(0);

    expect(octokit.pulls.dismissReview).toHaveBeenCalledWith(
      expect.objectContaining({
        review_id: 7,
        message: expect.stringContaining('Superseded'),
      }),
    );
    // Existing open finding remains blocking; no lifecycle cleanup means a replacement review is posted.
    expect(octokit.pulls.createReview).toHaveBeenCalledWith(
      expect.objectContaining({ event: 'REQUEST_CHANGES', comments: [] }),
    );

    const check = octokit.checks.update.mock.calls.at(-1)?.[0] as { conclusion: string };
    expect(check.conclusion).toBe('failure');
    const state = savedState(octokit);
    expect(state!.findings.find((finding) => finding.fingerprint === FP)?.status).toBe('open');
    expect(state!.blockingReviewId).toBe(11);
    expect(result.stats.critical).toBe(1);
  });

  it('migrates a v1 marker before skipping a PR with no reviewable files', async () => {
    const legacyState: LegacyReviewState = {
      v: 1,
      lastReviewedSha: 'old-sha',
      baseSha: 'base-sha',
      blockingReviewId: null,
      postedFingerprints: [],
      openCounts: { ...EMPTY_COUNTS },
      runs: [],
    };
    const octokit = fakeOctokit({ legacyState, changedFiles: ['package-lock.json'] });
    const llm = fastPathLLM([]);
    const orchestrator = new ReviewOrchestrator(octokit as never, llm, cfg());

    await orchestrator.reviewPullRequest(params);

    expect(llm.chatCompletion).not.toHaveBeenCalled();
    const migrated = savedState(octokit);
    expect(migrated).toMatchObject({ v: 2, migratedFromV1: true });
    expect(octokit.issues.updateComment).toHaveBeenCalledWith(
      expect.objectContaining({ comment_id: 3 }),
    );
  });

  it('skip run: no LLM calls, conclusion carried from open counts', async () => {
    const baseFinding = priorState().findings[0];
    const octokit = fakeOctokit({
      stickyState: priorState({
        lastReviewedSha: 'new-sha',
        findings: [
          { ...baseFinding, fingerprint: 'fp-one' },
          { ...baseFinding, fingerprint: 'fp-two' },
        ],
      }),
    });
    const llm = fastPathLLM([]);
    const orchestrator = new ReviewOrchestrator(octokit as never, llm, cfg());

    const result = await orchestrator.reviewPullRequest(params);

    expect(llm.chatCompletion).not.toHaveBeenCalled();
    expect(octokit.pulls.createReview).not.toHaveBeenCalled();
    expect(octokit.issues.updateComment).toHaveBeenCalled();
    const check = octokit.checks.update.mock.calls.at(-1)?.[0] as { conclusion: string };
    expect(check.conclusion).toBe('failure');
    expect(result.stats.critical).toBe(2);
    expect(result.callCount).toBe(0);
  });

  it('forceFull re-reviews everything but still dedupes posted findings', async () => {
    const octokit = fakeOctokit({ stickyState: priorState() });
    const llm = fastPathLLM([FINDING]);
    const orchestrator = new ReviewOrchestrator(octokit as never, llm, cfg());

    await orchestrator.reviewPullRequest({ ...params, forceFull: true });

    // Full scope: both PR files in the prompt
    const prompt = llm.chatCompletion.mock.calls[0][0].messages[1].content;
    expect(prompt).toContain('src/b.ts');

    // Recurring finding still deduped — blocking review re-posted body-only
    const review = octokit.pulls.createReview.mock.calls[0][0] as { comments: unknown[] };
    expect(review.comments).toHaveLength(0);
    const state = savedState(octokit);
    expect(state!.runs.at(-1)!.scope).toBe('full');
  });
  it('reuses a persisted check only when its head still matches', async () => {
    const octokit = fakeOctokit({
      stickyState: priorState({
        lastReviewedSha: 'new-sha',
        checkRunId: 42,
        checkRunHeadSha: 'new-sha',
      }),
    });
    octokit.checks.get = vi.fn(async () => ({ data: { head_sha: 'new-sha' } }));
    const orchestrator = new ReviewOrchestrator(octokit as never, fastPathLLM([]), cfg());

    await orchestrator.reviewPullRequest({ ...params, forceFull: true });

    expect(octokit.checks.create).not.toHaveBeenCalled();
    expect(octokit.checks.update.mock.calls[0][0].check_run_id).toBe(42);
  });


  it('Action mode uses the workflow check instead of creating a duplicate', async () => {
    const octokit = fakeOctokit();
    const llm = fastPathLLM([]);
    const orchestrator = new ReviewOrchestrator(octokit as never, llm, cfg(), {
      createCheckRun: false,
    });

    await orchestrator.reviewPullRequest(params);

    expect(octokit.checks.create).not.toHaveBeenCalled();
    expect(octokit.checks.update).not.toHaveBeenCalled();
  });

  it('legacy mode: stacked full review, no sticky comment or state involved', async () => {
    const octokit = fakeOctokit();
    const llm = fastPathLLM([FINDING]);
    const config = cfg({
      comments: { ...DEFAULT_CONFIG.review.comments, mode: 'legacy' },
    });
    const orchestrator = new ReviewOrchestrator(octokit as never, llm, config);

    await orchestrator.reviewPullRequest(params);

    expect(octokit.issues.listComments).not.toHaveBeenCalled();
    expect(octokit.issues.createComment).not.toHaveBeenCalled();
    const review = octokit.pulls.createReview.mock.calls[0][0] as { body: string; event: string };
    expect(review.event).toBe('REQUEST_CHANGES');
    expect(review.body).toContain('FiscalCR Code Review');
  });
});

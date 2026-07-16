import type { Octokit } from '@octokit/rest';
import type { ReviewConfig } from '../config/schema.js';
import type { PullRequestContext, ReviewResult, Severity } from '../types/review.js';
import type { LLMProvider } from '../providers/interface.js';
import { extractPullRequestContext } from '../github/pulls.js';
import { createCheckRun, completeCheckRun } from '../github/checks.js';
import {
  createIncrementalReview,
  createPRReview,
  dismissBlockingReview,
} from '../github/comments.js';
import { fingerprintAnnotation } from '../github/fingerprint.js';
import {
  EMPTY_COUNTS,
  appendFingerprints,
  appendRun,
  loadReviewState,
  renderStickyComment,
  saveStickyComment,
  type ReviewState,
  type StickyComment,
} from '../github/review-state.js';
import { resolveOutdatedThreads } from '../github/threads.js';
import { decideScope, type ScopeDecision } from './delta.js';
import { filterFiles } from './file-filter.js';
import { buildSummary } from './summary-builder.js';
import { ApiFileSource, LocalFileSource } from './file-source.js';
import { runIntentPass } from '../pipeline/pass1-intent.js';
import { groupFiles } from '../pipeline/grouper.js';
import { runReviewPass } from '../pipeline/pass2-review.js';
import {
  countBySeverity,
  deterministicScore,
  synthesize,
  validateAndRankFindings,
} from '../pipeline/pass3-synthesis.js';
import { runFastPath } from '../pipeline/fast-path.js';
import { UsageTracker } from '../pipeline/usage.js';
import { calculateCost, estimateTokens } from '../utils/tokens.js';
import { ReviewError } from '../utils/errors.js';
import { logger } from '../utils/logger.js';

interface ReviewParams {
  owner: string;
  repo: string;
  pullNumber: number;
  headSha: string;
  /** Review the whole PR even when a delta would suffice (@fiscalcr review). */
  forceFull?: boolean;
}

export interface OrchestratorOptions {
  /** Local checkout root (Action mode). Enables disk reads instead of API fetches. */
  workspaceRoot?: string;
}

function conclusionFor(
  counts: Record<Severity, number>,
  failOn: ReviewConfig['review']['failOn'],
): 'success' | 'failure' {
  if (failOn === 'critical') return counts.critical > 0 ? 'failure' : 'success';
  if (failOn === 'warning')
    return counts.critical > 0 || counts.warning > 0 ? 'failure' : 'success';
  return 'success';
}

export class ReviewOrchestrator {
  constructor(
    private octokit: Octokit,
    private llm: LLMProvider,
    private config: ReviewConfig,
    private options: OrchestratorOptions = {},
  ) {}

  async reviewPullRequest(params: ReviewParams): Promise<ReviewResult> {
    const { owner, repo, pullNumber, headSha } = params;
    const sticky = this.config.review.comments.mode === 'sticky';

    // Step 1: Create Check Run
    const checkRunId = await createCheckRun(this.octokit, { owner, repo, headSha });

    try {
      // Step 2: Load state and decide review scope
      let stickyRef: StickyComment | null = null;
      let scope: ScopeDecision = {
        mode: 'full',
        reason: sticky ? 'no previous review state' : 'legacy comment mode',
      };
      if (sticky) {
        stickyRef = await loadReviewState(this.octokit, { owner, repo, pullNumber });
        if (stickyRef?.state) {
          const { data: pr } = await this.octokit.pulls.get({
            owner,
            repo,
            pull_number: pullNumber,
          });
          scope = await decideScope(this.octokit, {
            owner,
            repo,
            headSha,
            baseSha: pr.base.sha,
            state: stickyRef.state,
            forceFull: params.forceFull,
            config: this.config,
          });
        }
      }
      logger.info({ pullNumber, scope: scope.mode, reason: scope.reason }, 'Review scope decided');

      if (scope.mode === 'skip' && stickyRef?.state) {
        return await this.completeSkippedRun(
          { owner, repo, checkRunId },
          stickyRef.state,
          scope.reason,
        );
      }

      // Step 3: Extract PR context (path-filtered for delta reviews)
      logger.info({ pullNumber }, 'Extracting PR context');
      const apiSource = new ApiFileSource(this.octokit, owner, repo, headSha);
      const fileSource = this.options.workspaceRoot
        ? new LocalFileSource(this.options.workspaceRoot, apiSource)
        : apiSource;
      const prContext = await extractPullRequestContext(
        this.octokit,
        owner,
        repo,
        pullNumber,
        this.config,
        {
          fileSource,
          pathFilter: scope.mode === 'delta' ? scope.paths : undefined,
        },
      );

      // Step 4: Filter files
      const filteredFiles = filterFiles(prContext.changedFiles, this.config);
      prContext.changedFiles = filteredFiles;
      // Keep contents only for reviewable files (never prompt with lockfiles etc.)
      const reviewable = new Set(filteredFiles.map((f) => f.filename));
      for (const path of [...prContext.fileContents.keys()]) {
        if (!reviewable.has(path)) prContext.fileContents.delete(path);
      }

      if (filteredFiles.length === 0) {
        if (stickyRef?.state) {
          return await this.completeSkippedRun(
            { owner, repo, checkRunId },
            stickyRef.state,
            'no reviewable files in scope',
          );
        }
        const result: ReviewResult = {
          summary: 'No reviewable files in this PR (all files matched exclude patterns).',
          score: 100,
          annotations: [],
          stats: { ...EMPTY_COUNTS },
          tokensUsed: { input: 0, output: 0, cached: 0 },
        };
        await completeCheckRun(this.octokit, {
          owner,
          repo,
          checkRunId,
          conclusion: 'success',
          summary: result.summary,
          annotations: [],
        });
        return result;
      }

      // Step 5: Run the review (fast path or multi-pass pipeline)
      const deltaHint =
        scope.mode === 'delta' && scope.sinceSha
          ? `### Incremental Review\nOnly files changed since commit \`${scope.sinceSha.slice(0, 7)}\` are included. Focus on lines changed since that commit; findings on other files are tracked separately.`
          : undefined;
      const result = await this.runReview(prContext, deltaHint);

      // Step 6: Publish (sticky lifecycle or legacy stacked review)
      if (!sticky) {
        return await this.publishLegacy({ checkRunId, prContext, result });
      }
      return await this.publishSticky({
        checkRunId,
        prContext,
        result,
        scope,
        state: stickyRef?.state ?? null,
        commentId: stickyRef?.commentId ?? null,
      });
    } catch (err) {
      logger.error({ err, pullNumber }, 'Review failed');

      await completeCheckRun(this.octokit, {
        owner,
        repo,
        checkRunId,
        conclusion: 'failure',
        summary: `Review failed: ${err instanceof Error ? err.message : 'Unknown error'}`,
        annotations: [],
      });

      throw new ReviewError(
        err instanceof Error ? err.message : 'Unknown error',
        'orchestration',
      );
    }
  }

  /** Nothing to review — carry the previous conclusion so the check stays honest. */
  private async completeSkippedRun(
    target: { owner: string; repo: string; checkRunId: number },
    state: ReviewState,
    reason: string,
  ): Promise<ReviewResult> {
    const conclusion = conclusionFor(state.openCounts, this.config.review.failOn);
    const openTotal = Object.values(state.openCounts).reduce((a, b) => a + b, 0);
    const summary = `Review skipped: ${reason}. ${openTotal} open finding(s) carried from the last review of \`${state.lastReviewedSha.slice(0, 7)}\`.`;

    await completeCheckRun(this.octokit, {
      ...target,
      conclusion,
      summary,
      annotations: [],
      externalId: JSON.stringify({ scope: 'skip' }),
    });

    logger.info({ reason, conclusion }, 'Review skipped');
    return {
      summary,
      score: deterministicScore(state.openCounts),
      annotations: [],
      stats: { ...state.openCounts },
      tokensUsed: { input: 0, output: 0, cached: 0 },
      callCount: 0,
    };
  }

  /** Pre-sticky behavior: full review stacked on the PR every run. */
  private async publishLegacy(input: {
    checkRunId: number;
    prContext: PullRequestContext;
    result: ReviewResult;
  }): Promise<ReviewResult> {
    const { checkRunId, prContext, result } = input;
    const { owner, repo, pullNumber, headSha } = prContext;

    const conclusion = conclusionFor(result.stats, this.config.review.failOn);
    await completeCheckRun(this.octokit, {
      owner,
      repo,
      checkRunId,
      conclusion,
      summary: buildSummary(result),
      annotations: result.annotations,
    });

    await createPRReview(this.octokit, {
      owner,
      repo,
      pullNumber,
      commitSha: headSha,
      result,
      failOn: this.config.review.failOn,
    });

    logger.info(
      {
        pullNumber,
        score: result.score,
        annotations: result.annotations.length,
        llmCalls: result.callCount,
        conclusion,
      },
      'Review completed',
    );
    return result;
  }

  /**
   * Sticky lifecycle: dedupe vs posted fingerprints → resolve outdated threads
   * → manage the blocking review → post incremental review → update the sticky
   * summary comment (which persists the state — always saved last).
   */
  private async publishSticky(input: {
    checkRunId: number;
    prContext: PullRequestContext;
    result: ReviewResult;
    scope: ScopeDecision;
    state: ReviewState | null;
    commentId: number | null;
  }): Promise<ReviewResult> {
    const { checkRunId, prContext, result, scope, state } = input;
    const { owner, repo, pullNumber, headSha } = prContext;
    const commentsCfg = this.config.review.comments;
    const prevCounts = state?.openCounts ?? { ...EMPTY_COUNTS };

    // Dedupe against everything ever posted (including human-deleted comments —
    // deleting a bot comment must not invite a re-nag).
    const fingerprints = new Map(result.annotations.map((a) => [a, fingerprintAnnotation(a)]));
    const currentFingerprints = new Set(fingerprints.values());
    const alreadyPosted = new Set(state?.postedFingerprints ?? []);
    const newAnnotations =
      commentsCfg.dedupe && state
        ? result.annotations.filter((a) => !alreadyPosted.has(fingerprints.get(a)!))
        : result.annotations;

    // Cumulative inline cap: overflow lives in check-run annotations + sticky.
    const openTotal = Object.values(prevCounts).reduce((a, b) => a + b, 0);
    const inlineBudget = Math.max(0, commentsCfg.maxOpenComments - openTotal);
    const inlineNew = newAnnotations.slice(0, inlineBudget);
    const capOverflow = newAnnotations.slice(inlineBudget);
    if (capOverflow.length > 0) {
      logger.info(
        { overflow: capOverflow.length, cap: commentsCfg.maxOpenComments },
        'maxOpenComments reached — overflow findings demoted to check-run annotations',
      );
    }

    // Resolve threads whose file changed but whose finding did not recur.
    let resolvedCounts: Record<Severity, number> = { ...EMPTY_COUNTS };
    if (commentsCfg.resolveOutdated && state) {
      const resolved = await resolveOutdatedThreads(this.octokit, {
        owner,
        repo,
        pullNumber,
        changedPaths: new Set(prContext.changedFiles.map((f) => f.filename)),
        currentFingerprints,
        headSha,
      });
      for (const t of resolved) {
        if (t.severity) resolvedCounts[t.severity]++;
      }
    }

    // Cumulative open counts: a full review re-derives them; a delta adjusts.
    let openCounts: Record<Severity, number>;
    if (scope.mode === 'full') {
      openCounts = countBySeverity(result.annotations);
    } else {
      openCounts = { ...prevCounts };
      const newCounts = countBySeverity(newAnnotations);
      for (const sev of Object.keys(openCounts) as Severity[]) {
        openCounts[sev] = Math.max(0, openCounts[sev] - resolvedCounts[sev] + newCounts[sev]);
      }
    }

    const conclusion = conclusionFor(openCounts, this.config.review.failOn);
    const blocking = conclusion === 'failure';

    // Check run reflects cumulative PR health, not just this run's delta.
    await completeCheckRun(this.octokit, {
      owner,
      repo,
      checkRunId,
      conclusion,
      summary: buildSummary({ ...result, stats: openCounts }),
      annotations: result.annotations,
      externalId: JSON.stringify({
        scope: scope.mode,
        calls: result.callCount ?? 0,
        newFindings: newAnnotations.length,
      }),
    });

    // One live blocking review, anchored to the newest commit: always dismiss
    // the old one; re-post below when still failing.
    let blockingReviewId = state?.blockingReviewId ?? null;
    if (blockingReviewId !== null) {
      const message = blocking
        ? `Superseded by an updated review as of ${headSha.slice(0, 7)}.`
        : `✅ Issues addressed as of ${headSha.slice(0, 7)}.`;
      await dismissBlockingReview(this.octokit, {
        owner,
        repo,
        pullNumber,
        reviewId: blockingReviewId,
        message,
      });
      blockingReviewId = null;
    }

    const outcome = await createIncrementalReview(this.octokit, {
      owner,
      repo,
      pullNumber,
      commitSha: headSha,
      annotations: inlineNew,
      changedFiles: prContext.changedFiles,
      event: blocking ? 'REQUEST_CHANGES' : 'COMMENT',
      body: this.buildIncrementalBody(result, scope, newAnnotations.length, openCounts, blocking),
    });
    if (blocking) blockingReviewId = outcome.reviewId;

    // State is saved last, only after posting succeeded.
    const demoted = [...outcome.demoted, ...capOverflow];
    const newState: ReviewState = {
      v: 1,
      lastReviewedSha: headSha,
      baseSha: prContext.baseSha,
      blockingReviewId,
      postedFingerprints: appendFingerprints(
        state?.postedFingerprints ?? [],
        newAnnotations.map((a) => fingerprints.get(a)!),
      ),
      openCounts,
      runs: appendRun(state?.runs ?? [], {
        sha: headSha.slice(0, 7),
        at: new Date().toISOString().slice(0, 10),
        scope: scope.mode === 'delta' ? 'delta' : 'full',
        newFindings: newAnnotations.length,
        cost: calculateCost(result.tokensUsed).toString(),
      }),
    };
    await saveStickyComment(this.octokit, {
      owner,
      repo,
      pullNumber,
      commentId: input.commentId,
      body: renderStickyComment({
        result,
        state: newState,
        demoted: demoted.map((a) => ({
          path: a.path,
          startLine: a.startLine,
          severity: a.severity,
          title: a.title,
        })),
      }),
    });

    logger.info(
      {
        pullNumber,
        scope: scope.mode,
        score: result.score,
        newFindings: newAnnotations.length,
        postedInline: outcome.posted.length,
        openCounts,
        llmCalls: result.callCount,
        conclusion,
      },
      'Review completed',
    );

    // Cumulative stats so failOn logic downstream (Action outputs) matches the check run.
    return { ...result, stats: openCounts };
  }

  private buildIncrementalBody(
    result: ReviewResult,
    scope: ScopeDecision,
    newFindings: number,
    openCounts: Record<Severity, number>,
    blocking: boolean,
  ): string {
    const openTotal = Object.values(openCounts).reduce((a, b) => a + b, 0);
    const lines: string[] = [];
    lines.push(blocking ? '## 🤖 FiscalCR — changes requested' : '## 🤖 FiscalCR review update');
    if (scope.mode === 'delta' && scope.sinceSha) {
      lines.push(`\nIncremental review of changes since \`${scope.sinceSha.slice(0, 7)}\`.`);
    }
    lines.push(
      `\n**${newFindings} new finding(s)** this run · **${openTotal} open** across the PR · score ${result.score}/100`,
    );
    lines.push('\nSee the pinned FiscalCR summary comment for the full walkthrough and open findings.');
    return lines.join('\n');
  }

  private async runReview(
    prContext: PullRequestContext,
    deltaHint?: string,
  ): Promise<ReviewResult> {
    const usage = new UsageTracker();
    const pipeline = this.config.pipeline;

    const totalTokens =
      prContext.changedFiles.reduce(
        (sum, f) => sum + (f.patch ? estimateTokens(f.patch) : 0),
        0,
      ) +
      [...prContext.fileContents.values()].reduce((sum, c) => sum + estimateTokens(c), 0);

    if (!pipeline.enabled || totalTokens < pipeline.fastPathThreshold) {
      logger.info({ totalTokens, pipelineEnabled: pipeline.enabled }, 'Using fast path (single call)');
      return runFastPath(this.llm, prContext, this.config, usage, deltaHint);
    }

    logger.info({ totalTokens }, 'Using multi-pass pipeline');

    // Pass 1: intent & walkthrough (non-fatal on failure)
    const intent = await runIntentPass(this.llm, prContext, this.config, usage);

    // Pass 2: parallel per-group reviews
    const groups = groupFiles(
      prContext.changedFiles,
      prContext.fileContents,
      intent,
      this.config,
    );
    logger.info(
      { groups: groups.map((g) => ({ label: g.label, files: g.files.length, diffOnly: g.diffOnly })) },
      'Files grouped for review',
    );
    const outcomes = await runReviewPass(
      this.llm,
      prContext,
      groups,
      intent,
      this.config,
      usage,
      { workspaceRoot: this.options.workspaceRoot, deltaHint },
    );

    if (outcomes.every((o) => o.failed)) {
      throw new ReviewError('All review groups failed', 'review-pass');
    }

    // Pass 3: deterministic validation + LLM synthesis
    const findings = validateAndRankFindings(
      outcomes.flatMap((o) => o.findings),
      prContext.changedFiles,
      this.config,
    );
    return synthesize(this.llm, { ctx: prContext, intent, outcomes, findings }, this.config, usage);
  }
}

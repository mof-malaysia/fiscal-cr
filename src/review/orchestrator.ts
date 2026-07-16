import type { Octokit } from '@octokit/rest';
import type { ReviewConfig } from '../config/schema.js';
import type { ReviewResult } from '../types/review.js';
import type { LLMProvider } from '../providers/interface.js';
import { extractPullRequestContext } from '../github/pulls.js';
import { createCheckRun, completeCheckRun } from '../github/checks.js';
import { createPRReview } from '../github/comments.js';
import { filterFiles } from './file-filter.js';
import { buildSummary } from './summary-builder.js';
import { ApiFileSource, LocalFileSource } from './file-source.js';
import { runIntentPass } from '../pipeline/pass1-intent.js';
import { groupFiles } from '../pipeline/grouper.js';
import { runReviewPass } from '../pipeline/pass2-review.js';
import { synthesize, validateAndRankFindings } from '../pipeline/pass3-synthesis.js';
import { runFastPath } from '../pipeline/fast-path.js';
import { UsageTracker } from '../pipeline/usage.js';
import { estimateTokens } from '../utils/tokens.js';
import { ReviewError } from '../utils/errors.js';
import { logger } from '../utils/logger.js';

interface ReviewParams {
  owner: string;
  repo: string;
  pullNumber: number;
  headSha: string;
}

export interface OrchestratorOptions {
  /** Local checkout root (Action mode). Enables disk reads instead of API fetches. */
  workspaceRoot?: string;
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

    // Step 1: Create Check Run
    const checkRunId = await createCheckRun(this.octokit, {
      owner,
      repo,
      headSha,
    });

    try {
      // Step 2: Extract PR context
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
        { fileSource },
      );

      // Step 3: Filter files
      const filteredFiles = filterFiles(prContext.changedFiles, this.config);
      prContext.changedFiles = filteredFiles;
      // Keep contents only for reviewable files (never prompt with lockfiles etc.)
      const reviewable = new Set(filteredFiles.map((f) => f.filename));
      for (const path of [...prContext.fileContents.keys()]) {
        if (!reviewable.has(path)) prContext.fileContents.delete(path);
      }

      if (filteredFiles.length === 0) {
        const result: ReviewResult = {
          summary: 'No reviewable files in this PR (all files matched exclude patterns).',
          score: 100,
          annotations: [],
          stats: { critical: 0, warning: 0, suggestion: 0, nitpick: 0 },
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

      // Step 4: Run the review (fast path or multi-pass pipeline)
      const result = await this.runReview(prContext);

      // Step 5: Determine conclusion
      const conclusion =
        this.config.review.failOn === 'critical' && result.stats.critical > 0
          ? 'failure'
          : this.config.review.failOn === 'warning' &&
              (result.stats.critical > 0 || result.stats.warning > 0)
            ? 'failure'
            : 'success';

      // Step 6: Update Check Run
      const summaryMd = buildSummary(result);
      await completeCheckRun(this.octokit, {
        owner,
        repo,
        checkRunId,
        conclusion,
        summary: summaryMd,
        annotations: result.annotations,
      });

      // Step 7: Create PR Review
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

  private async runReview(prContext: Parameters<typeof runFastPath>[1]): Promise<ReviewResult> {
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
      return runFastPath(this.llm, prContext, this.config, usage);
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
      { workspaceRoot: this.options.workspaceRoot },
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

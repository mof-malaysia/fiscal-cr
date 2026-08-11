import type { PullRequestContext, ReviewResult } from '../types/review.js';
import type { ReviewConfig } from '../config/schema.js';
import type { LLMProvider } from '../providers/interface.js';
import { runIntentPass } from './pass1-intent.js';
import { groupFiles } from './grouper.js';
import { runReviewPass } from './pass2-review.js';
import { validateAndRankFindings, synthesize } from './pass3-synthesis.js';
import { runFastPath } from './fast-path.js';
import type { UsageTracker } from './usage.js';
import { estimateTokens } from '../utils/tokens.js';
import { ReviewError } from '../utils/errors.js';
import { logger } from '../utils/logger.js';

export type ReviewRoute = 'fast-path' | 'multi-pass';

export interface RunReviewOptions {
  /** Local checkout root (Action mode). Enables disk reads for related context. */
  workspaceRoot?: string;
  /** Extra prompt hint for delta reviews ("focus on lines changed since …"). */
  deltaHint?: string;
}

export interface RouteDecision {
  route: ReviewRoute;
  estimatedTokens: number;
}

/** Estimate the prompt tokens a review of this PR would consume (patches + full contents). */
export function estimateReviewTokens(ctx: PullRequestContext): number {
  return (
    ctx.changedFiles.reduce((sum, f) => sum + (f.patch ? estimateTokens(f.patch) : 0), 0) +
    [...ctx.fileContents.values()].reduce((sum, c) => sum + estimateTokens(c), 0)
  );
}

/**
 * Decide fast-path vs multi-pass without running anything. The fast path wins
 * when the pipeline is disabled or the PR is small enough to fit one call.
 */
export function routeReview(ctx: PullRequestContext, config: ReviewConfig): RouteDecision {
  const estimatedTokens = estimateReviewTokens(ctx);
  const pipeline = config.pipeline;
  const route: ReviewRoute =
    !pipeline.enabled || estimatedTokens < pipeline.fastPathThreshold
      ? 'fast-path'
      : 'multi-pass';
  return { route, estimatedTokens };
}

/**
 * Run the full review: fast path (single call) or the multi-pass pipeline
 * (intent → grouped review → deterministic validation/ranking → synthesis).
 * Pure computation — no GitHub extraction or publishing happens here.
 */
export async function runReviewPipeline(
  llm: LLMProvider,
  ctx: PullRequestContext,
  config: ReviewConfig,
  usage: UsageTracker,
  options: RunReviewOptions = {},
): Promise<ReviewResult> {
  const { route, estimatedTokens } = routeReview(ctx, config);

  if (route === 'fast-path') {
    logger.info(
      { estimatedTokens, pipelineEnabled: config.pipeline.enabled },
      'Using fast path (single call)',
    );
    return runFastPath(llm, ctx, config, usage, options.deltaHint);
  }

  logger.info({ estimatedTokens }, 'Using multi-pass pipeline');

  // Pass 1: intent & walkthrough (non-fatal on failure)
  const intent = await runIntentPass(llm, ctx, config, usage);

  // Pass 2: parallel per-group reviews
  const groups = groupFiles(ctx.changedFiles, ctx.fileContents, intent, config);
  logger.info(
    { groups: groups.map((g) => ({ label: g.label, files: g.files.length, diffOnly: g.diffOnly })) },
    'Files grouped for review',
  );
  const outcomes = await runReviewPass(llm, ctx, groups, intent, config, usage, {
    workspaceRoot: options.workspaceRoot,
    deltaHint: options.deltaHint,
  });

  if (outcomes.every((o) => o.failed)) {
    throw new ReviewError('All review groups failed', 'review-pass');
  }

  // Pass 3: deterministic validation + LLM synthesis
  const findings = validateAndRankFindings(
    outcomes.flatMap((o) => o.findings),
    ctx.changedFiles,
    config,
  );
  return synthesize(llm, { ctx, intent, outcomes, findings }, config, usage);
}
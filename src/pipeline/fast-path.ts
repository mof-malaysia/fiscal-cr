import type { PullRequestContext, ReviewResult } from '../types/review.js';
import type { ReviewConfig } from '../config/schema.js';
import type { LLMProvider } from '../providers/interface.js';
import { buildFastPathSystemPrompt, buildFastPathUserPrompt } from './prompts.js';
import { parseFastPathResponse } from './schemas.js';
import {
  countBySeverity,
  deterministicScore,
  validateAndRankFindings,
} from './pass3-synthesis.js';
import type { UsageTracker } from './usage.js';
import { ReviewError } from '../utils/errors.js';
import { logger } from '../utils/logger.js';

/**
 * Fast path: one combined call for small PRs (and the `pipeline.enabled: false`
 * kill-switch). Same output contract and code-side validation as the pipeline.
 */
export async function runFastPath(
  llm: LLMProvider,
  ctx: PullRequestContext,
  config: ReviewConfig,
  usage: UsageTracker,
  deltaHint?: string,
): Promise<ReviewResult> {
  const response = await llm.chatCompletion({
    messages: [
      { role: 'system', content: buildFastPathSystemPrompt(config) },
      { role: 'user', content: buildFastPathUserPrompt(ctx, ctx.changedFiles, deltaHint) },
    ],
    responseFormat: { type: 'json_object' },
    maxTokens: config.pipeline.maxOutputTokens,
    temperature: 0.3,
    timeoutMs: config.pipeline.callTimeoutMs,
  });
  usage.add(response.usage);

  const parsed = parseFastPathResponse(response.content);
  if (!parsed) {
    throw new ReviewError('Could not parse review response as JSON', 'fast-path');
  }

  const annotations = validateAndRankFindings(parsed.findings, ctx.changedFiles, config);
  const stats = countBySeverity(annotations);

  logger.info(
    { findings: parsed.findings.length, kept: annotations.length },
    'Fast-path review completed',
  );

  return {
    summary: parsed.summary || 'Automated review completed.',
    score: parsed.score ?? deterministicScore(stats),
    annotations,
    stats,
    tokensUsed: usage.total(),
    walkthrough: parsed.walkthrough,
    intent: parsed.intent || undefined,
    callCount: usage.calls(),
  };
}

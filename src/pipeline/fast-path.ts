import type { PullRequestContext, ReviewResult } from '../types/review.js';
import type { ReviewConfig } from '../config/schema.js';
import { modelForRole } from '../config/schema.js';
import type { LLMProvider } from '../providers/interface.js';
import { buildFastPathSystemPrompt, buildFastPathUserPrompt } from './prompts.js';
import { parseFastPathResponse } from './schemas.js';
import {
  countBySeverity,
  deterministicScore,
  validateAndRankFindings,
} from './pass3-synthesis.js';
import { reviewTemperature } from './temperature.js';
import { reviewMaxOutputTokens } from './max-output.js';
import type { UsageTracker } from './usage.js';
import { ReviewError } from '../utils/errors.js';
import { logger } from '../utils/logger.js';

/**
 * Fast path: one combined call for lightweight PRs (and the `pipeline.enabled: false`
 * kill-switch). Same output contract and code-side validation as the pipeline.
 */
export async function runFastPath(
  llm: LLMProvider,
  ctx: PullRequestContext,
  config: ReviewConfig,
  usage: UsageTracker,
  deltaHint?: string,
): Promise<ReviewResult> {
  const model = modelForRole(config, 'fastPath');
  const maxOutputTokens = reviewMaxOutputTokens(config, model);
  const messages = [
    { role: 'system' as const, content: buildFastPathSystemPrompt(config) },
    { role: 'user' as const, content: buildFastPathUserPrompt(ctx, ctx.changedFiles, deltaHint) },
  ];
  const startedAt = Date.now();
  usage.startCall();
  const response = await llm
    .chatCompletion({
      messages,
      model,
      responseFormat: { type: 'json_object' },
      maxTokens: maxOutputTokens,
      temperature: reviewTemperature(config, 0.3, model),
      timeoutMs: config.pipeline.callTimeoutMs,
    })
    .catch((err: unknown) => {
      usage.emit({ type: 'stage_result', stage: 'fast-path', status: 'failed' });
      throw err;
    });
  usage.add(response.usage, {
    stage: 'fast-path',
    messages,
    maxOutputTokens,
    durationMs: Date.now() - startedAt,
    fileCount: ctx.changedFiles.length,
    finishReason: response.finishReason,
  });

  const truncated = response.finishReason === 'length';
  const parsed = parseFastPathResponse(response.content);
  if (!parsed) {
    usage.emit({ type: 'stage_result', stage: 'fast-path', status: 'failed' });
    throw new ReviewError(
      truncated
        ? `Review response was truncated at the output-token cap ` +
          `(maxOutputTokens=${maxOutputTokens}) and could not be salvaged as JSON. ` +
          `Increase pipeline.maxOutputTokens.`
        : 'Could not parse review response as JSON',
      'fast-path',
    );
  }
  if (truncated) {
    logger.warn(
      { maxOutputTokens, kept: parsed.findings.length },
      'Review response truncated at output-token cap; salvaged a partial review. ' +
        'Consider increasing pipeline.maxOutputTokens.',
    );
  }

  const annotations = validateAndRankFindings(parsed.findings, ctx.changedFiles, config);
  const stats = countBySeverity(annotations);
  usage.emit({
    type: 'stage_result',
    stage: 'fast-path',
    status: 'success',
    findingsGenerated: parsed.findings.length,
    findingsRetained: annotations.length,
  });

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

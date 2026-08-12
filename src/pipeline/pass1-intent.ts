import type { PullRequestContext } from '../types/review.js';
import type { ReviewConfig } from '../config/schema.js';
import { modelForRole } from '../config/schema.js';
import type { LLMProvider } from '../providers/interface.js';
import { buildIntentSystemPrompt, buildIntentUserPrompt } from './prompts.js';
import { parseIntentResponse, type IntentResult } from './schemas.js';
import { reviewTemperature } from './temperature.js';
import type { UsageTracker } from './usage.js';
import { logger } from '../utils/logger.js';

/**
 * Pass 1: one lightweight, fast call that understands what the PR is trying to do.
 * Failure is never fatal — the pipeline proceeds without hints.
 */
export async function runIntentPass(
  llm: LLMProvider,
  ctx: PullRequestContext,
  config: ReviewConfig,
  usage: UsageTracker,
): Promise<IntentResult | null> {
  try {
    const model = modelForRole(config, 'intent');
    const messages = [
      { role: 'system' as const, content: buildIntentSystemPrompt(config) },
      { role: 'user' as const, content: buildIntentUserPrompt(ctx) },
    ];
    const startedAt = Date.now();
    usage.startCall();
    const response = await llm.chatCompletion({
      messages,
      model,
      responseFormat: { type: 'json_object' },
      maxTokens: 2_048,
      temperature: reviewTemperature(config, 0.3, model),
      timeoutMs: 60_000,
    });
    usage.add(response.usage, {
      stage: 'intent',
      messages,
      maxOutputTokens: 2_048,
      durationMs: Date.now() - startedAt,
      finishReason: response.finishReason,
    });

    const intent = parseIntentResponse(response.content);
    if (!intent) {
      usage.emit({ type: 'stage_result', stage: 'intent', status: 'failed' });
      logger.warn('Intent pass returned unparseable output, continuing without it');
      return null;
    }
    // Keep only walkthrough/group paths that actually exist in the PR.
    const known = new Set(ctx.changedFiles.map((f) => f.filename));
    intent.walkthrough = intent.walkthrough.filter((w) => known.has(w.path));
    intent.groups = intent.groups
      .map((g) => ({ ...g, files: g.files.filter((p) => known.has(p)) }))
      .filter((g) => g.files.length > 0);
    intent.riskHotspots = intent.riskHotspots.filter((h) => known.has(h.path));

    logger.info(
      { groups: intent.groups.length, hotspots: intent.riskHotspots.length },
      'Intent pass completed',
    );
    usage.emit({
      type: 'stage_result',
      stage: 'intent',
      status: 'success',
      groups: intent.groups.length,
      hotspots: intent.riskHotspots.length,
    });
    return intent;
  } catch (err) {
    usage.emit({ type: 'stage_result', stage: 'intent', status: 'failed' });
    logger.warn({ err }, 'Intent pass failed, continuing without it');
    return null;
  }
}

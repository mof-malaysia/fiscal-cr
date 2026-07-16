import type { PullRequestContext } from '../types/review.js';
import type { ReviewConfig } from '../config/schema.js';
import type { LLMProvider } from '../providers/interface.js';
import { buildIntentSystemPrompt, buildIntentUserPrompt } from './prompts.js';
import { parseIntentResponse, type IntentResult } from './schemas.js';
import { reviewTemperature } from './temperature.js';
import type { UsageTracker } from './usage.js';
import { logger } from '../utils/logger.js';

/**
 * Pass 1: one small, fast call that understands what the PR is trying to do.
 * Failure is never fatal — the pipeline proceeds without hints.
 */
export async function runIntentPass(
  llm: LLMProvider,
  ctx: PullRequestContext,
  config: ReviewConfig,
  usage: UsageTracker,
): Promise<IntentResult | null> {
  try {
    const response = await llm.chatCompletion({
      messages: [
        { role: 'system', content: buildIntentSystemPrompt(config) },
        { role: 'user', content: buildIntentUserPrompt(ctx) },
      ],
      responseFormat: { type: 'json_object' },
      maxTokens: 2_048,
      temperature: reviewTemperature(config),
      timeoutMs: 60_000,
    });
    usage.add(response.usage);

    const intent = parseIntentResponse(response.content);
    if (!intent) {
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
    return intent;
  } catch (err) {
    logger.warn({ err }, 'Intent pass failed, continuing without it');
    return null;
  }
}

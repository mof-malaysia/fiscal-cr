import type { PullRequestContext, ReviewAnnotation } from '../types/review.js';
import type { ReviewConfig } from '../config/schema.js';
import type { LLMProvider } from '../providers/interface.js';
import { pLimit } from '../utils/concurrency.js';
import { buildGroupSystemPrompt, buildGroupUserPrompt } from './prompts.js';
import { parseGroupResponse, type IntentResult } from './schemas.js';
import { collectRelatedContext } from './related-context.js';
import type { FileGroup } from './grouper.js';
import { reviewTemperature } from './temperature.js';
import type { UsageTracker } from './usage.js';
import { logger } from '../utils/logger.js';

export interface GroupReviewOutcome {
  group: FileGroup;
  summary: string;
  findings: ReviewAnnotation[];
  failed: boolean;
}

export interface ReviewPassOptions {
  workspaceRoot?: string;
  /** Extra prompt hint for delta reviews ("focus on lines changed since …"). */
  deltaHint?: string;
}

/**
 * Pass 2: review each file group in a focused, parallel LLM call.
 * A single failed group degrades the review; it does not abort it.
 */
export async function runReviewPass(
  llm: LLMProvider,
  ctx: PullRequestContext,
  groups: FileGroup[],
  intent: IntentResult | null,
  config: ReviewConfig,
  usage: UsageTracker,
  options: ReviewPassOptions = {},
): Promise<GroupReviewOutcome[]> {
  const systemPrompt = buildGroupSystemPrompt(config);
  const changedPaths = new Set(ctx.changedFiles.map((f) => f.filename));
  const limit = pLimit(config.pipeline.concurrency);

  return Promise.all(
    groups.map((group) =>
      limit(async (): Promise<GroupReviewOutcome> => {
        try {
          const relatedFiles = options.workspaceRoot
            ? await collectRelatedContext(group, ctx.fileContents, options.workspaceRoot, config, changedPaths)
            : new Map<string, string>();

          const response = await llm.chatCompletion({
            messages: [
              { role: 'system', content: systemPrompt },
              {
                role: 'user',
                content: buildGroupUserPrompt({
                  ctx,
                  group,
                  intent,
                  relatedFiles,
                  deltaHint: options.deltaHint,
                }),
              },
            ],
            responseFormat: { type: 'json_object' },
            maxTokens: config.pipeline.maxOutputTokens,
            temperature: reviewTemperature(config),
            timeoutMs: config.pipeline.callTimeoutMs,
          });
          usage.add(response.usage);

          const parsed = parseGroupResponse(response.content);
          if (!parsed) {
            logger.warn({ group: group.label }, 'Group review returned unparseable output');
            return { group, summary: '', findings: [], failed: true };
          }
          logger.info(
            { group: group.label, findings: parsed.findings.length },
            'Group review completed',
          );
          return { group, summary: parsed.groupSummary, findings: parsed.findings, failed: false };
        } catch (err) {
          logger.warn({ group: group.label, err }, 'Group review failed');
          return { group, summary: '', findings: [], failed: true };
        }
      }),
    ),
  );
}

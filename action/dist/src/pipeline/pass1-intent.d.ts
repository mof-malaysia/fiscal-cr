import type { PullRequestContext } from '../types/review.js';
import type { ReviewConfig } from '../config/schema.js';
import type { LLMProvider } from '../providers/interface.js';
import { type IntentResult } from './schemas.js';
import type { UsageTracker } from './usage.js';
/**
 * Pass 1: one small, fast call that understands what the PR is trying to do.
 * Failure is never fatal — the pipeline proceeds without hints.
 */
export declare function runIntentPass(llm: LLMProvider, ctx: PullRequestContext, config: ReviewConfig, usage: UsageTracker): Promise<IntentResult | null>;
//# sourceMappingURL=pass1-intent.d.ts.map
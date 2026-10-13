import type { ChangedFile, PullRequestContext } from '../types/review.js';
import type { ReviewConfig } from '../config/schema.js';
import type { FileGroup } from './grouper.js';
import type { IntentResult } from './schemas.js';
export declare function buildIntentSystemPrompt(config: ReviewConfig): string;
/** Truncate a unified patch at hunk boundaries to fit a token budget. */
export declare function truncatePatch(patch: string, tokenCap: number): string;
export declare function buildIntentUserPrompt(ctx: PullRequestContext): string;
export declare function buildGroupSystemPrompt(config: ReviewConfig): string;
export interface GroupPromptInput {
    ctx: PullRequestContext;
    group: FileGroup;
    intent: IntentResult | null;
    relatedFiles: Map<string, string>;
    deltaHint?: string;
}
export declare function buildGroupUserPrompt(input: GroupPromptInput): string;
export declare function buildSynthesisSystemPrompt(config: ReviewConfig): string;
export interface SynthesisPromptInput {
    ctx: PullRequestContext;
    intent: IntentResult | null;
    groupSummaries: Array<{
        label: string;
        summary: string;
    }>;
    findings: Array<{
        id: string;
        line: string;
    }>;
    failedGroupNote?: string;
}
export declare function buildSynthesisUserPrompt(input: SynthesisPromptInput): string;
export declare function buildFastPathSystemPrompt(config: ReviewConfig): string;
export declare function buildFastPathUserPrompt(ctx: PullRequestContext, files: ChangedFile[], deltaHint?: string): string;
//# sourceMappingURL=prompts.d.ts.map
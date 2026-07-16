import type { LLMTokenUsage } from '../providers/interface.js';
/** Aggregates token usage and call counts across all pipeline LLM calls. */
export declare class UsageTracker {
    private totals;
    private callCount;
    add(usage: LLMTokenUsage): void;
    total(): LLMTokenUsage;
    calls(): number;
}
//# sourceMappingURL=usage.d.ts.map
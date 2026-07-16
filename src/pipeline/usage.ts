import type { LLMTokenUsage } from '../providers/interface.js';

/** Aggregates token usage and call counts across all pipeline LLM calls. */
export class UsageTracker {
  private totals: LLMTokenUsage = { input: 0, output: 0, cached: 0 };
  private callCount = 0;

  add(usage: LLMTokenUsage): void {
    this.totals.input += usage.input;
    this.totals.output += usage.output;
    this.totals.cached += usage.cached;
    this.callCount++;
  }

  total(): LLMTokenUsage {
    return { ...this.totals };
  }

  calls(): number {
    return this.callCount;
  }
}

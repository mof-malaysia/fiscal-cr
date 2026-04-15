/**
 * Rough token estimation. ~4 chars per token for English,
 * ~2 chars per token for CJK. Good enough for context budget planning.
 */
export declare function estimateTokens(text: string): number;
/**
 * Calculate API cost in USD based on token usage.
 */
export declare function calculateCost(usage: {
    input: number;
    output: number;
    cached: number;
}, options?: {
    provider?: string;
    model?: string;
    baseUrl?: string;
}): number;
//# sourceMappingURL=tokens.d.ts.map
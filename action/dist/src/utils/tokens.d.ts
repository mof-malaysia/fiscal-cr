import { type PricingContext } from './pricing.js';
/**
 * Rough token estimation. ~4 chars per token for English,
 * ~2 chars per token for CJK. Good enough for context budget planning.
 */
export declare function estimateTokens(text: string): number;
/**
 * Calculate API cost using the legacy fallback pricing.
 *
 * Call `calculateCostForModel` when provider/model context is available.
 */
export declare function calculateCost(usage: {
    input: number;
    output: number;
    cached: number;
}): number;
export declare function calculateCostForModel(usage: {
    input: number;
    output: number;
    cached: number;
}, context: PricingContext): number;
export declare function roundCost(cost: number): number;
//# sourceMappingURL=tokens.d.ts.map
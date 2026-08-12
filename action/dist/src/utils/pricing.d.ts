/**
 * Published token prices in USD per million tokens.
 *
 * Pricing is intentionally a local snapshot: reviews must not depend on a
 * pricing endpoint being available. Update this map when vendors change rates.
 */
export interface TokenPricing {
    inputPerMillion: number;
    outputPerMillion: number;
    cachedInputPerMillion: number;
}
export type PricingSource = 'exact' | 'family' | 'fallback';
export interface PricingContext {
    provider?: string;
    model?: string;
    baseUrl?: string;
}
export interface PricingResolution {
    pricing: TokenPricing;
    source: PricingSource;
    provider?: string;
    model?: string;
    matchedModel?: string;
}
/** Previous FiscalCR estimate, retained for unknown/custom endpoints. */
export declare const FALLBACK_TOKEN_PRICING: TokenPricing;
/** Resolve a local pricing snapshot for a provider/model pair. */
export declare function resolvePricing(context?: PricingContext): PricingResolution;
export declare function calculateCostWithPricing(usage: {
    input: number;
    output: number;
    cached: number;
}, pricing: TokenPricing): number;
//# sourceMappingURL=pricing.d.ts.map
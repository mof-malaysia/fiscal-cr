/**
 * Published token prices in USD per million tokens.
 *
 * Local snapshots keep cost reporting available without network access.
 * OpenRouter can supply a fresher snapshot through `resolvePricingAsync`.
 */
export interface PricingTier {
    minPromptTokens: number;
    inputPerMillion: number;
    outputPerMillion: number;
    cachedInputPerMillion: number;
}
export interface TokenPricing {
    inputPerMillion: number;
    outputPerMillion: number;
    cachedInputPerMillion: number;
    tiers?: PricingTier[];
}
export type PricingSource = 'exact' | 'family' | 'remote' | 'fallback';
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
/**
 * Resolve pricing asynchronously, looking up unknown OpenRouter models and
 * falling back to the local snapshot on failure.
 */
export declare function resolvePricingAsync(context?: PricingContext): Promise<PricingResolution>;
export declare function calculateCostWithPricing(usage: {
    input: number;
    output: number;
    cached: number;
}, pricing: TokenPricing): number;
//# sourceMappingURL=pricing.d.ts.map
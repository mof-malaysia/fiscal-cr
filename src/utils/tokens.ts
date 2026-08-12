import {
  calculateCostWithPricing,
  FALLBACK_TOKEN_PRICING,
  resolvePricing,
  type PricingContext,
} from './pricing.js';

/**
 * Rough token estimation. ~4 chars per token for English,
 * ~2 chars per token for CJK. Good enough for context budget planning.
 */
export function estimateTokens(text: string): number {
  // Count CJK characters
  const cjkCount = (text.match(/[\u4e00-\u9fff\u3400-\u4dbf\uf900-\ufaff]/g) ?? []).length;
  const nonCjkLength = text.length - cjkCount;
  return Math.ceil(nonCjkLength / 4 + cjkCount / 2);
}

/**
 * Calculate API cost using the legacy fallback pricing.
 *
 * Call `calculateCostForModel` when provider/model context is available.
 */
 

export function calculateCost(usage: {
  input: number;
  output: number;
  cached: number;
}): number {
  return roundCost(calculateCostWithPricing(usage, FALLBACK_TOKEN_PRICING));
}

export function calculateCostForModel(
  usage: { input: number; output: number; cached: number },
  context: PricingContext,
): number {
  return roundCost(calculateCostWithPricing(usage, resolvePricing(context).pricing));
}

export function roundCost(cost: number): number {
  return Math.round(cost * 10000) / 10000;
}

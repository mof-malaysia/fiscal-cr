import type { ReviewConfig } from '../src/config/schema.js';

/**
 * Keep review policy from the PR head while pinning network-routing settings
 * to the trusted base revision. Explicit Action inputs are applied afterward.
 */
export function mergeActionConfig(
  headConfig: ReviewConfig,
  trustedConfig: ReviewConfig,
): ReviewConfig {
  return {
    ...headConfig,
    provider: trustedConfig.provider,
    baseUrl: trustedConfig.baseUrl,
  };
}

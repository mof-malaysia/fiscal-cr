import type { ReviewConfig } from '../src/config/schema.js';
/**
 * Keep review policy from the PR head while pinning network-routing settings
 * to the trusted base revision. Explicit Action inputs are applied afterward.
 */
export declare function mergeActionConfig(headConfig: ReviewConfig, trustedConfig: ReviewConfig): ReviewConfig;
//# sourceMappingURL=config.d.ts.map
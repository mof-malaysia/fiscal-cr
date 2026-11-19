import type { ReviewConfig } from "./schema.js";
/** Apply an explicit provider override before resolving provider-default presets. */
export declare function applyProviderOverride(config: ReviewConfig, provider?: string): void;
/** Apply an explicit global model override to every pipeline stage. */
export declare function applyModelOverride(config: ReviewConfig, model?: string): void;
//# sourceMappingURL=overrides.d.ts.map
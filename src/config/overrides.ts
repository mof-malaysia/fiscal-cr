import type { ReviewConfig } from "./schema.js";

/** Apply an explicit provider override before resolving provider-default presets. */
export function applyProviderOverride(config: ReviewConfig, provider?: string): void {
  if (provider) config.provider = provider as ReviewConfig["provider"];
}

/** Apply an explicit global model override to every pipeline stage. */
export function applyModelOverride(config: ReviewConfig, model?: string): void {
  if (!model) return;
  config.model = model;
  config.models.intent = model;
  config.models.fastPath = model;
  config.models.groupReview = model;
  config.models.synthesis = model;
}

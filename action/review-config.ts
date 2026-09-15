import { ConfigError } from "../src/utils/errors.js";
import type { ReviewConfig } from "../src/config/schema.js";

interface ActionReviewConfigCore {
  getInput(name: string): string;
  getBooleanInput(name: string): boolean;
}

export type ActionCommentMode = ReviewConfig["review"]["comments"]["mode"];

export interface ActionReviewConfigInputs {
  visualize?: boolean;
  comments?: ActionCommentMode;
}

/** Return the explicit visualization toggle, preserving repo config when absent. */
export function visualizeFromActionInput(
  core: ActionReviewConfigCore,
): boolean | undefined {
  if (!core.getInput("visualize").trim()) return undefined;
  return core.getBooleanInput("visualize");
}

/** Return the explicit comment mode, preserving repo config when absent. */
export function commentModeFromActionInput(
  core: ActionReviewConfigCore,
): ActionCommentMode | undefined {
  const raw = core.getInput("comments").trim();
  if (!raw) return undefined;
  if (raw !== "sticky" && raw !== "legacy") {
    throw new ConfigError(
      `Invalid comments input: expected sticky or legacy, got ${JSON.stringify(raw)}`,
    );
  }
  return raw;
}

/** Apply only explicitly supplied Action review settings. */
export function applyActionReviewConfig(
  config: ReviewConfig,
  inputs: ActionReviewConfigInputs,
): void {
  if (inputs.visualize !== undefined) {
    config.review.visualize.enabled = inputs.visualize;
  }
  if (inputs.comments !== undefined) {
    config.review.comments.mode = inputs.comments;
  }
}

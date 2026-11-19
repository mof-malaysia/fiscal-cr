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
export declare function visualizeFromActionInput(core: ActionReviewConfigCore): boolean | undefined;
/** Return the explicit comment mode, preserving repo config when absent. */
export declare function commentModeFromActionInput(core: ActionReviewConfigCore): ActionCommentMode | undefined;
/** Apply only explicitly supplied Action review settings. */
export declare function applyActionReviewConfig(config: ReviewConfig, inputs: ActionReviewConfigInputs): void;
export {};
//# sourceMappingURL=review-config.d.ts.map
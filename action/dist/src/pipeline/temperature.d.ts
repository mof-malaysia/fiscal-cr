import { type ReviewConfig } from "../config/schema.js";
/**
 * Models that spend output tokens on hidden reasoning before answering
 * (OpenAI reasoning models, Claude 4.7+/5.x), so calls run longer and short
 * output caps truncate the answer.
 */
export declare function usesHiddenReasoning(model: string): boolean;
/**
 * Resolve the temperature for a review call: an explicit config value wins;
 * models that pin their own temperature get none at all (the server default
 * applies); everything else uses the pipeline's preferred low temperature.
 *
 * `model` is the model actually used for this call (a stage model when the
 * caller resolved one); it defaults to the resolved `groupReview` model.
 */
export declare function reviewTemperature(config: ReviewConfig, preferred?: number, model?: string): number | undefined;
//# sourceMappingURL=temperature.d.ts.map
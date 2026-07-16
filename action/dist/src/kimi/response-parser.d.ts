import type { ReviewResult } from '../types/review.js';
/**
 * Try multiple strategies to extract a JSON object from the AI response.
 */
export declare function extractJson(raw: string): unknown | null;
export declare function parseAIResponse(raw: string, tokenUsage: {
    input: number;
    output: number;
    cached: number;
}): ReviewResult;
//# sourceMappingURL=response-parser.d.ts.map
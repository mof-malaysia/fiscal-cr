/**
 * Try multiple strategies to extract a JSON object from an LLM response.
 */
export declare function extractJson(raw: string): unknown | null;
/**
 * Best-effort recovery of a JSON object that was cut off mid-generation
 * (e.g. the model hit its output-token cap). Rewinds to the last point where
 * the structure was at a value boundary — after a closing `}`/`]`, or just
 * before a `,` — drops the incomplete trailing token, and closes every still-
 * open array/object. This preserves the elements that were fully emitted (e.g.
 * the complete findings before truncation) and discards the partial last one.
 * Returns null when nothing salvageable precedes the truncation point.
 */
export declare function repairTruncatedJson(raw: string): unknown | null;
//# sourceMappingURL=json.d.ts.map
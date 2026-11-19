/** Single-line, length-capped excerpt of an HTTP error body for messages and logs. */
export declare function errorSnippet(body: string): string;
export declare class LLMApiError extends Error {
    statusCode: number;
    responseBody?: unknown | undefined;
    /** Parsed Retry-After header in milliseconds, when the API provided one. */
    retryAfterMs?: number | undefined;
    constructor(message: string, statusCode: number, responseBody?: unknown | undefined, 
    /** Parsed Retry-After header in milliseconds, when the API provided one. */
    retryAfterMs?: number | undefined);
}
export declare class ConfigError extends Error {
    constructor(message: string);
}
export declare class ReviewError extends Error {
    phase: string;
    constructor(message: string, phase: string, cause?: unknown);
}
/**
 * True when the provider rejected the call because the account's spend/usage
 * limit is exhausted (not a code or config problem). Looks through
 * `ReviewError.cause`, since the pipeline wraps provider errors.
 */
export declare function isApiQuotaExhausted(err: unknown): boolean;
//# sourceMappingURL=errors.d.ts.map
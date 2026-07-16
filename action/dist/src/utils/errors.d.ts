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
    constructor(message: string, phase: string);
}
//# sourceMappingURL=errors.d.ts.map
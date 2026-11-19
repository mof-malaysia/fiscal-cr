/** Single-line, length-capped excerpt of an HTTP error body for messages and logs. */
export function errorSnippet(body: string): string {
  return body.replace(/\s+/g, ' ').trim().slice(0, 300);
}

export class LLMApiError extends Error {
  constructor(
    message: string,
    public statusCode: number,
    public responseBody?: unknown,
    /** Parsed Retry-After header in milliseconds, when the API provided one. */
    public retryAfterMs?: number,
  ) {
    super(message);
    this.name = 'LLMApiError';
  }
}

export class ConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ConfigError';
  }
}

export class ReviewError extends Error {
  constructor(
    message: string,
    public phase: string,
    cause?: unknown,
  ) {
    super(message, cause === undefined ? undefined : { cause });
    this.name = 'ReviewError';
  }
}

const QUOTA_EXHAUSTED_PATTERN =
  /usage limits?|insufficient_quota|exceeded your current quota|credit balance is too low/i;

/**
 * True when the provider rejected the call because the account's spend/usage
 * limit is exhausted (not a code or config problem). Looks through
 * `ReviewError.cause`, since the pipeline wraps provider errors.
 */
export function isApiQuotaExhausted(err: unknown): boolean {
  if (err instanceof LLMApiError) {
    return (
      [400, 402, 429].includes(err.statusCode) &&
      QUOTA_EXHAUSTED_PATTERN.test(`${err.message} ${String(err.responseBody ?? '')}`)
    );
  }
  return err instanceof Error && err.cause !== undefined && isApiQuotaExhausted(err.cause);
}

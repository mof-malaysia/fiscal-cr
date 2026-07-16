import { LLMApiError } from '../utils/errors.js';
import { logger } from '../utils/logger.js';
import type {
  ChatCompletionParams,
  LLMCompletionResponse,
  LLMProvider,
} from './interface.js';

export interface ResilientProviderOptions {
  /** Retry attempts after the initial call. Default 3. */
  maxRetries?: number;
  /** Ceiling for a single backoff wait. Default 30s. */
  maxBackoffMs?: number;
}

const BASE_BACKOFF_MS = 1_000;

function isRetryable(err: unknown): boolean {
  if (err instanceof LLMApiError) {
    return err.statusCode === 429 || err.statusCode >= 500;
  }
  if (err instanceof Error) {
    // AbortError = our own timeout fired; TypeError = fetch network failure.
    return err.name === 'AbortError' || err.name === 'TimeoutError' || err instanceof TypeError;
  }
  return false;
}

/**
 * Decorator that adds retry-with-backoff to any LLMProvider.
 * Retries 429/5xx/timeout/network errors with exponential backoff and full
 * jitter, honoring Retry-After when the API supplies it. Other 4xx errors
 * (auth, bad request) are never retried.
 */
export class ResilientProvider implements LLMProvider {
  private readonly maxRetries: number;
  private readonly maxBackoffMs: number;

  constructor(
    private readonly inner: LLMProvider,
    options: ResilientProviderOptions = {},
  ) {
    this.maxRetries = options.maxRetries ?? 3;
    this.maxBackoffMs = options.maxBackoffMs ?? 30_000;
  }

  async chatCompletion(params: ChatCompletionParams): Promise<LLMCompletionResponse> {
    for (let attempt = 0; ; attempt++) {
      try {
        return await this.inner.chatCompletion(params);
      } catch (err) {
        if (attempt >= this.maxRetries || !isRetryable(err)) {
          throw err;
        }
        const delay = this.backoffDelay(attempt, err);
        logger.warn(
          {
            attempt: attempt + 1,
            maxRetries: this.maxRetries,
            delayMs: Math.round(delay),
            error: err instanceof Error ? `${err.name}: ${err.message}` : String(err),
          },
          'LLM call failed, retrying',
        );
        await sleep(delay);
      }
    }
  }

  private backoffDelay(attempt: number, err: unknown): number {
    if (err instanceof LLMApiError && err.retryAfterMs !== undefined) {
      return Math.min(err.retryAfterMs, this.maxBackoffMs);
    }
    const exponential = Math.min(this.maxBackoffMs, BASE_BACKOFF_MS * 2 ** attempt);
    // Full jitter: 50–100% of the exponential window.
    return exponential * (0.5 + Math.random() * 0.5);
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

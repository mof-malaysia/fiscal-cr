import type { ReviewConfig } from '../config/schema.js';
import { ConfigError, errorSnippet, LLMApiError } from '../utils/errors.js';
import { releaseParamsForModel } from '../config/provider-models.js';
import { logger } from '../utils/logger.js';
import { fetchWithAuth, type RequestAuth } from './auth.js';
import {
  DEFAULT_USER_AGENT,
  type ChatCompletionParams,
  type LLMCompletionResponse,
  type LLMProvider,
} from './interface.js';

export interface OpenAICompatibleProviderConfig {
  /** Request auth: a bearer API key or workload identity federation. */
  auth: RequestAuth;
  model: string;
  baseUrl?: string;
  temperature?: number;
  timeout?: number;
  /**
   * Override the User-Agent header. Some endpoints whitelist clients by
   * User-Agent and reject unknown ones. When set, the X-Client-Name header
   * is omitted so the request carries one identity.
   */
  userAgent?: string;
  /**
   * Field name for the completion-token cap. OpenAI models require
   * "max_completion_tokens"; legacy/compatible endpoints use "max_tokens".
   * Defaults to "max_tokens".
   */
  completionTokenParam?: 'max_tokens' | 'max_completion_tokens';
  /**
   * Operator-supplied passthrough fields (reasoning_effort, verbosity, top_p,
   * seed, …) merged into every request body. Pipeline-managed keys are stripped
   * (see RESERVED_MODEL_PARAM_KEYS) so they cannot override the pipeline.
   */
  modelParams?: Record<string, unknown>;
  /**
   * How this endpoint is told to cache the system prompt. See
   * `PromptCacheStyle`. Defaults to `cache-control`.
   */
  cacheStyle?: PromptCacheStyle;
  /** System-prompt cache lifetime. Omitted → nothing is sent. */
  promptCache?: ReviewConfig['promptCache'];
}

/**
 * How a Chat Completions endpoint is told to cache the system prompt:
 * - `cache-control`: Anthropic-style `cache_control` on the system content
 *   block. OpenRouter forwards it to Anthropic/Gemini/Qwen models.
 * - `openai`: GPT-5.6+ explicit mode — `prompt_cache_options.mode: explicit`
 *   plus a `prompt_cache_breakpoint` on the system block. Implicit mode would
 *   write the whole (per-PR) prompt at 1.25x on every call. The lifetime is
 *   OpenAI's fixed 30m, so `5m`/`1h` both enable it; `off` sends explicit
 *   mode with no breakpoint (no writes). Older models get nothing.
 * - `kimi`: Kimi's `prompt_cache_options: { mode: implicit, ttl }`.
 */
export type PromptCacheStyle = 'cache-control' | 'openai' | 'kimi';

/** GPT-5.6 and later accept `prompt_cache_options` and explicit breakpoints. */
function supportsOpenAICacheBreakpoints(model: string): boolean {
  const match = /^gpt-(\d+)(?:\.(\d+))?/i.exec(model);
  if (!match) return false;
  const major = Number(match[1]);
  return major > 5 || (major === 5 && Number(match[2] ?? 0) >= 6);
}

/** Wrap the (config-stable) system prompt in a text block carrying `marker`. */
function markSystemPrompt(
  messages: ChatCompletionParams['messages'],
  marker: Record<string, unknown>,
): unknown[] {
  return messages.map((message) =>
    message.role === 'system' && message.content.length > 0
      ? { role: 'system', content: [{ type: 'text', text: message.content, ...marker }] }
      : message,
  );
}

/**
 * Keys the pipeline owns and must not accept from operator-supplied modelParams:
 * request identity/managed fields, the token caps (either spelling — a stray
 * one re-triggers the max_tokens 400), and streaming (the parser is non-stream).
 */
const RESERVED_MODEL_PARAM_KEYS = new Set([
  'model',
  'messages',
  'temperature',
  'max_tokens',
  'max_completion_tokens',
  'response_format',
  'stream',
  'stream_options',
]);

/** Drop reserved keys from operator-supplied modelParams, warning on any drop. */
function sanitizeModelParams(
  params: Record<string, unknown> | undefined,
): Record<string, unknown> {
  if (!params) return {};
  const clean: Record<string, unknown> = {};
  const dropped: string[] = [];
  for (const [key, value] of Object.entries(params)) {
    if (RESERVED_MODEL_PARAM_KEYS.has(key)) dropped.push(key);
    else clean[key] = value;
  }
  if (dropped.length > 0) {
    logger.warn(
      { dropped },
      'Ignoring reserved keys in modelParams; use the dedicated config knobs instead',
    );
  }
  return clean;
}

interface OpenAICompatibleResponse {
  choices: Array<{
    message: { content: string };
    finish_reason?: string;
  }>;
  usage?: {
    prompt_tokens?: number;
    completion_tokens?: number;
    cached_tokens?: number;
    prompt_tokens_details?: {
      cached_tokens?: number;
      /** Reported by OpenRouter, Kimi, and OpenAI GPT-5.6+. */
      cache_write_tokens?: number;
    };
  };
}

function parseRetryAfter(header: string | null): number | undefined {
  if (!header) return undefined;
  const seconds = Number(header);
  if (Number.isFinite(seconds)) return Math.max(0, seconds * 1000);
  const date = Date.parse(header);
  if (!Number.isNaN(date)) return Math.max(0, date - Date.now());
  return undefined;
}

/**
 * Generic provider for OpenAI-compatible chat completion APIs.
 * Works with any OpenAI-compatible endpoint (FiscalCR, OpenAI, Groq, self-hosted, etc.).
 */
export class OpenAICompatibleProvider implements LLMProvider {
  private readonly auth: RequestAuth;
  private readonly model: string;
  private readonly baseUrl: string;
  private readonly temperature?: number;
  private readonly timeout: number;
  private readonly userAgent?: string;
  private readonly completionTokenParam: 'max_tokens' | 'max_completion_tokens';
  private readonly modelParams: Record<string, unknown>;
  private readonly cacheStyle: PromptCacheStyle;
  private readonly promptCache?: ReviewConfig['promptCache'];

  constructor(config: OpenAICompatibleProviderConfig) {
    this.auth = config.auth;
    this.model = config.model;
    if (!config.baseUrl) {
      throw new ConfigError('OpenAI-compatible provider requires an explicit baseUrl');
    }
    this.baseUrl = config.baseUrl;
    this.temperature = config.temperature;
    this.timeout = config.timeout ?? 300_000;
    this.userAgent = config.userAgent;
    this.completionTokenParam = config.completionTokenParam ?? 'max_tokens';
    this.modelParams = sanitizeModelParams(config.modelParams);
    this.cacheStyle = config.cacheStyle ?? 'cache-control';
    this.promptCache = config.promptCache;
  }

  /** Configured TTL when caching is on; undefined for `off` or unset. */
  private cacheTtl(): '5m' | '1h' | undefined {
    return this.promptCache === '1h' || this.promptCache === '5m' ? this.promptCache : undefined;
  }

  /** Request fields and messages carrying this endpoint's cache hint. */
  private cacheRequest(
    params: ChatCompletionParams,
    model: string,
  ): { fields: Record<string, unknown>; messages: unknown[] } {
    const ttl = this.cacheTtl();
    const none = { fields: {}, messages: params.messages };
    switch (this.cacheStyle) {
      case 'cache-control':
        if (!ttl) return none;
        return {
          fields: {},
          messages: markSystemPrompt(params.messages, {
            cache_control: ttl === '1h' ? { type: 'ephemeral', ttl: '1h' } : { type: 'ephemeral' },
          }),
        };
      case 'openai':
        if (this.promptCache === undefined || !supportsOpenAICacheBreakpoints(model)) return none;
        return {
          fields: { prompt_cache_options: { mode: 'explicit' } },
          messages: ttl
            ? markSystemPrompt(params.messages, { prompt_cache_breakpoint: { mode: 'explicit' } })
            : params.messages,
        };
      case 'kimi':
        if (!ttl) return none;
        return { fields: { prompt_cache_options: { mode: 'implicit', ttl } }, messages: params.messages };
    }
  }

  /**
   * Split reported cache writes by the premium they bill at: `cache-control`
   * writes by TTL (1.25x / 2x); OpenAI writes at 1.25x; Kimi bills 5m writes
   * at the base rate, so only its 1h writes carry a premium.
   */
  private cacheWriteUsage(writeTokens: number): { cacheWrite5m?: number; cacheWrite1h?: number } {
    if (writeTokens <= 0) return {};
    if (this.cacheStyle === 'openai') return { cacheWrite5m: writeTokens };
    if (this.cacheTtl() === '1h') return { cacheWrite1h: writeTokens };
    if (this.cacheStyle === 'kimi') return {};
    return { cacheWrite5m: writeTokens };
  }

  async chatCompletion(params: ChatCompletionParams): Promise<LLMCompletionResponse> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), params.timeoutMs ?? this.timeout);

    try {
      return await this.performCompletionRequest(params, controller.signal);
    } finally {
      clearTimeout(timer);
    }
  }

  private async performCompletionRequest(
    params: ChatCompletionParams,
    signal: AbortSignal,
  ): Promise<LLMCompletionResponse> {
    const temperature = params.temperature ?? this.temperature;
    const model = params.model ?? this.model;
    const cache = this.cacheRequest(params, model);
    const body = {
      // Release-tuned params, then the cache hint, then operator passthrough;
      // managed fields below always win.
      ...releaseParamsForModel(model),
      ...cache.fields,
      ...this.modelParams,
      model,
      messages: cache.messages,
      ...(temperature !== undefined && { temperature }),
      ...(params.maxTokens !== undefined && {
        [this.completionTokenParam]: params.maxTokens,
      }),
      ...(params.responseFormat && { response_format: params.responseFormat }),
    };

    const payload = JSON.stringify(body);
    const res = await fetchWithAuth(this.auth, (authHeaders) =>
      fetch(`${this.baseUrl}/chat/completions`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...authHeaders,
          'User-Agent': this.userAgent ?? DEFAULT_USER_AGENT,
          ...(this.userAgent ? {} : { 'X-Client-Name': 'fiscalcr' }),
        },
        body: payload,
        signal,
      }),
    );

    if (!res.ok) {
      const errorBody = await res.text().catch(() => '');
      // Surface the endpoint's own message — a bare "400 Bad Request" is undiagnosable.
      const snippet = errorSnippet(errorBody);
      logger.warn(
        { status: res.status, model, baseUrl: this.baseUrl, body: snippet },
        'LLM API request rejected',
      );
      throw new LLMApiError(
        `LLM API error: ${res.status} ${res.statusText}${snippet ? ` — ${snippet}` : ''}`,
        res.status,
        errorBody,
        parseRetryAfter(res.headers.get('retry-after')),
      );
    }

    const data = (await res.json()) as OpenAICompatibleResponse;
    const content = data.choices?.[0]?.message?.content ?? '';
    const finishReason = data.choices?.[0]?.finish_reason;

    const usage = {
      input: data.usage?.prompt_tokens ?? 0,
      output: data.usage?.completion_tokens ?? 0,
      cached: data.usage?.prompt_tokens_details?.cached_tokens ?? data.usage?.cached_tokens ?? 0,
      ...this.cacheWriteUsage(data.usage?.prompt_tokens_details?.cache_write_tokens ?? 0),
    };

    logger.info(
      {
        model,
        baseUrl: this.baseUrl,
        promptTokens: usage.input,
        completionTokens: usage.output,
        cachedTokens: usage.cached,
        cacheWriteTokens: data.usage?.prompt_tokens_details?.cache_write_tokens ?? 0,
        finishReason,
      },
      'LLM API call completed',
    );

    return { content, usage, finishReason };
  }
}

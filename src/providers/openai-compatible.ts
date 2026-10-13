import { ConfigError, errorSnippet, LLMApiError } from '../utils/errors.js';
import { releaseParamsForModel } from '../config/provider-models.js';
import { logger } from '../utils/logger.js';
import { fetchWithAuth, type RequestAuth } from './auth.js';
import {
  chatCacheRequest,
  chatCacheWrite,
  type PromptCacheSetting,
  type PromptCacheStyle,
} from './prompt-cache.js';
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
  promptCache?: PromptCacheSetting;
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
  private readonly promptCache?: PromptCacheSetting;

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
    const cache = chatCacheRequest(this.cacheStyle, this.promptCache, model, params.messages);
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

    const cacheWrite = chatCacheWrite(
      this.cacheStyle,
      this.promptCache,
      model,
      data.usage?.prompt_tokens_details?.cache_write_tokens ?? 0,
    );
    const usage = {
      input: data.usage?.prompt_tokens ?? 0,
      output: data.usage?.completion_tokens ?? 0,
      cached: data.usage?.prompt_tokens_details?.cached_tokens ?? data.usage?.cached_tokens ?? 0,
      ...(cacheWrite && { cacheWrite }),
    };

    logger.info(
      {
        model,
        baseUrl: this.baseUrl,
        promptTokens: usage.input,
        completionTokens: usage.output,
        cachedTokens: usage.cached,
        cacheWriteTokens: cacheWrite?.tokens ?? 0,
        finishReason,
      },
      'LLM API call completed',
    );

    return { content, usage, finishReason };
  }
}

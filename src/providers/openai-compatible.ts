import { ConfigError, LLMApiError } from '../utils/errors.js';
import { logger } from '../utils/logger.js';
import type {
  ChatCompletionParams,
  LLMCompletionResponse,
  LLMProvider,
} from './interface.js';

export interface OpenAICompatibleProviderConfig {
  apiKey: string;
  model: string;
  baseUrl?: string;
  temperature?: number;
  timeout?: number;
  /**
   * Override the User-Agent header. Some endpoints (e.g. Kimi for Coding)
   * whitelist clients by User-Agent and reject unknown ones. When set, the
   * X-Client-Name header is omitted so the request carries one identity.
   */
  userAgent?: string;
}

interface OpenAICompatibleResponse {
  choices: Array<{
    message: { content: string };
  }>;
  usage?: {
    prompt_tokens?: number;
    completion_tokens?: number;
    cached_tokens?: number;
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
  private readonly apiKey: string;
  private readonly model: string;
  private readonly baseUrl: string;
  private readonly temperature?: number;
  private readonly timeout: number;
  private readonly userAgent?: string;

  constructor(config: OpenAICompatibleProviderConfig) {
    this.apiKey = config.apiKey;
    this.model = config.model;
    if (!config.baseUrl) {
      throw new ConfigError('OpenAI-compatible provider requires an explicit baseUrl');
    }
    this.baseUrl = config.baseUrl;
    this.temperature = config.temperature;
    this.timeout = config.timeout ?? 300_000;
    this.userAgent = config.userAgent;
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
    const body = {
      model: this.model,
      messages: params.messages,
      ...(temperature !== undefined && { temperature }),
      ...(params.maxTokens !== undefined && { max_tokens: params.maxTokens }),
      ...(params.responseFormat && { response_format: params.responseFormat }),
    };

    const res = await fetch(`${this.baseUrl}/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${this.apiKey}`,
        'User-Agent': this.userAgent ?? 'fiscalcr/1.0',
        ...(this.userAgent ? {} : { 'X-Client-Name': 'fiscalcr' }),
      },
      body: JSON.stringify(body),
      signal,
    });

    if (!res.ok) {
      const errorBody = await res.text().catch(() => '');
      // Surface the endpoint's own message — a bare "400 Bad Request" is undiagnosable.
      const snippet = errorBody.replace(/\s+/g, ' ').trim().slice(0, 300);
      logger.warn(
        { status: res.status, model: this.model, baseUrl: this.baseUrl, body: snippet },
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

    const usage = {
      input: data.usage?.prompt_tokens ?? 0,
      output: data.usage?.completion_tokens ?? 0,
      cached: data.usage?.cached_tokens ?? 0,
    };

    logger.info(
      {
        model: this.model,
        baseUrl: this.baseUrl,
        promptTokens: usage.input,
        completionTokens: usage.output,
        cachedTokens: usage.cached,
      },
      'LLM API call completed',
    );

    return { content, usage };
  }
}

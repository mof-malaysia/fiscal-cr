import { ConfigError, LLMApiError } from '../utils/errors.js';
import { logger } from '../utils/logger.js';
import type {
  ChatCompletionParams,
  LLMCompletionResponse,
  LLMProvider,
} from './interface.js';

export interface AnthropicProviderConfig {
  apiKey: string;
  model: string;
  baseUrl?: string;
  /** Custom User-Agent header for provider allowlists and observability. */
  userAgent?: string;
  /** Provider-native request fields merged into each Messages request. */
  modelParams?: Record<string, unknown>;
}

interface AnthropicResponse {
  content?: Array<{ type?: string; text?: string }>;
  stop_reason?: string | null;
  usage?: {
    input_tokens?: number;
    output_tokens?: number;
    cache_creation_input_tokens?: number | null;
    cache_read_input_tokens?: number | null;
  };
}

const RESERVED_MODEL_PARAM_KEYS = new Set([
  'model',
  'messages',
  'system',
  'max_tokens',
  'max_completion_tokens',
  'temperature',
  'response_format',
  'stream',
]);

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

function parseRetryAfter(header: string | null): number | undefined {
  if (!header) return undefined;
  const seconds = Number(header);
  if (Number.isFinite(seconds)) return Math.max(0, seconds * 1_000);
  const date = Date.parse(header);
  if (!Number.isNaN(date)) return Math.max(0, date - Date.now());
  return undefined;
}

function textFromResponse(data: AnthropicResponse): string {
  return (data.content ?? [])
    .filter((block) => block.type === 'text' && typeof block.text === 'string')
    .map((block) => block.text)
    .join('');
}

/** Native adapter for Anthropic's Messages API. */
export class AnthropicProvider implements LLMProvider {
  private readonly apiKey: string;
  private readonly model: string;
  private readonly baseUrl: string;
  private readonly userAgent?: string;
  private readonly modelParams: Record<string, unknown>;

  constructor(config: AnthropicProviderConfig) {
    this.apiKey = config.apiKey;
    this.model = config.model;
    if (!config.baseUrl) {
      throw new ConfigError('Anthropic provider requires a baseUrl');
    }
    this.baseUrl = config.baseUrl.replace(/\/+$/, '');
    this.userAgent = config.userAgent;
    this.modelParams = sanitizeModelParams(config.modelParams);
  }

  async chatCompletion(params: ChatCompletionParams): Promise<LLMCompletionResponse> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), params.timeoutMs ?? 300_000);

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
    const system = params.messages
      .filter((message) => message.role === 'system')
      .map((message) => message.content)
      .filter((content) => content.length > 0);
    const messages = params.messages
      .filter((message) => message.role !== 'system')
      .map(({ role, content }) => ({ role, content }));

    // The Messages API has no response_format equivalent. Preserve the shared
    // JSON contract through an explicit system instruction instead.
    if (params.responseFormat?.type === 'json_object') {
      system.push('Respond with a single valid JSON object. Do not use Markdown fences.');
    }

    const body = {
      // Operator passthrough is the base layer; managed fields below win.
      ...this.modelParams,
      model: this.model,
      messages,
      max_tokens: params.maxTokens ?? 4_096,
      ...(system.length > 0 && { system: system.join('\n\n') }),
      ...(params.temperature !== undefined && { temperature: params.temperature }),
    };

    const res = await fetch(`${this.baseUrl}/messages`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Api-Key': this.apiKey,
        'anthropic-version': '2023-06-01',
        'User-Agent': this.userAgent ?? 'fiscalcr/1.0',
      },
      body: JSON.stringify(body),
      signal,
    });

    if (!res.ok) {
      const errorBody = await res.text().catch(() => '');
      const snippet = errorBody.replace(/\s+/g, ' ').trim().slice(0, 300);
      logger.warn(
        { status: res.status, model: this.model, baseUrl: this.baseUrl, body: snippet },
        'LLM API request rejected',
      );
      throw new LLMApiError(
        `Anthropic API error: ${res.status} ${res.statusText}${snippet ? ` — ${snippet}` : ''}`,
        res.status,
        errorBody,
        parseRetryAfter(res.headers.get('retry-after')),
      );
    }

    const data = (await res.json()) as AnthropicResponse;
    const usage = data.usage;
    const cached =
      (usage?.cache_read_input_tokens ?? 0) +
      (usage?.cache_creation_input_tokens ?? 0);
    const input = (usage?.input_tokens ?? 0) + cached;
    const finishReason = data.stop_reason === 'max_tokens'
      ? 'length'
      : data.stop_reason ?? undefined;

    logger.info(
      {
        model: this.model,
        baseUrl: this.baseUrl,
        promptTokens: input,
        completionTokens: usage?.output_tokens ?? 0,
        cachedTokens: usage?.cache_read_input_tokens ?? 0,
        finishReason,
      },
      'LLM API call completed',
    );

    return {
      content: textFromResponse(data),
      usage: {
        input,
        output: usage?.output_tokens ?? 0,
        cached: usage?.cache_read_input_tokens ?? 0,
      },
      finishReason,
    };
  }
}

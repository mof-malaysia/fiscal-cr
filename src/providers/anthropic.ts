import { ConfigError, errorSnippet, LLMApiError } from '../utils/errors.js';
import { logger } from '../utils/logger.js';
import { fetchWithAuth, staticAuth, type RequestAuth } from './auth.js';
import type { ReviewConfig } from '../config/schema.js';
import {
  DEFAULT_USER_AGENT,
  type ChatCompletionParams,
  type LLMCompletionResponse,
  type LLMProvider,
} from './interface.js';

/** Anthropic's static API key scheme. */
export function anthropicApiKeyAuth(apiKey: string): RequestAuth {
  return staticAuth({ 'X-Api-Key': apiKey });
}

export interface AnthropicProviderConfig {
  /** Request auth: a static API key or workload identity federation. */
  auth: RequestAuth;
  model: string;
  baseUrl?: string;
  /** Custom User-Agent header for provider allowlists and observability. */
  userAgent?: string;
  /** Provider-native request fields merged into each Messages request. */
  modelParams?: Record<string, unknown>;
  /** System-prompt cache lifetime. Omitted → no cache breakpoint. */
  promptCache?: ReviewConfig['promptCache'];
}

interface AnthropicResponse {
  content?: Array<{ type?: string; text?: string }>;
  stop_reason?: string | null;
  usage?: {
    input_tokens?: number;
    output_tokens?: number;
    cache_creation_input_tokens?: number | null;
    cache_read_input_tokens?: number | null;
    cache_creation?: {
      ephemeral_5m_input_tokens?: number;
      ephemeral_1h_input_tokens?: number;
    } | null;
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
  private readonly auth: RequestAuth;
  private readonly model: string;
  private readonly baseUrl: string;
  private readonly userAgent?: string;
  private readonly modelParams: Record<string, unknown>;
  private readonly promptCache?: ReviewConfig['promptCache'];

  constructor(config: AnthropicProviderConfig) {
    this.auth = config.auth;
    this.model = config.model;
    if (!config.baseUrl) {
      throw new ConfigError('Anthropic provider requires a baseUrl');
    }
    this.baseUrl = config.baseUrl.replace(/\/+$/, '');
    this.userAgent = config.userAgent;
    this.modelParams = sanitizeModelParams(config.modelParams);
    this.promptCache = config.promptCache;
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

    const model = params.model ?? this.model;
    // The system prompt depends only on repo config, so it is byte-identical
    // across calls, stages, and PRs. Mark it as a cache breakpoint; prompts
    // below the model's minimum cacheable length are silently not cached.
    const systemText = system.join('\n\n');
    const cacheControl =
      this.promptCache === '1h' ? { type: 'ephemeral', ttl: '1h' }
        : this.promptCache === '5m' ? { type: 'ephemeral' }
          : undefined;
    const systemField = system.length === 0
      ? undefined
      : cacheControl
        ? [{ type: 'text', text: systemText, cache_control: cacheControl }]
        : systemText;
    const body = {
      // Operator passthrough is the base layer; managed fields below always win.
      ...this.modelParams,
      model,
      messages,
      max_tokens: params.maxTokens ?? 4_096,
      ...(systemField !== undefined && { system: systemField }),
      ...(params.temperature !== undefined && { temperature: params.temperature }),
    };

    const payload = JSON.stringify(body);
    const res = await fetchWithAuth(this.auth, (authHeaders) =>
      fetch(`${this.baseUrl}/messages`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...authHeaders,
          'anthropic-version': '2023-06-01',
          'User-Agent': this.userAgent ?? DEFAULT_USER_AGENT,
        },
        body: payload,
        signal,
      }),
    );

    if (!res.ok) {
      const errorBody = await res.text().catch(() => '');
      const snippet = errorSnippet(errorBody);
      logger.warn(
        { status: res.status, model, baseUrl: this.baseUrl, body: snippet },
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
    // Older responses omit the per-TTL split; treat their writes as 5m.
    const cacheWrite1h = usage?.cache_creation?.ephemeral_1h_input_tokens ?? 0;
    const cacheWrite5m = usage?.cache_creation
      ? usage.cache_creation.ephemeral_5m_input_tokens ?? 0
      : usage?.cache_creation_input_tokens ?? 0;
    const finishReason = data.stop_reason === 'max_tokens'
      ? 'length'
      : data.stop_reason ?? undefined;

    logger.info(
      {
        model,
        baseUrl: this.baseUrl,
        promptTokens: input,
        completionTokens: usage?.output_tokens ?? 0,
        cachedTokens: usage?.cache_read_input_tokens ?? 0,
        cacheWriteTokens: cacheWrite5m + cacheWrite1h,
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
        ...(cacheWrite5m > 0 && { cacheWrite5m }),
        ...(cacheWrite1h > 0 && { cacheWrite1h }),
      },
      finishReason,
    };
  }
}

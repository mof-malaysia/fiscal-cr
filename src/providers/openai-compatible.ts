import type { ChatMessage } from '../types/review.js';
import { ConfigError, LLMApiError } from '../utils/errors.js';
import { logger } from '../utils/logger.js';
import { estimateTokens } from '../utils/tokens.js';
import type { LLMCompletionResponse, LLMProvider } from './interface.js';

export interface OpenAICompatibleProviderConfig {
  apiKey: string;
  model: string;
  baseUrl?: string;
  temperature?: number;
  timeout?: number;
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

/**
 * Generic provider for OpenAI-compatible chat completion APIs.
 * Works with any OpenAI-compatible endpoint (FiscalCR, OpenAI, Groq, self-hosted, etc.).
 */
export class OpenAICompatibleProvider implements LLMProvider {
  private readonly apiKey: string;
  private readonly model: string;
  private readonly baseUrl: string;
  private readonly temperature: number;
  private readonly timeout: number;

  constructor(config: OpenAICompatibleProviderConfig) {
    this.apiKey = config.apiKey;
    this.model = config.model;
    if (!config.baseUrl) {
      throw new ConfigError('OpenAI-compatible provider requires an explicit baseUrl');
    }
    this.baseUrl = config.baseUrl;
    this.temperature = config.temperature ?? 1;
    this.timeout = config.timeout ?? 300_000;
  }

  async chatCompletion(params: {
    messages: ChatMessage[];
    responseFormat?: { type: 'json_object' | 'text' };
  }): Promise<LLMCompletionResponse> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeout);

    try {
      return await this.performCompletionRequest(
        params.messages,
        params.responseFormat,
        controller.signal,
      );
    } finally {
      clearTimeout(timer);
    }
  }

  private async performCompletionRequest(
    messages: ChatMessage[],
    responseFormat: { type: 'json_object' | 'text' } | undefined,
    signal: AbortSignal,
  ): Promise<LLMCompletionResponse> {
    const body = {
      model: this.model,
      messages,
      temperature: this.temperature,
      ...(responseFormat && { response_format: responseFormat }),
    };

    const res = await fetch(`${this.baseUrl}/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${this.apiKey}`,
        'User-Agent': 'fiscalcr/1.0',
        'X-Client-Name': 'fiscalcr',
      },
      body: JSON.stringify(body),
      signal,
    });

    if (!res.ok) {
      const errorBody = await res.text().catch(() => '');
      throw new LLMApiError(
        `LLM API error: ${res.status} ${res.statusText}`,
        res.status,
        errorBody,
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

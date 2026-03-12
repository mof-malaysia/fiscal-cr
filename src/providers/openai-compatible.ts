import type { ChatMessage } from '../types/review.js';
import { KimiApiError } from '../utils/errors.js';
import { logger } from '../utils/logger.js';
import type { LLMCompletionResponse, LLMProvider } from './interface.js';

export interface OpenAICompatibleProviderConfig {
  apiKey: string;
  model: string;
  baseUrl?: string;
  maxTokens?: number;
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
 * Works with Kimi, OpenAI, Groq, and self-hosted compatible endpoints.
 */
export class OpenAICompatibleProvider implements LLMProvider {
  private readonly apiKey: string;
  private readonly model: string;
  private readonly baseUrl: string;
  private readonly maxTokens: number;
  private readonly temperature: number;
  private readonly timeout: number;

  constructor(config: OpenAICompatibleProviderConfig) {
    this.apiKey = config.apiKey;
    this.model = config.model;
    this.baseUrl = config.baseUrl ?? 'https://api.kimi.com/coding/v1';
    this.maxTokens = config.maxTokens ?? 16384;
    this.temperature = config.temperature ?? 1;
    this.timeout = config.timeout ?? 300_000;
  }

  async chatCompletion(params: {
    messages: ChatMessage[];
    responseFormat?: { type: 'json_object' | 'text' };
  }): Promise<LLMCompletionResponse> {
    const body = {
      model: this.model,
      messages: params.messages,
      max_tokens: this.maxTokens,
      temperature: this.temperature,
      ...(params.responseFormat && { response_format: params.responseFormat }),
    };

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeout);

    try {
      const res = await fetch(`${this.baseUrl}/chat/completions`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${this.apiKey}`,
          'User-Agent': 'kimi-code-reviewer/1.0',
          'X-Client-Name': 'kimi-code-reviewer',
        },
        body: JSON.stringify(body),
        signal: controller.signal,
      });

      if (!res.ok) {
        const errorBody = await res.text().catch(() => '');
        throw new KimiApiError(
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
    } finally {
      clearTimeout(timer);
    }
  }
}

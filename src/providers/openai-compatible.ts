import type { ChatMessage } from '../types/review.js';
import { KimiApiError } from '../utils/errors.js';
import { logger } from '../utils/logger.js';
import { estimateTokens } from '../utils/tokens.js';
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
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeout);

    try {
      try {
        return await this.performCompletionRequest(
          params.messages,
          params.responseFormat,
          this.maxTokens,
          controller.signal,
        );
      } catch (err) {
        if (!(err instanceof KimiApiError) || err.statusCode !== 400) {
          throw err;
        }

        const maxTotalTokens = extractMaxTotalTokens(String(err.responseBody ?? ''));
        if (!maxTotalTokens) {
          throw err;
        }

        const retryMaxTokens = calculateSafeCompletionBudget(
          params.messages,
          maxTotalTokens,
          this.maxTokens,
        );

        if (retryMaxTokens <= 0 || retryMaxTokens >= this.maxTokens) {
          throw err;
        }

        logger.warn(
          {
            model: this.model,
            baseUrl: this.baseUrl,
            originalMaxTokens: this.maxTokens,
            retryMaxTokens,
            maxTotalTokens,
          },
          'Retrying LLM call with reduced max_tokens due to model token limit',
        );

        return await this.performCompletionRequest(
          params.messages,
          params.responseFormat,
          retryMaxTokens,
          controller.signal,
        );
      }
    } finally {
      clearTimeout(timer);
    }
  }

  private async performCompletionRequest(
    messages: ChatMessage[],
    responseFormat: { type: 'json_object' | 'text' } | undefined,
    maxTokens: number,
    signal: AbortSignal,
  ): Promise<LLMCompletionResponse> {
    const body = {
      model: this.model,
      messages,
      max_tokens: maxTokens,
      temperature: this.temperature,
      ...(responseFormat && { response_format: responseFormat }),
    };

    const res = await fetch(`${this.baseUrl}/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${this.apiKey}`,
        'User-Agent': 'kimi-code-reviewer/1.0',
        'X-Client-Name': 'kimi-code-reviewer',
      },
      body: JSON.stringify(body),
      signal,
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
  }
}

function extractMaxTotalTokens(errorBody: string): number | null {
  const patterns = [
    /max_model_len(?:=max_total_tokens)?=(\d+)/i,
    /max[_\s-]?total[_\s-]?tokens[^\d]*(\d+)/i,
  ];

  for (const pattern of patterns) {
    const match = errorBody.match(pattern);
    if (match) {
      const parsed = Number.parseInt(match[1], 10);
      if (Number.isFinite(parsed) && parsed > 0) return parsed;
    }
  }

  return null;
}

function calculateSafeCompletionBudget(
  messages: ChatMessage[],
  maxTotalTokens: number,
  configuredMaxTokens: number,
): number {
  const promptEstimate = messages.reduce((sum, msg) => sum + estimateTokens(msg.content), 0) +
    messages.length * 8;
  const safetyReserve = 64;
  const available = maxTotalTokens - promptEstimate - safetyReserve;
  const capped = Math.min(configuredMaxTokens, available);
  return Math.max(0, capped);
}

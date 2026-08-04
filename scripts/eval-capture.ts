import type {
  ChatCompletionParams,
  LLMCompletionResponse,
  LLMProvider,
  LLMTokenUsage,
} from '../src/providers/interface.js';
import type { ReviewAnnotation, WalkthroughEntry } from '../src/types/review.js';

/**
 * Transparent LLMProvider wrapper used by the eval harness. Records response
 * metadata (duration, usage, finish reason, content length, parse result) via
 * onCall without modifying production provider code. The raw response content
 * is passed to the callback but never persisted or printed by the harness.
 */
export interface CaptureInfo {
  /** 1-based call order within the run. */
  order: number;
  durationMs: number;
  response: LLMCompletionResponse;
}

export interface CapturedCall {
  /** 1-based call order within the run. */
  order: number;
  durationMs: number;
  finishReason?: string;
  /** Raw response character count — content itself is never stored. */
  rawChars: number;
  usage: LLMTokenUsage;
  /** Real parseFastPathResponse success. */
  parseSuccess: boolean;
  /** Top-level keys present in the raw JSON object (extractJson). */
  topLevelKeys: string[];
  generatedFindings: number;
  score: number | null;
  intent: string;
  summary: string;
  walkthrough: WalkthroughEntry[];
  findings: ReviewAnnotation[];
}

export function wrapCapturingProvider(
  inner: LLMProvider,
  onCall: (info: CaptureInfo) => void,
): LLMProvider {
  let order = 0;
  return {
    async chatCompletion(params: ChatCompletionParams): Promise<LLMCompletionResponse> {
      order += 1;
      const startedAt = Date.now();
      const response = await inner.chatCompletion(params);
      onCall({ order, durationMs: Date.now() - startedAt, response });
      return response;
    },
  };
}

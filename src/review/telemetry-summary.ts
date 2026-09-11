import type { ReviewResult } from '../types/review.js';
import { calculateCostForModel } from '../utils/tokens.js';

function tableCell(value: string): string {
  return value.replace(/[|\r\n]/g, (character) => (character === '|' ? '\\|' : ' '));
}

function displayModel(result: ReviewResult): string | undefined {
  const model = result.costEstimate?.model;
  if (!model) return undefined;
  const provider = result.costEstimate?.provider;
  return provider && !model.includes('/') ? `${provider}/${model}` : model;
}

/** Render compact aggregate telemetry for user-facing comments. */
export function renderTelemetrySummary(
  result: ReviewResult,
  heading = '📊 Review telemetry & cost',
): string[] {
  const cost = result.costEstimate?.usd ?? calculateCostForModel(result.tokensUsed, {});
  const rows = [
    `| Input tokens | ${result.tokensUsed.input.toLocaleString()} |`,
    `| Output tokens | ${result.tokensUsed.output.toLocaleString()} |`,
    `| Cached tokens | ${result.tokensUsed.cached.toLocaleString()} |`,
  ];
  if (result.callCount !== undefined) rows.push(`| LLM calls | ${result.callCount.toLocaleString()} |`);
  rows.push(`| Estimated cost | $${cost.toFixed(4)} |`);
  const model = displayModel(result);
  if (model) rows.push(`| Model | ${tableCell(model)} |`);
  return [
    '<details>',
    `<summary>${heading}</summary>`,
    '',
    '| Metric | Value |',
    '|--------|-------|',
    ...rows,
    '</details>',
  ];
}

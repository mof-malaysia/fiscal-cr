import type { ReviewResult } from '../types/review.js';
import { calculateCostForModel } from '../utils/tokens.js';

function tableCell(value: string): string {
  return value.replace(/[|\r\n]/g, (character) => (character === '|' ? '\\|' : ' '));
}

/** Render compact token, cost, and model telemetry for user-facing comments. */
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
  if (result.costEstimate) rows.push(`| Pricing source | ${result.costEstimate.source} |`);
  if (result.costEstimate?.provider) rows.push(`| Provider | ${tableCell(result.costEstimate.provider)} |`);
  if (result.costEstimate?.model) rows.push(`| Model | ${tableCell(result.costEstimate.model)} |`);
  if (
    result.costEstimate?.matchedModel &&
    result.costEstimate.matchedModel !== result.costEstimate.model
  ) {
    rows.push(`| Pricing match | ${tableCell(result.costEstimate.matchedModel)} |`);
  }
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

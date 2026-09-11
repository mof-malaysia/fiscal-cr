import type { ReviewResult } from '../types/review.js';
import { calculateCostBreakdownForModel } from '../utils/tokens.js';

function tableCell(value: string): string {
  return value.replace(/[|\r\n]/g, (character) => (character === '|' ? '\\|' : ' '));
}

function displayModel(result: ReviewResult): string | undefined {
  const model = result.costEstimate?.model;
  if (!model) return undefined;
  const provider = result.costEstimate?.provider;
  return provider ? `${provider}/${model}` : model;
}

/** Render aggregate cost and token metrics for user-facing surfaces. */
export function renderTelemetrySummary(
  result: ReviewResult,
  heading = '📊 Token metrics',
): string[] {
  const fallback = calculateCostBreakdownForModel(result.tokensUsed, {
    provider: result.costEstimate?.provider,
    model: result.costEstimate?.model,
  });
  const inputUsd = result.costEstimate?.inputUsd ?? fallback.inputUsd;
  const outputUsd = result.costEstimate?.outputUsd ?? fallback.outputUsd;
  const cachedUsd = result.costEstimate?.cachedUsd ?? fallback.cachedUsd;
  const cost = result.costEstimate?.usd ?? fallback.totalUsd;
  const model = displayModel(result);
  const models = result.costEstimate?.models ?? [];
  const multipleModels = models.length > 1;
  const costSummary = [
    multipleModels
      ? `**Models:** ${models.length} models`
      : model
        ? `**Model:** \`${tableCell(model)}\``
        : undefined,
    `**Total cost:** $${cost.toFixed(4)}`,
  ].filter((line): line is string => line !== undefined);
  const modelBreakdown = multipleModels
    ? [
        '<details>',
        '<summary>📊 Model breakdown</summary>',
        '',
        '| Model | Calls | Input tokens | Cached input | Output tokens | Cost |',
        '|-------|-------|--------------|--------------|---------------|------|',
        ...models.map(
          (summary) =>
            `| ${tableCell(summary.model)} | ${summary.calls.toLocaleString()} | ${Math.max(0, summary.inputTokens - summary.cachedTokens).toLocaleString()} | ${summary.cachedTokens.toLocaleString()} | ${summary.outputTokens.toLocaleString()} | $${summary.usd.toFixed(4)} |`,
        ),
        '</details>',
        '',
      ]
    : [];
  const rows = [
    `| Input tokens (uncached) | ${Math.max(0, result.tokensUsed.input - result.tokensUsed.cached).toLocaleString()} | $${inputUsd.toFixed(4)} |`,
    `| Cached input tokens | ${result.tokensUsed.cached.toLocaleString()} | $${cachedUsd.toFixed(4)} |`,
    `| Output tokens | ${result.tokensUsed.output.toLocaleString()} | $${outputUsd.toFixed(4)} |`,
  ];
  if (result.callCount !== undefined) rows.push(`| LLM calls | ${result.callCount.toLocaleString()} | — |`);
  return [
    ...costSummary,
    '',
    ...modelBreakdown,
    '<details>',
    `<summary>${heading}</summary>`,
    '',
    '| Metric | Tokens | Cost |',
    '|--------|--------|------|',
    ...rows,
    '</details>',
  ];
}

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

/** Render user-facing token usage and cost details. */
export interface TelemetrySummaryOptions {
  /** Replace the current-run cost with cumulative sticky-review spend. */
  cumulativeCostUsd?: number;
}

export function renderTelemetrySummary(
  result: ReviewResult,
  heading = '📊 Token usage & cost',
  options: TelemetrySummaryOptions = {},
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
  const totalCost = options.cumulativeCostUsd ?? cost;
  const totalCostLabel = options.cumulativeCostUsd === undefined ? 'Review cost' : 'Cumulative review cost';
  const costSummary = [
    multipleModels
      ? `**Models used:** ${models.length}`
      : model
        ? `**Model:** \`${tableCell(model)}\``
        : undefined,
    `**${totalCostLabel}:** $${totalCost.toFixed(4)}`,
  ].filter((line): line is string => line !== undefined);
  const modelBreakdown = multipleModels
    ? [
        '**Cost by model**',
        '',
        '| Model | Calls | Uncached input tokens | Cached input tokens | Output tokens | Review cost |',
        '|-------|-------|-----------------------|---------------------|---------------|-------------|',
        ...models.map(
          (summary) =>
            `| ${tableCell(summary.model)} | ${summary.calls.toLocaleString()} | ${Math.max(0, summary.inputTokens - summary.cachedTokens).toLocaleString()} | ${summary.cachedTokens.toLocaleString()} | ${summary.outputTokens.toLocaleString()} | $${summary.usd.toFixed(4)} |`,
        ),
        '',
      ]
    : [];
  const rows = multipleModels
    ? []
    : [
        `| Uncached input | ${Math.max(0, result.tokensUsed.input - result.tokensUsed.cached).toLocaleString()} | $${inputUsd.toFixed(4)} |`,
        `| Cached input | ${result.tokensUsed.cached.toLocaleString()} | $${cachedUsd.toFixed(4)} |`,
        `| Output | ${result.tokensUsed.output.toLocaleString()} | $${outputUsd.toFixed(4)} |`,
      ];
  if (!multipleModels && result.callCount !== undefined) rows.push(`| LLM calls | ${result.callCount.toLocaleString()} | — |`);
  return [
    ...costSummary,
    '',
    '<details>',
    `<summary>${heading}</summary>`,
    '',
    ...modelBreakdown,
    ...(multipleModels ? [] : ['| Token usage | Tokens | Cost |', '|-------------|--------|------|', ...rows]),
    '</details>',
  ];
}

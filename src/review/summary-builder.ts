import type { ReviewResult, Severity } from '../types/review.js';
import type { DiagramArtifact } from '../types/diagram.js';
import { calculateCost } from '../utils/tokens.js';
import { renderDiagramSection } from './diagram-renderer.js';
const SEVERITY_EMOJI: Record<Severity, string> = {
  critical: '🔴',
  warning: '🟡',
  suggestion: '🔵',
  nitpick: '⚪',
};
const MAX_CHECK_SUMMARY_BYTES = 60_000;

function renderThreadCleanup(
  cleanup: NonNullable<ReviewResult['threadCleanup']> | undefined,
): string[] {
  if (!cleanup) return [];
  if (cleanup.unavailable) {
    return [
      '### Inline thread cleanup',
      '',
      'Thread cleanup was unavailable; finding status is independent of inline conversation status.',
    ];
  }
  const lines = [
    '### Inline thread cleanup',
    '',
    `Resolved ${cleanup.resolved} of ${cleanup.attempted} outdated inline thread(s).`,
    'Finding status is independent of inline conversation status.',
  ];
  if (cleanup.failed > 0) {
    lines.push(
      `${cleanup.failed} inline thread(s) remain unresolved, usually because the GitHub token lacks thread-resolution permission.`,
    );
  }
  return lines;
}

/**
 * Build a markdown summary for the Check Run output.
 *
 * The check surface follows the reviewer reading order: summary, optional map,
 * walkthrough, findings, then score and accounting metadata. Intent remains
 * synthesis context and is not rendered as a second summary.
 */
export function buildSummary(result: ReviewResult): string {
  const cost = result.costEstimate?.usd ?? calculateCost(result.tokensUsed);
  const lines: string[] = ['## 🤖 FiscalCR Code Review', '', result.summary, ''];

  const diagram = renderOptionalDiagram(result.diagram);
  if (diagram) lines.push(diagram, '');
  const cleanup = renderThreadCleanup(result.threadCleanup);
  if (cleanup.length > 0) lines.push(...cleanup, '');

  if (result.walkthrough && result.walkthrough.length > 0) {
    lines.push('### Walkthrough\n');
    lines.push('| File | Change Summary |');
    lines.push('|------|----------------|');
    for (const entry of result.walkthrough) {
      lines.push(`| \`${entry.path}\` | ${entry.summary.replace(/\|/g, '\\|')} |`);
    }
    lines.push('');
  }

  const hasIssues = Object.values(result.stats).some((v) => v > 0);
  if (hasIssues) {
    lines.push('### Findings\n');
    lines.push('| Severity | Count |');
    lines.push('|----------|-------|');
    for (const severity of ['critical', 'warning', 'suggestion', 'nitpick'] as Severity[]) {
      const count = result.stats[severity];
      if (count > 0) lines.push(`| ${SEVERITY_EMOJI[severity]} ${severity} | ${count} |`);
    }
    lines.push('');
  } else {
    lines.push('### ✅ No issues found\n');
  }

  lines.push('### Score\n', `**Score:** ${result.score}/100`, '');
  lines.push('<details>');
  lines.push('<summary>📊 Token Usage</summary>\n');
  lines.push('| Metric | Value |');
  lines.push('|--------|-------|');
  lines.push(`| Input tokens | ${result.tokensUsed.input.toLocaleString()} |`);
  lines.push(`| Output tokens | ${result.tokensUsed.output.toLocaleString()} |`);
  lines.push(`| Cached tokens | ${result.tokensUsed.cached.toLocaleString()} |`);
  if (result.callCount !== undefined) lines.push(`| LLM calls | ${result.callCount} |`);
  lines.push(`| Estimated cost | $${cost} |`);
  if (result.costEstimate) lines.push(`| Pricing source | ${result.costEstimate.source} |`);
  lines.push('</details>');
  const baseline = result.diagram
    ? buildSummary({ ...result, diagram: undefined })
    : lines.join('\n');
  if (!diagram || Buffer.byteLength(lines.join('\n'), 'utf8') > MAX_CHECK_SUMMARY_BYTES) {
    return baseline;
  }
  return lines.join('\n');
}

/**
 * Rendering failure is isolated: the ordinary summary, findings, and metadata
 * remain publishable when an auxiliary artifact is malformed.
 */
function renderOptionalDiagram(diagram?: DiagramArtifact): string | undefined {
  if (!diagram) return undefined;
  try {
    return renderDiagramSection(diagram, 'text');
  } catch {
    return undefined;
  }
}

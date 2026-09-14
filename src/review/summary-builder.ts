import type { ReviewResult, Severity } from '../types/review.js';
import type { VisualArtifact } from '../types/visual.js';
import { renderVisualSection } from './visual-renderer.js';
import { renderTelemetrySummary } from './telemetry-summary.js';
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
      `${cleanup.failed} inline thread(s) remain unresolved; see the logs for the GitHub API error.`,
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
  const lines: string[] = ['## 🤖 FiscalCR Code Review', '', result.summary, ''];

  const visual = renderOptionalVisual(result.visualize);
  if (visual) lines.push(visual, '');
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
  lines.push(...renderTelemetrySummary(result));
  const baseline = result.visualize
    ? buildSummary({ ...result, visualize: undefined })
    : lines.join('\n');
  if (!visual || Buffer.byteLength(lines.join('\n'), 'utf8') > MAX_CHECK_SUMMARY_BYTES) {
    return baseline;
  }
  return lines.join('\n');
}

/**
 * Rendering failure is isolated: the ordinary summary, findings, and metadata
 * remain publishable when an auxiliary artifact is malformed.
 */
function renderOptionalVisual(visual?: VisualArtifact): string | undefined {
  if (!visual) return undefined;
  try {
    return renderVisualSection(visual, 'text');
  } catch {
    return undefined;
  }
}

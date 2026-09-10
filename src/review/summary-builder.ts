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

/**
 * Build a markdown summary for the Check Run output.
 */
export function buildSummary(result: ReviewResult): string {
  const cost = result.costEstimate?.usd ?? calculateCost(result.tokensUsed);
  const lines: string[] = [];
  lines.push(`## Score: ${result.score}/100\n`);
  if (result.intent) {
    lines.push(`> ${result.intent}\n`);
  }
  lines.push(result.summary);
  lines.push('');

  if (result.walkthrough && result.walkthrough.length > 0) {
    lines.push('### Walkthrough\n');
    lines.push('| File | Change Summary |');
    lines.push('|------|----------------|');
    for (const entry of result.walkthrough) {
      lines.push(`| \`${entry.path}\` | ${entry.summary.replace(/\|/g, '\\|')} |`);
    }
    lines.push('');
  }

  // Stats table
  const hasIssues = Object.values(result.stats).some((v) => v > 0);
  if (hasIssues) {
    lines.push('### Findings\n');
    lines.push('| Severity | Count |');
    lines.push('|----------|-------|');
    for (const severity of ['critical', 'warning', 'suggestion', 'nitpick'] as Severity[]) {
      const count = result.stats[severity];
      if (count > 0) {
        lines.push(`| ${SEVERITY_EMOJI[severity]} ${severity} | ${count} |`);
      }
    }
    lines.push('');
  } else {
    lines.push('### ✅ No issues found\n');
  }

  // Token usage
  lines.push('<details>');
  lines.push('<summary>📊 Token Usage</summary>\n');
  lines.push(`| Metric | Value |`);
  lines.push(`|--------|-------|`);
  lines.push(`| Input tokens | ${result.tokensUsed.input.toLocaleString()} |`);
  lines.push(`| Output tokens | ${result.tokensUsed.output.toLocaleString()} |`);
  lines.push(`| Cached tokens | ${result.tokensUsed.cached.toLocaleString()} |`);
  if (result.callCount !== undefined) {
    lines.push(`| LLM calls | ${result.callCount} |`);
  }
  lines.push(`| Estimated cost | $${cost} |`);
  if (result.costEstimate) {
    lines.push(`| Pricing source | ${result.costEstimate.source} |`);
  }
  lines.push('</details>');

  const baseline = lines.join('\n');
  return appendOptionalDiagram(baseline, result.diagram);
}

/**
 * Conservative UTF-8 budget for the complete App check summary body. If the
 * optional change-diagram section would push the body past this limit, omit it
 * and publish the unchanged baseline (findings and state are never truncated).
 */
const MAX_CHECK_SUMMARY_BYTES = 60_000;

/**
 * Append the optional non-visual (text) change-diagram section to the App check
 * summary. The plain-text renderer is used so no raw Mermaid syntax reaches this
 * surface. Rendering failure is isolated: any error returns the untouched
 * baseline so the review conclusion and findings stay intact.
 */
function appendOptionalDiagram(baseline: string, diagram?: DiagramArtifact): string {
  if (!diagram) return baseline;
  let section: string;
  try {
    section = renderDiagramSection(diagram, 'text');
  } catch {
    return baseline;
  }
  const candidate = `${baseline}\n\n${section}`;
  if (Buffer.byteLength(candidate, 'utf8') > MAX_CHECK_SUMMARY_BYTES) {
    return baseline;
  }
  return candidate;
}

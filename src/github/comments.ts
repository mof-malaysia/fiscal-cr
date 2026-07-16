import type { Octokit } from '@octokit/rest';
import type { ReviewAnnotation, ReviewResult, Severity } from '../types/review.js';
import { calculateCost } from '../utils/tokens.js';
import { logger } from '../utils/logger.js';

const SEVERITY_EMOJI: Record<Severity, string> = {
  critical: '🔴',
  warning: '🟡',
  suggestion: '🔵',
  nitpick: '⚪',
};

export async function createPRReview(
  octokit: Octokit,
  params: {
    owner: string;
    repo: string;
    pullNumber: number;
    commitSha: string;
    result: ReviewResult;
    failOn: 'critical' | 'warning' | 'never';
  },
): Promise<void> {
  const { owner, repo, pullNumber, commitSha, result, failOn } = params;

  const shouldRequestChanges =
    failOn === 'critical'
      ? result.stats.critical > 0
      : failOn === 'warning'
        ? result.stats.critical > 0 || result.stats.warning > 0
        : false;

  const event = shouldRequestChanges ? 'REQUEST_CHANGES' : 'COMMENT';

  const body = buildReviewBody(result);

  // Create the review with inline comments
  const comments = result.annotations
    .filter((a) => a.severity !== 'nitpick') // nitpicks only go to Check annotations
    .map((a) => ({
      path: a.path,
      line: a.endLine,
      side: 'RIGHT' as const,
      body: formatAnnotationComment(a),
    }));

  try {
    await octokit.pulls.createReview({
      owner,
      repo,
      pull_number: pullNumber,
      commit_id: commitSha,
      event,
      body,
      comments,
    });

    logger.info(
      { pullNumber, event, commentCount: comments.length },
      'PR review created',
    );
  } catch (err) {
    // If inline comments fail (e.g., line not in diff), fall back to body-only review
    logger.warn({ err }, 'Failed to create review with inline comments, falling back');
    await octokit.pulls.createReview({
      owner,
      repo,
      pull_number: pullNumber,
      commit_id: commitSha,
      event,
      body: body + '\n\n> _Note: Some inline comments could not be placed on the diff._',
    });
  }
}

function buildReviewBody(result: ReviewResult): string {
  const cost = calculateCost(result.tokensUsed);
  const lines: string[] = [];

  lines.push('## 🤖 FiscalCR Code Review\n');
  if (result.intent) {
    lines.push(`> ${result.intent}\n`);
  }
  lines.push(result.summary);
  lines.push('');
  lines.push(`**Score:** ${result.score}/100`);
  lines.push('');

  if (result.walkthrough && result.walkthrough.length > 0) {
    lines.push('<details>');
    lines.push('<summary>📝 Walkthrough</summary>\n');
    lines.push('| File | Change Summary |');
    lines.push('|------|----------------|');
    for (const entry of result.walkthrough) {
      lines.push(`| \`${entry.path}\` | ${entry.summary.replace(/\|/g, '\\|')} |`);
    }
    lines.push('</details>\n');
  }

  lines.push('| Severity | Count |');
  lines.push('|----------|-------|');
  for (const [severity, count] of Object.entries(result.stats)) {
    if (count > 0) {
      lines.push(`| ${SEVERITY_EMOJI[severity as Severity]} ${severity} | ${count} |`);
    }
  }

  lines.push('');
  lines.push('<details>');
  lines.push('<summary>Token Usage & Cost</summary>\n');
  lines.push(`- Input: ${result.tokensUsed.input.toLocaleString()} tokens`);
  lines.push(`- Output: ${result.tokensUsed.output.toLocaleString()} tokens`);
  lines.push(`- Cached: ${result.tokensUsed.cached.toLocaleString()} tokens`);
  lines.push(`- Estimated cost: $${cost}`);
  lines.push('</details>\n');

  lines.push('---');
  lines.push('*Powered by [FiscalCR](https://github.com/mof-malaysia/fiscal-cr) — model-agnostic AI code review*');

  return lines.join('\n');
}

function formatAnnotationComment(a: ReviewAnnotation): string {
  const parts: string[] = [];
  parts.push(`${SEVERITY_EMOJI[a.severity]} **[${a.severity}]** ${a.title}\n`);
  parts.push(a.body);

  if (a.suggestedFix) {
    parts.push('\n**Suggested fix:**');
    parts.push('```suggestion');
    parts.push(a.suggestedFix);
    parts.push('```');
  }

  return parts.join('\n');
}

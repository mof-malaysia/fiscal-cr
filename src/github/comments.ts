import type { Octokit } from '@octokit/rest';
import type { ChangedFile, ReviewAnnotation, ReviewResult, Severity } from '../types/review.js';
import { commentableLines } from '../review/diff-analyzer.js';
import { fingerprintAnnotation, fingerprintMarker } from './fingerprint.js';
import { calculateCost } from '../utils/tokens.js';
import { logger } from '../utils/logger.js';

const SEVERITY_EMOJI: Record<Severity, string> = {
  critical: '🔴',
  warning: '🟡',
  suggestion: '🔵',
  nitpick: '⚪',
};

export interface PlacementPartition {
  placeable: ReviewAnnotation[];
  demoted: ReviewAnnotation[];
}

/**
 * Split annotations into those whose end line can host an inline review
 * comment on the PR diff, and those that must be demoted to check-run
 * annotations + a sticky-comment section.
 */
export function partitionPlaceable(
  annotations: ReviewAnnotation[],
  changedFiles: ChangedFile[],
): PlacementPartition {
  const lineCache = new Map<string, Set<number>>();
  for (const f of changedFiles) {
    if (f.patch) lineCache.set(f.filename, commentableLines(f.patch));
  }

  const placeable: ReviewAnnotation[] = [];
  const demoted: ReviewAnnotation[] = [];
  for (const a of annotations) {
    if (lineCache.get(a.path)?.has(a.endLine)) placeable.push(a);
    else demoted.push(a);
  }
  return { placeable, demoted };
}

export interface IncrementalReviewOutcome {
  /** Review id when a review was posted, else null. */
  reviewId: number | null;
  /** Annotations actually posted inline. */
  posted: ReviewAnnotation[];
  /** Annotations demoted out of the inline review (unplaceable or 422 fallback). */
  demoted: ReviewAnnotation[];
}

/**
 * Post one small review containing only this run's new findings. Zero
 * placeable findings and a non-blocking event → nothing is posted at all.
 * A 422 on the inline comments retries once body-only (last resort).
 */
export async function createIncrementalReview(
  octokit: Octokit,
  params: {
    owner: string;
    repo: string;
    pullNumber: number;
    commitSha: string;
    annotations: ReviewAnnotation[];
    changedFiles: ChangedFile[];
    event: 'COMMENT' | 'REQUEST_CHANGES';
    body: string;
  },
): Promise<IncrementalReviewOutcome> {
  const { owner, repo, pullNumber, commitSha, annotations, changedFiles, event, body } = params;

  const inlineCandidates = annotations.filter((a) => a.severity !== 'nitpick');
  const { placeable, demoted } = partitionPlaceable(inlineCandidates, changedFiles);
  demoted.push(...annotations.filter((a) => a.severity === 'nitpick'));

  if (placeable.length === 0 && event === 'COMMENT') {
    logger.info({ pullNumber }, 'No new placeable findings — no review posted');
    return { reviewId: null, posted: [], demoted };
  }

  const comments = placeable.map((a) => ({
    path: a.path,
    line: a.endLine,
    side: 'RIGHT' as const,
    body: `${formatAnnotationComment(a)}\n\n${fingerprintMarker(fingerprintAnnotation(a))}`,
  }));

  try {
    const { data } = await octokit.pulls.createReview({
      owner,
      repo,
      pull_number: pullNumber,
      commit_id: commitSha,
      event,
      body,
      comments,
    });
    logger.info({ pullNumber, event, commentCount: comments.length }, 'Incremental review created');
    return { reviewId: data.id, posted: placeable, demoted };
  } catch (err) {
    // Pre-validation should prevent this; if GitHub still rejects the inline
    // comments, fall back to a body-only review so the run is not lost.
    logger.warn({ err, pullNumber }, 'Inline comments rejected — posting body-only review');
    const { data } = await octokit.pulls.createReview({
      owner,
      repo,
      pull_number: pullNumber,
      commit_id: commitSha,
      event,
      body: `${body}\n\n> _Note: inline comments could not be placed on the diff — see the check-run annotations._`,
    });
    return { reviewId: data.id, posted: [], demoted: [...demoted, ...placeable] };
  }
}

/**
 * Dismiss the live blocking review (REQUEST_CHANGES). Failures degrade to a
 * log line — a stale blocking review is annoying, not fatal.
 */
export async function dismissBlockingReview(
  octokit: Octokit,
  params: { owner: string; repo: string; pullNumber: number; reviewId: number; message: string },
): Promise<boolean> {
  try {
    await octokit.pulls.dismissReview({
      owner: params.owner,
      repo: params.repo,
      pull_number: params.pullNumber,
      review_id: params.reviewId,
      message: params.message,
    });
    logger.info({ reviewId: params.reviewId }, 'Blocking review dismissed');
    return true;
  } catch (err) {
    logger.warn({ err, reviewId: params.reviewId }, 'Could not dismiss blocking review — skipping');
    return false;
  }
}

/**
 * Legacy posting mode (`review.comments.mode: 'legacy'`): one full review per
 * run, stacked on top of previous runs. Kept as an opt-out from sticky mode.
 */
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

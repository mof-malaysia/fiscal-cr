import type { FiscalcrOctokit } from './client.js';
import type { ChangedFile, ReviewAnnotation, ReviewResult, Severity } from '../types/review.js';
import { commentableLines } from '../review/diff-analyzer.js';
import { fingerprintAnnotation, fingerprintMarker } from './fingerprint.js';
import { renderVisualSection } from '../review/visual-renderer.js';
import { renderTelemetrySummary } from '../review/telemetry-summary.js';
import { logger } from '../utils/logger.js';

const SEVERITY_EMOJI: Record<Severity, string> = {
  critical: '🔴',
  warning: '🟡',
  suggestion: '🔵',
  nitpick: '⚪',
};
/** Conservative budget for the serialized legacy review body, matching the sticky cap. */
const LEGACY_REVIEW_MAX_BYTES = 60_000;
const LEGACY_FALLBACK_NOTE = '> _Note: Some inline comments could not be placed on the diff._';

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

type ReviewComment = {
  path: string;
  line: number;
  side: 'RIGHT';
  body: string;
};

type ReviewRequest = {
  owner: string;
  repo: string;
  pull_number: number;
  commit_id: string;
  event: 'COMMENT' | 'REQUEST_CHANGES';
  body: string;
  comments?: ReviewComment[];
};

function statusOf(error: unknown): number | undefined {
  if (typeof error !== 'object' || error === null || !('status' in error)) return undefined;
  const status = error.status;
  return typeof status === 'number' ? status : undefined;
}

async function postReview(
  octokit: FiscalcrOctokit,
  request: ReviewRequest,
  fallbackNote: string,
): Promise<{ reviewId: number; bodyOnly: boolean }> {
  try {
    const { data } = await octokit.pulls.createReview(request);
    return { reviewId: data.id, bodyOnly: false };
  } catch (err) {
    if (statusOf(err) !== 422) throw err;

    logger.warn({ err, pullNumber: request.pull_number }, 'Inline comments rejected — posting body-only review');
    const { comments: _comments, ...bodyOnlyRequest } = request;
    const { data } = await octokit.pulls.createReview({
      ...bodyOnlyRequest,
      body: `${request.body}\n\n${fallbackNote}`,
    });
    return { reviewId: data.id, bodyOnly: true };
  }
}

/**
 * Post one small review containing only this run's new findings. Zero
 * placeable findings and a non-blocking event → nothing is posted at all.
 * A 422 on the inline comments retries once body-only (last resort).
 */
export async function createIncrementalReview(
  octokit: FiscalcrOctokit,
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

  const review = await postReview(octokit, {
    owner,
    repo,
    pull_number: pullNumber,
    commit_id: commitSha,
    event,
    body,
    comments,
  }, '> _Note: inline comments could not be placed on the diff — see the check-run annotations._');
  logger.info({ pullNumber, event, commentCount: review.bodyOnly ? 0 : comments.length }, 'Incremental review created');
  return {
    reviewId: review.reviewId,
    posted: review.bodyOnly ? [] : placeable,
    demoted: review.bodyOnly ? [...demoted, ...placeable] : demoted,
  };
}

/**
 * Dismiss the live blocking review (REQUEST_CHANGES). Failures degrade to a
 * log line — a stale blocking review is annoying, not fatal.
 */
export async function dismissBlockingReview(
  octokit: FiscalcrOctokit,
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
  octokit: FiscalcrOctokit,
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

  const review = await postReview(octokit, {
    owner,
    repo,
    pull_number: pullNumber,
    commit_id: commitSha,
    event,
    body,
    comments,
  }, LEGACY_FALLBACK_NOTE);
  logger.info(
    { pullNumber, event, commentCount: review.bodyOnly ? 0 : comments.length },
    'PR review created',
  );
}

function buildReviewBody(result: ReviewResult): string {

  const head: string[] = ['## 🤖 FiscalCR Code Review\n', result.summary, ''];

  const walkthrough: string[] = [];
  if (result.walkthrough && result.walkthrough.length > 0) {
    walkthrough.push(
      '<details>',
      '<summary>📝 Walkthrough</summary>\n',
      '| File | Change Summary |',
      '|------|----------------|',
    );
    for (const entry of result.walkthrough) {
      walkthrough.push(`| \`${entry.path}\` | ${entry.summary.replace(/\|/g, '\\|')} |`);
    }
    walkthrough.push('</details>\n');
  }

  const tail: string[] = [];
  tail.push('| Severity | Count |', '|----------|-------|');
  for (const [severity, count] of Object.entries(result.stats)) {
    if (count > 0) tail.push(`| ${SEVERITY_EMOJI[severity as Severity]} ${severity} | ${count} |`);
  }
  tail.push('', `**Score:** ${result.score}/100`, '');
  tail.push(...renderTelemetrySummary(result));
  tail.push('---', '*Powered by [FiscalCR](https://github.com/mof-malaysia/fiscal-cr) — model-agnostic AI code review*');

  // Baseline preserves all findings and metadata when no visualization is present.
  const baseline = [...head, ...walkthrough, ...tail].join('\n');
  const visual = result.visualize;
  if (!visual) return baseline;

  let section: string;
  try {
    section = renderVisualSection(visual, 'mermaid');
  } catch {
    return baseline;
  }

  // The map is the high-level explanation, before per-file walkthrough detail.
  const fallbackSuffix = `\n\n${LEGACY_FALLBACK_NOTE}`;
  const candidate = [...head, section, ...walkthrough, ...tail].join('\n');
  if (
    Buffer.byteLength(candidate, 'utf8') + Buffer.byteLength(fallbackSuffix, 'utf8') >
    LEGACY_REVIEW_MAX_BYTES
  ) {
    return baseline;
  }
  return candidate;
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

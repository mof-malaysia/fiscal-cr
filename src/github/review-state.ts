import type { Octokit } from '@octokit/rest';
import type { ReviewResult, Severity, WalkthroughEntry } from '../types/review.js';
import { logger } from '../utils/logger.js';

const STATE_MARKER_PREFIX = '<!-- fiscalcr:state:v1 ';
const STATE_MARKER_SUFFIX = ' -->';
const STATE_MARKER_RE = /<!-- fiscalcr:state:v1 (\{.*?\}) -->/s;

const MAX_FINGERPRINTS = 300;
const MAX_RUN_HISTORY = 20;

export interface RunRecord {
  sha: string;
  at: string;
  scope: 'full' | 'delta';
  newFindings: number;
  cost: string;
}

export interface ReviewState {
  v: 1;
  lastReviewedSha: string;
  baseSha: string;
  /** Review id of the live REQUEST_CHANGES review, if any. */
  blockingReviewId: number | null;
  /** Fingerprints of every inline finding ever posted (FIFO-capped). */
  postedFingerprints: string[];
  /** Cumulative open finding counts across the whole PR. */
  openCounts: Record<Severity, number>;
  runs: RunRecord[];
}

export const EMPTY_COUNTS: Record<Severity, number> = {
  critical: 0,
  warning: 0,
  suggestion: 0,
  nitpick: 0,
};

/** Parse the hidden state marker out of a comment body. Corrupt/unknown → null. */
export function parseStateMarker(body: string): ReviewState | null {
  const match = body.match(STATE_MARKER_RE);
  if (!match) return null;
  try {
    const parsed = JSON.parse(match[1]) as ReviewState;
    if (
      parsed.v !== 1 ||
      typeof parsed.lastReviewedSha !== 'string' ||
      typeof parsed.baseSha !== 'string' ||
      !Array.isArray(parsed.postedFingerprints) ||
      typeof parsed.openCounts !== 'object' ||
      parsed.openCounts === null
    ) {
      return null;
    }
    return {
      v: 1,
      lastReviewedSha: parsed.lastReviewedSha,
      baseSha: parsed.baseSha,
      blockingReviewId: typeof parsed.blockingReviewId === 'number' ? parsed.blockingReviewId : null,
      postedFingerprints: parsed.postedFingerprints.filter((f) => typeof f === 'string'),
      openCounts: { ...EMPTY_COUNTS, ...parsed.openCounts },
      runs: Array.isArray(parsed.runs) ? parsed.runs : [],
    };
  } catch {
    return null;
  }
}

export function renderStateMarker(state: ReviewState): string {
  return `${STATE_MARKER_PREFIX}${JSON.stringify(state)}${STATE_MARKER_SUFFIX}`;
}

/** FIFO-append keeping the newest entries under the cap. */
export function appendFingerprints(existing: string[], added: string[]): string[] {
  const merged = [...existing];
  for (const fp of added) {
    if (!merged.includes(fp)) merged.push(fp);
  }
  return merged.slice(-MAX_FINGERPRINTS);
}

export function appendRun(runs: RunRecord[], run: RunRecord): RunRecord[] {
  return [...runs, run].slice(-MAX_RUN_HISTORY);
}

export interface StickyComment {
  commentId: number;
  state: ReviewState | null;
}

/**
 * Find the sticky FiscalCR comment on a PR by its hidden marker (never by
 * author — works for both github-actions[bot] and App bot users).
 */
export async function loadReviewState(
  octokit: Octokit,
  params: { owner: string; repo: string; pullNumber: number },
): Promise<StickyComment | null> {
  const { owner, repo, pullNumber } = params;
  let page = 1;
  while (true) {
    const { data } = await octokit.issues.listComments({
      owner,
      repo,
      issue_number: pullNumber,
      per_page: 100,
      page,
    });
    for (const comment of data) {
      if (comment.body?.includes(STATE_MARKER_PREFIX)) {
        return { commentId: comment.id, state: parseStateMarker(comment.body) };
      }
    }
    if (data.length < 100) return null;
    page++;
  }
}

/**
 * Create or update the sticky comment. Re-checks for a concurrently created
 * sticky comment before creating a new one.
 */
export async function saveStickyComment(
  octokit: Octokit,
  params: {
    owner: string;
    repo: string;
    pullNumber: number;
    commentId: number | null;
    body: string;
  },
): Promise<number> {
  const { owner, repo, pullNumber, body } = params;
  let commentId = params.commentId;

  if (commentId === null) {
    // A concurrent run may have created the sticky comment since we loaded state.
    const existing = await loadReviewState(octokit, { owner, repo, pullNumber });
    commentId = existing?.commentId ?? null;
  }

  if (commentId !== null) {
    try {
      await octokit.issues.updateComment({ owner, repo, comment_id: commentId, body });
      return commentId;
    } catch (err) {
      logger.warn({ err, commentId }, 'Sticky comment update failed (deleted?) — creating a new one');
    }
  }

  const { data } = await octokit.issues.createComment({
    owner,
    repo,
    issue_number: pullNumber,
    body,
  });
  return data.id;
}

const SEVERITY_EMOJI: Record<Severity, string> = {
  critical: '🔴',
  warning: '🟡',
  suggestion: '🔵',
  nitpick: '⚪',
};

export interface StickyCommentInput {
  result: ReviewResult;
  state: ReviewState;
  /** Findings that could not be placed inline (out of diff / over the cap). */
  demoted: Array<{ path: string; startLine: number; severity: Severity; title: string }>;
  walkthrough?: WalkthroughEntry[];
}

/** Render the full sticky comment body, hidden state marker included. */
export function renderStickyComment(input: StickyCommentInput): string {
  const { result, state, demoted } = input;
  const walkthrough = input.walkthrough ?? result.walkthrough;
  const lines: string[] = [];

  lines.push('## 🤖 FiscalCR Code Review\n');
  if (result.intent) lines.push(`> ${result.intent}\n`);
  lines.push(result.summary);
  lines.push('');
  lines.push(`**Score:** ${result.score}/100 · last reviewed \`${state.lastReviewedSha.slice(0, 7)}\``);
  lines.push('');

  if (walkthrough && walkthrough.length > 0) {
    lines.push('<details>');
    lines.push('<summary>📝 Walkthrough</summary>\n');
    lines.push('| File | Change Summary |');
    lines.push('|------|----------------|');
    for (const entry of walkthrough) {
      lines.push(`| \`${entry.path}\` | ${entry.summary.replace(/\|/g, '\\|')} |`);
    }
    lines.push('</details>\n');
  }

  const openTotal = Object.values(state.openCounts).reduce((a, b) => a + b, 0);
  lines.push(`### Open findings: ${openTotal}`);
  if (openTotal > 0) {
    lines.push('| Severity | Open |');
    lines.push('|----------|------|');
    for (const [severity, count] of Object.entries(state.openCounts)) {
      if (count > 0) {
        lines.push(`| ${SEVERITY_EMOJI[severity as Severity]} ${severity} | ${count} |`);
      }
    }
  }
  lines.push('');

  if (demoted.length > 0) {
    lines.push('<details>');
    lines.push(`<summary>⚠️ ${demoted.length} finding(s) could not be placed inline</summary>\n`);
    for (const d of demoted) {
      lines.push(`- ${SEVERITY_EMOJI[d.severity]} \`${d.path}:${d.startLine}\` — ${d.title}`);
    }
    lines.push('\nSee the check-run annotations for details.');
    lines.push('</details>\n');
  }

  if (state.runs.length > 0) {
    lines.push('<details>');
    lines.push('<summary>🕘 Run history</summary>\n');
    lines.push('| Commit | When | Scope | New findings | Cost |');
    lines.push('|--------|------|-------|--------------|------|');
    for (const run of [...state.runs].reverse()) {
      lines.push(`| \`${run.sha}\` | ${run.at} | ${run.scope} | ${run.newFindings} | $${run.cost} |`);
    }
    lines.push('</details>\n');
  }

  lines.push('---');
  lines.push('*Powered by [FiscalCR](https://github.com/mof-malaysia/fiscal-cr) — model-agnostic AI code review*');
  lines.push('');
  lines.push(renderStateMarker(input.state));

  return lines.join('\n');
}

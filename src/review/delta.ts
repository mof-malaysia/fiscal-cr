import type { Octokit } from '@octokit/rest';
import type { ReviewConfig } from '../config/schema.js';
import type { ChangedFile } from '../types/review.js';
import type { ReviewState } from '../github/review-state.js';
import { filterFiles } from './file-filter.js';
import { logger } from '../utils/logger.js';

export interface ScopeDecision {
  mode: 'full' | 'delta' | 'skip';
  /** Delta only: paths changed since the last reviewed commit. */
  paths?: string[];
  /** Delta only: the commit the delta is measured from. */
  sinceSha?: string;
  reason: string;
}

/** GitHub's compare API silently caps the file list at 300. */
const COMPARE_FILE_CAP = 300;

/**
 * Decide whether this run reviews the whole PR, only what changed since the
 * last reviewed commit, or nothing at all. Every uncertain case falls back to
 * a full review — a wasted full review is cheap, a missed finding is not.
 */
export async function decideScope(
  octokit: Octokit,
  params: {
    owner: string;
    repo: string;
    headSha: string;
    baseSha: string;
    state: ReviewState | null;
    forceFull?: boolean;
    config: ReviewConfig;
  },
): Promise<ScopeDecision> {
  const { owner, repo, headSha, baseSha, state, forceFull, config } = params;

  if (!config.review.incremental.enabled) return { mode: 'full', reason: 'incremental reviews disabled' };
  if (forceFull) return { mode: 'full', reason: 'full review forced' };
  if (!state) return { mode: 'full', reason: 'no previous review state' };
  if (state.lastReviewedSha === headSha) {
    return { mode: 'skip', reason: `head ${headSha.slice(0, 7)} already reviewed` };
  }
  if (state.baseSha !== baseSha) {
    return { mode: 'full', reason: 'PR base changed since last review' };
  }

  let compare;
  try {
    ({ data: compare } = await octokit.repos.compareCommitsWithBasehead({
      owner,
      repo,
      basehead: `${state.lastReviewedSha}...${headSha}`,
    }));
  } catch (err) {
    // 404/422: the previously reviewed commit no longer exists (force-push).
    logger.warn({ err, since: state.lastReviewedSha }, 'Commit compare failed — full review');
    return { mode: 'full', reason: 'last reviewed commit unreachable (force-push?)' };
  }

  if (compare.status === 'diverged' || compare.status === 'behind') {
    return { mode: 'full', reason: `history ${compare.status} since last review (force-push?)` };
  }
  if (compare.status === 'identical') {
    return { mode: 'skip', reason: 'no changes since last review' };
  }

  const compareFiles = compare.files ?? [];
  if (compareFiles.length >= COMPARE_FILE_CAP) {
    return { mode: 'full', reason: 'delta hit the compare API file cap' };
  }
  if (compareFiles.length > config.review.incremental.maxDeltaFiles) {
    return { mode: 'full', reason: `delta touches ${compareFiles.length} files (> maxDeltaFiles)` };
  }

  const changed: ChangedFile[] = compareFiles.map((f) => ({
    filename: f.filename,
    status: f.status as ChangedFile['status'],
    additions: f.additions,
    deletions: f.deletions,
    patch: f.patch,
  }));
  const relevant = filterFiles(changed, config);
  if (relevant.length === 0) {
    return { mode: 'skip', reason: 'no reviewable files changed since last review' };
  }

  return {
    mode: 'delta',
    paths: relevant.map((f) => f.filename),
    sinceSha: state.lastReviewedSha,
    reason: `${relevant.length} file(s) changed since ${state.lastReviewedSha.slice(0, 7)}`,
  };
}

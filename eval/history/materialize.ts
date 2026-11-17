import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { Octokit } from '@octokit/rest';
import { DEFAULT_CONFIG } from '../../src/config/defaults.js';
import { ApiFileSource } from '../../src/review/file-source.js';
import { filterFiles } from '../../src/review/file-filter.js';
import type { ChangedFile, PullRequestContext } from '../../src/types/review.js';
import { estimateContextTokens } from '../cases.js';
import { CACHE_FORMAT, HISTORY_CACHE_DIR, cachePath, type CachedContext } from './loader.js';
import { ownerAndName, type HistoryCase } from './manifest.js';

/**
 * Fetch step for the history suite (network; never run by tests or the dry
 * run). `fetchHistoryCase` rebuilds a case's `PullRequestContext` from the
 * pinned SHAs: compare base...head for the patches, full file contents at the
 * head SHA, and the PR title and body. Read-only GitHub API calls only.
 */

/**
 * GitHub token for read-only API calls: GITHUB_TOKEN, then GH_TOKEN, then
 * `gh auth token`. Never printed or written anywhere.
 */
export function resolveGithubToken(env: NodeJS.ProcessEnv = process.env): string | undefined {
  const fromEnv = env.GITHUB_TOKEN?.trim() || env.GH_TOKEN?.trim();
  if (fromEnv) return fromEnv;
  try {
    return execFileSync('gh', ['auth', 'token'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim() || undefined;
  } catch {
    return undefined;
  }
}

export function createOctokit(): Octokit {
  return new Octokit({ auth: resolveGithubToken(), userAgent: 'fiscalcr-eval-history' });
}

/** Builds the diff text from the per-file patches, `git diff` style. */
function diffOf(files: ChangedFile[]): string {
  return files
    .filter((f) => f.patch)
    .map((f) => `diff --git a/${f.filename} b/${f.filename}\n--- a/${f.filename}\n+++ b/${f.filename}\n${f.patch}\n`)
    .join('');
}

/** The manifest fields the fetch needs (a draft has no label yet). */
export type FetchTarget = Pick<HistoryCase, 'id' | 'repo' | 'pr' | 'baseSha' | 'headSha' | 'mergeSha'>;

export async function fetchHistoryCase(octokit: Octokit, c: FetchTarget): Promise<CachedContext> {
  const { owner, name } = ownerAndName(c.repo);
  const [{ data: pr }, { data: cmp }] = await Promise.all([
    octokit.pulls.get({ owner, repo: name, pull_number: c.pr }),
    octokit.repos.compareCommitsWithBasehead({
      owner,
      repo: name,
      basehead: `${c.baseSha}...${c.headSha}`,
      per_page: 100,
    }),
  ]);
  if (pr.merge_commit_sha !== c.mergeSha) {
    throw new Error(`${c.id}: merge SHA on GitHub (${pr.merge_commit_sha}) differs from the manifest`);
  }

  const all: ChangedFile[] = (cmp.files ?? []).map((f) => ({
    filename: f.filename,
    status: f.status as ChangedFile['status'],
    additions: f.additions,
    deletions: f.deletions,
    patch: f.patch,
  }));
  // Mirror the orchestrator: default include/exclude filters, contents only
  // for reviewable files with a patch, capped at files.maxFileSize.
  const changedFiles = filterFiles(all, DEFAULT_CONFIG);
  const source = new ApiFileSource(octokit, owner, name, c.headSha);
  const contents = await source.getContents(
    changedFiles.map((f) => f.filename),
    DEFAULT_CONFIG.files.maxFileSize,
  );

  const context: CachedContext['context'] = {
    owner,
    repo: name,
    pullNumber: c.pr,
    baseSha: c.baseSha,
    headSha: c.headSha,
    title: pr.title,
    body: pr.body ?? '',
    diff: diffOf(changedFiles),
    changedFiles,
    fileContents: Object.fromEntries(contents),
  };
  return { cacheFormat: CACHE_FORMAT, id: c.id, baseSha: c.baseSha, headSha: c.headSha, context };
}

export function writeCached(cached: CachedContext, dir: string = HISTORY_CACHE_DIR): void {
  mkdirSync(dir, { recursive: true });
  writeFileSync(cachePath(cached.id, dir), `${JSON.stringify(cached)}\n`, 'utf8');
}

/** Size facts recorded in the manifest, measured from a materialised context. */
export function measure(context: PullRequestContext): {
  files: number;
  additions: number;
  deletions: number;
  estimatedTokens: number;
} {
  return {
    files: context.changedFiles.length,
    additions: context.changedFiles.reduce((s, f) => s + f.additions, 0),
    deletions: context.changedFiles.reduce((s, f) => s + f.deletions, 0),
    estimatedTokens: estimateContextTokens(context),
  };
}

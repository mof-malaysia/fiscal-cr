import type { Octokit } from '@octokit/rest';
import type { PullRequestContext, ChangedFile } from '../types/review.js';
import type { ReviewConfig } from '../config/schema.js';
import { ApiFileSource, type FileContentSource } from '../review/file-source.js';
import { logger } from '../utils/logger.js';

export interface ExtractOptions {
  /** Where to load file contents from. Defaults to the GitHub contents API. */
  fileSource?: FileContentSource;
  /** When set, restrict the context to these paths (delta reviews). */
  pathFilter?: string[];
}

export async function extractPullRequestContext(
  octokit: Octokit,
  owner: string,
  repo: string,
  pullNumber: number,
  config: ReviewConfig,
  options: ExtractOptions = {},
): Promise<PullRequestContext> {
  // Fetch PR metadata
  const { data: pr } = await octokit.pulls.get({ owner, repo, pull_number: pullNumber });

  // Fetch changed files list
  let files: ChangedFile[] = [];
  let page = 1;
  while (true) {
    const { data } = await octokit.pulls.listFiles({
      owner,
      repo,
      pull_number: pullNumber,
      per_page: 100,
      page,
    });
    if (data.length === 0) break;
    for (const f of data) {
      files.push({
        filename: f.filename,
        status: f.status as ChangedFile['status'],
        additions: f.additions,
        deletions: f.deletions,
        patch: f.patch,
      });
    }
    if (data.length < 100) break;
    page++;
  }

  if (options.pathFilter) {
    const allowed = new Set(options.pathFilter);
    files = files.filter((f) => allowed.has(f.filename));
  }

  // Fetch the unified diff
  const { data: diff } = await octokit.pulls.get({
    owner,
    repo,
    pull_number: pullNumber,
    mediaType: { format: 'diff' },
  }) as unknown as { data: string };

  // Fetch full file contents (head version) via the configured source —
  // local checkout in Action mode, parallel API calls otherwise.
  const source =
    options.fileSource ?? new ApiFileSource(octokit, owner, repo, pr.head.sha);
  const contentPaths = files
    .filter((f) => f.status !== 'removed')
    .map((f) => f.filename);
  const fileContents = await source.getContents(contentPaths, config.files.maxFileSize);

  logger.info(
    {
      filesCount: files.length,
      fileContentsCount: fileContents.size,
      diffLength: (diff as string).length,
      localSource: source.isLocal,
    },
    'PR context extracted',
  );

  return {
    owner,
    repo,
    pullNumber,
    baseSha: pr.base.sha,
    headSha: pr.head.sha,
    title: pr.title,
    body: pr.body ?? '',
    diff: diff as string,
    changedFiles: files,
    fileContents,
  };
}

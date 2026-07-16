import { readFile } from 'node:fs/promises';
import { isAbsolute, join, normalize, sep } from 'node:path';
import type { Octokit } from '@octokit/rest';
import { pLimit } from '../utils/concurrency.js';
import { logger } from '../utils/logger.js';

/**
 * Abstracts where changed-file contents come from:
 * - Action mode: the repo is already on disk (actions/checkout) — read locally.
 * - App mode: fetch via the GitHub contents API with bounded concurrency.
 */
export interface FileContentSource {
  /** True when contents come from a local checkout (enables related-file context). */
  readonly isLocal: boolean;
  /**
   * Fetch contents for the given repo-relative paths. Files that are missing,
   * binary, or larger than maxFileSize are omitted from the result.
   */
  getContents(paths: string[], maxFileSize: number): Promise<Map<string, string>>;
}

const API_FETCH_CONCURRENCY = 8;

export class ApiFileSource implements FileContentSource {
  readonly isLocal = false;

  constructor(
    private readonly octokit: Octokit,
    private readonly owner: string,
    private readonly repo: string,
    private readonly ref: string,
  ) {}

  async getContents(paths: string[], maxFileSize: number): Promise<Map<string, string>> {
    const contents = new Map<string, string>();
    const limit = pLimit(API_FETCH_CONCURRENCY);

    await Promise.all(
      paths.map((path) =>
        limit(async () => {
          try {
            const { data } = await this.octokit.repos.getContent({
              owner: this.owner,
              repo: this.repo,
              path,
              ref: this.ref,
            });
            if ('content' in data && data.encoding === 'base64') {
              const content = Buffer.from(data.content, 'base64').toString('utf-8');
              if (content.length <= maxFileSize && !content.includes('\u0000')) {
                contents.set(path, content);
              }
            }
          } catch (err) {
            logger.debug({ file: path, err }, 'Could not fetch file content');
          }
        }),
      ),
    );

    return contents;
  }
}

/**
 * Reads from the local checkout. Note: actions/checkout checks out the PR
 * *merge* commit by default, not the head SHA — close enough for review
 * context. Paths that fail to read locally fall back to the API source.
 */
export class LocalFileSource implements FileContentSource {
  readonly isLocal = true;

  constructor(
    private readonly workspaceRoot: string,
    private readonly fallback?: FileContentSource,
  ) {}

  async getContents(paths: string[], maxFileSize: number): Promise<Map<string, string>> {
    const contents = new Map<string, string>();
    const missing: string[] = [];

    await Promise.all(
      paths.map(async (path) => {
        const resolved = this.resolveSafe(path);
        if (!resolved) return;
        try {
          const content = await readFile(resolved, 'utf-8');
          if (content.length <= maxFileSize && !content.includes('\u0000')) {
            contents.set(path, content);
          }
        } catch {
          missing.push(path);
        }
      }),
    );

    if (missing.length > 0 && this.fallback) {
      logger.debug({ count: missing.length }, 'Falling back to API for unreadable files');
      const fromApi = await this.fallback.getContents(missing, maxFileSize);
      for (const [path, content] of fromApi) contents.set(path, content);
    }

    return contents;
  }

  /** Reject absolute paths and traversal outside the workspace. */
  private resolveSafe(path: string): string | null {
    if (isAbsolute(path)) return null;
    const resolved = normalize(join(this.workspaceRoot, path));
    if (!resolved.startsWith(normalize(this.workspaceRoot) + sep)) return null;
    return resolved;
  }
}

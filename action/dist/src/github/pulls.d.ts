import type { Octokit } from '@octokit/rest';
import type { PullRequestContext } from '../types/review.js';
import type { ReviewConfig } from '../config/schema.js';
import { type FileContentSource } from '../review/file-source.js';
export interface ExtractOptions {
    /** Where to load file contents from. Defaults to the GitHub contents API. */
    fileSource?: FileContentSource;
    /** When set, restrict the context to these paths (delta reviews). */
    pathFilter?: string[];
}
export declare function extractPullRequestContext(octokit: Octokit, owner: string, repo: string, pullNumber: number, config: ReviewConfig, options?: ExtractOptions): Promise<PullRequestContext>;
//# sourceMappingURL=pulls.d.ts.map
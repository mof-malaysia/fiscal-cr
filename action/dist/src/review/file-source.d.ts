import type { Octokit } from '@octokit/rest';
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
export declare class ApiFileSource implements FileContentSource {
    private readonly octokit;
    private readonly owner;
    private readonly repo;
    private readonly ref;
    readonly isLocal = false;
    constructor(octokit: Octokit, owner: string, repo: string, ref: string);
    getContents(paths: string[], maxFileSize: number): Promise<Map<string, string>>;
}
/**
 * Reads from the local checkout. Note: actions/checkout checks out the PR
 * *merge* commit by default, not the head SHA — close enough for review
 * context. Paths that fail to read locally fall back to the API source.
 */
export declare class LocalFileSource implements FileContentSource {
    private readonly workspaceRoot;
    private readonly fallback?;
    readonly isLocal = true;
    constructor(workspaceRoot: string, fallback?: FileContentSource | undefined);
    getContents(paths: string[], maxFileSize: number): Promise<Map<string, string>>;
    /** Reject absolute paths and traversal outside the workspace. */
    private resolveSafe;
}
//# sourceMappingURL=file-source.d.ts.map
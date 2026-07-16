export type Severity = 'critical' | 'warning' | 'suggestion' | 'nitpick';
export type AnnotationCategory = 'bug' | 'security' | 'performance' | 'style' | 'best-practice' | 'documentation' | 'testing' | 'other';
export interface ReviewAnnotation {
    path: string;
    startLine: number;
    endLine: number;
    severity: Severity;
    category: AnnotationCategory;
    title: string;
    body: string;
    suggestedFix?: string;
    /** Model self-assessed confidence 0–1. Defaults to 0.7 when a model omits it. */
    confidence?: number;
}
export interface WalkthroughEntry {
    path: string;
    summary: string;
}
export interface ReviewResult {
    summary: string;
    score: number;
    annotations: ReviewAnnotation[];
    stats: Record<Severity, number>;
    tokensUsed: {
        input: number;
        output: number;
        cached: number;
    };
    /** One-line-per-file walkthrough table (multi-pass pipeline output). */
    walkthrough?: WalkthroughEntry[];
    /** Short description of what the PR is trying to do. */
    intent?: string;
    /** Number of LLM calls made to produce this review. */
    callCount?: number;
}
export interface ChangedFile {
    filename: string;
    status: 'added' | 'modified' | 'removed' | 'renamed' | 'copied' | 'changed' | 'unchanged';
    additions: number;
    deletions: number;
    patch?: string;
}
export interface PullRequestContext {
    owner: string;
    repo: string;
    pullNumber: number;
    baseSha: string;
    headSha: string;
    title: string;
    body: string;
    diff: string;
    changedFiles: ChangedFile[];
    fileContents: Map<string, string>;
}
export interface ChatMessage {
    role: 'system' | 'user' | 'assistant';
    content: string;
}
//# sourceMappingURL=review.d.ts.map
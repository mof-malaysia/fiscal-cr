import type { DiagramArtifact } from './diagram.js';

export type Severity = 'critical' | 'warning' | 'suggestion' | 'nitpick';

export type AnnotationCategory =
  | 'bug'
  | 'security'
  | 'performance'
  | 'style'
  | 'best-practice'
  | 'documentation'
  | 'testing'
  | 'other';

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

export interface ReviewedRange {
  path: string;
  /** New-file coordinates covered by the successful review. */
  startLine: number;
  endLine: number;
  /** Old-file coordinates for deletion-only hunks. */
  originalStartLine?: number;
  originalEndLine?: number;
}

export interface WalkthroughEntry {
  path: string;
  summary: string;
}
export interface ReviewResult {
  summary: string;
  score: number; // 0-100
  /** Complete, validated findings inventory used for lifecycle reconciliation. */
  findings: ReviewAnnotation[];
  /** Findings eligible for publication after annotation caps. */
  annotations: ReviewAnnotation[];

  /** Cleanup status is separate from finding correctness when thread permissions are limited. */
  threadCleanup?: {
    attempted: number;
    resolved: number;
    failed: number;
    unavailable?: boolean;
  };
  /** Paths whose detector execution completed successfully for this result. */
  reviewedPaths: string[];
  /** Line ranges covered by successful detector execution, when available. */
  reviewedRanges?: ReviewedRange[];
  stats: Record<Severity, number>;
  tokensUsed: {
    input: number;
    output: number;
    cached: number;
  };
  /** Provider/model-aware estimated cost when pricing metadata is available. */
  costEstimate?: {
    usd: number;
    source: 'exact' | 'family' | 'remote' | 'fallback';
    provider?: string;
    model?: string;
    matchedModel?: string;
  };
  /** One-line-per-file walkthrough table (multi-pass pipeline output). */
  walkthrough?: WalkthroughEntry[];
  /** Optional change diagram generated from bounded patch evidence. */
  diagram?: DiagramArtifact;
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

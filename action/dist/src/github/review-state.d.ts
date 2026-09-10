import type { FiscalcrOctokit } from './client.js';
import type { ReviewAnnotation, ReviewResult, ReviewedRange, Severity, WalkthroughEntry } from '../types/review.js';
/** Conservative budget for the serialized hidden marker, below GitHub's limit. */
export declare const MAX_STATE_MARKER_BYTES = 24000;
/** Conservative budget for the complete sticky comment body. */
export declare const MAX_STICKY_COMMENT_BYTES = 60000;
/** Code-owned boundaries wrapping the optional generated diagram block. */
export declare const DIAGRAM_SECTION_START = "<!-- fiscalcr:diagram:start -->";
export declare const DIAGRAM_SECTION_END = "<!-- fiscalcr:diagram:end -->";
export type FindingStatus = 'open' | 'fixed' | 'dismissed';
export type FindingTransitionSource = 'review' | 'manual' | 'automatic';
export interface FindingTransition {
    status: FindingStatus;
    at: string;
    source: FindingTransitionSource;
    event?: string;
}
export interface FindingRecord {
    fingerprint: string;
    status: FindingStatus;
    severity: Severity;
    path: string;
    startLine: number;
    endLine: number;
    title: string;
    /** Null means no current FiscalCR thread backs this finding (demoted/threadless). */
    threadId: string | null;
    lastSeenSha: string;
    transitions: FindingTransition[];
}
export interface RunRecord {
    sha: string;
    at: string;
    scope: 'full' | 'delta';
    newFindings: number;
    cost: string;
}
export interface ReviewState {
    v: 2;
    lastReviewedSha: string;
    baseSha: string;
    /** Review id of the live REQUEST_CHANGES review, if any. */
    blockingReviewId: number | null;
    /** Current lifecycle inventory; terminal records are bounded and evictable. */
    findings: FindingRecord[];
    /** Delivery/event identities recently handled for idempotent webhook retries. */
    recentEvents: string[];
    /** Thread ids auto-resolved by FiscalCR; bounded defense against event races. */
    autoResolvedThreads: string[];
    /** App-owned check identity for the last completed review. */
    checkRunId: number | null;
    checkRunHeadSha: string | null;
    /** v1 migration is intentionally lossy: no old status history is inferred. */
    migratedFromV1?: boolean;
    /** Existing bounded run history, retained as display metadata. */
    runs: RunRecord[];
}
export interface LegacyReviewState {
    v: 1;
    lastReviewedSha: string;
    baseSha: string;
    blockingReviewId: number | null;
    postedFingerprints: string[];
    openCounts: Record<Severity, number>;
    runs: RunRecord[];
}
export declare const EMPTY_COUNTS: Record<Severity, number>;
/** Backward-compatible parser: v1 is returned for callers that inspect old markers. */
export declare function parseStateMarker(body: string): ReviewState | LegacyReviewState | null;
/** Parse the old marker for lazy, explicitly lossy migration. */
export declare function parseLegacyStateMarker(body: string): LegacyReviewState | null;
/** Start v2 with no fabricated fixed/dismissed history; the next run is full. */
export declare function migrateLegacyState(legacy: LegacyReviewState): ReviewState;
/** Serialize the v1 or compacted v2 lifecycle state inside an HTML comment. */
export declare function renderStateMarker(state: ReviewState | LegacyReviewState): string;
export interface FindingReconciliation {
    findings: FindingRecord[];
    newlyOpen: string[];
    fixed: string[];
}
/** Apply review observations only to paths in the successful reviewed-scope manifest. */
export declare function reconcileFindingInventory(state: ReviewState | null, observed: ReviewAnnotation[], reviewedPaths: string[], headSha: string, at: string, reviewedRanges?: ReviewedRange[]): FindingReconciliation;
/**
 * Merge a review result with state written concurrently after the review began.
 * Manual transitions from the newer state win by transition timestamp.
 */
export declare function mergeConcurrentReviewState(base: ReviewState | null, proposed: ReviewState, latest: ReviewState): ReviewState;
/** Append a run record while retaining only the bounded recent history. */
export declare function appendRun(runs: RunRecord[], run: RunRecord): RunRecord[];
/** Serialize all state publication paths for one pull request in-process. */
export declare function withReviewStateLock<T>(key: string, work: () => Promise<T>): Promise<T>;
/** Legacy helper retained for consumers that still inspect v1 FIFO behavior. */
export declare function appendFingerprints(existing: string[], added: string[]): string[];
export interface StickyComment {
    commentId: number;
    state: ReviewState | null;
    legacyState?: LegacyReviewState;
    /** Original body, preserved as a normal enumerable field. */
    body: string;
}
/** Find the app-authored sticky FiscalCR comment by marker. */
export declare function loadReviewState(octokit: FiscalcrOctokit, params: {
    owner: string;
    repo: string;
    pullNumber: number;
}): Promise<StickyComment | null>;
/** Create/update only after the caller has completed all other side effects. */
export declare function saveStickyComment(octokit: FiscalcrOctokit, params: {
    owner: string;
    repo: string;
    pullNumber: number;
    commentId: number | null;
    body: string;
    /** Body observed before composing the update; detects external changes. */
    expectedBody?: string;
}): Promise<number>;
export interface StickyCommentInput {
    result: ReviewResult;
    state: ReviewState | LegacyReviewState;
    demoted: Array<{
        path: string;
        startLine: number;
        severity: Severity;
        title: string;
    }>;
    walkthrough?: WalkthroughEntry[];
}
/**
 * Replace the lifecycle marker, dropping only the optional diagram block when
 * the result would otherwise exceed the sticky budget (e.g. a webhook refresh
 * added reopened finding rows or a retained diagram plus a grown marker pushed
 * past the cap). Findings and state are never trimmed to make room.
 */
export declare function replaceStateMarkerWithinBudget(body: string, state: ReviewState): string;
/** Render the human-readable sticky summary; fixed and dismissed findings stay hidden. */
export declare function renderStickyComment(input: StickyCommentInput): string;
export declare function refreshStickyCommentState(body: string, state: ReviewState): string;
/** Replace an existing v1/v2 marker without disturbing surrounding comment text. */
export declare function replaceStateMarker(body: string, state: ReviewState): string;
/** Apply one matching current-thread resolution as a manual dismissal. */
export declare function applyManualThreadResolution(state: ReviewState, input: {
    fingerprint: string;
    threadId: string;
    eventKey: string;
    at: string;
}): ReviewState;
/** Reopen one matching dismissed finding after a user reopens its thread. */
export declare function applyManualThreadReopening(state: ReviewState, input: {
    fingerprint: string;
    threadId: string;
    eventKey: string;
    at: string;
}): ReviewState;
//# sourceMappingURL=review-state.d.ts.map
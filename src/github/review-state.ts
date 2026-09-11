import type { FiscalcrOctokit } from './client.js';
import type { ReviewAnnotation, ReviewResult, ReviewedRange, Severity, WalkthroughEntry } from '../types/review.js';
import { fingerprintAnnotation } from './fingerprint.js';
import { renderDiagramSection } from '../review/diagram-renderer.js';
import { renderTelemetrySummary } from '../review/telemetry-summary.js';
import { logger } from '../utils/logger.js';

const STATE_MARKER_PREFIX = '<!-- fiscalcr:state:v2 ';
const STATE_MARKER_SUFFIX = ' -->';
const LEGACY_MARKER_PREFIX = '<!-- fiscalcr:state:v1 ';

const MAX_RUN_HISTORY = 20;
const MAX_TRANSITIONS_PER_FINDING = 8;
const MAX_TERMINAL_FINDINGS = 100;
const MAX_VISIBLE_FINDINGS = 100;
const MAX_RECENT_EVENTS = 50;
const MAX_AUTO_RESOLVED_THREADS = 50;
/** Conservative budget for the serialized hidden marker, below GitHub's limit. */
export const MAX_STATE_MARKER_BYTES = 24_000;
/** Conservative budget for the complete sticky comment body. */
export const MAX_STICKY_COMMENT_BYTES = 60_000;
/** Code-owned boundaries wrapping the optional generated diagram block. */
export const DIAGRAM_SECTION_START = '<!-- fiscalcr:diagram:start -->';
export const DIAGRAM_SECTION_END = '<!-- fiscalcr:diagram:end -->';

/** Read an HTTP status code from an unknown Octokit error value. */
function statusOf(error: unknown): number | undefined {
  if (typeof error !== 'object' || error === null || !('status' in error)) return undefined;
  const status = error.status;
  return typeof status === 'number' ? status : undefined;
}

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

export const EMPTY_COUNTS: Record<Severity, number> = {
  critical: 0,
  warning: 0,
  suggestion: 0,
  nitpick: 0,
};

const SEVERITIES: Severity[] = ['critical', 'warning', 'suggestion', 'nitpick'];
const STATUSES: FindingStatus[] = ['open', 'fixed', 'dismissed'];

/** Check whether a value is one of the supported finding severities. */
function isSeverity(value: unknown): value is Severity {
  return typeof value === 'string' && SEVERITIES.includes(value as Severity);
}

/** Check whether a value is one of the persisted finding statuses. */
function isStatus(value: unknown): value is FindingStatus {
  return typeof value === 'string' && STATUSES.includes(value as FindingStatus);
}

/** Narrow an unknown parsed JSON value to a plain record-like object. */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

interface MarkerMatch {
  start: number;
  end: number;
  payload: string;
}

/** Find the first syntactically valid JSON state marker with the given prefix. */
function findJsonMarker(body: string, prefix: string): MarkerMatch | null {
  let start = body.indexOf(prefix);
  while (start >= 0) {
    let suffix = body.indexOf(STATE_MARKER_SUFFIX, start + prefix.length);
    while (suffix >= 0) {
      const payload = body.slice(start + prefix.length, suffix);
      try {
        JSON.parse(payload);
        return { start, end: suffix + STATE_MARKER_SUFFIX.length, payload };
      } catch {
        suffix = body.indexOf(STATE_MARKER_SUFFIX, suffix + STATE_MARKER_SUFFIX.length);
      }
    }
    start = body.indexOf(prefix, start + prefix.length);
  }
  return null;
}

/** Parse a JSON marker payload, returning null when no valid marker exists. */
function parseJsonMarker(body: string, prefix: string): unknown | null {
  const match = findJsonMarker(body, prefix);
  return match ? JSON.parse(match.payload) : null;
}

/** Validate and normalize one persisted run-history entry. */
function parseRun(value: unknown): RunRecord | null {
  if (!isRecord(value)) return null;
  if (
    typeof value.sha !== 'string' ||
    typeof value.at !== 'string' ||
    (value.scope !== 'full' && value.scope !== 'delta') ||
    typeof value.newFindings !== 'number' ||
    typeof value.cost !== 'string'
  ) {
    return null;
  }
  return {
    sha: value.sha,
    at: value.at,
    scope: value.scope,
    newFindings: value.newFindings,
    cost: value.cost,
  };
}

/** Validate and normalize one persisted finding record. */
function parseFinding(value: unknown): FindingRecord | null {
  if (!isRecord(value)) return null;
  if (
    typeof value.fingerprint !== 'string' ||
    !isStatus(value.status) ||
    !isSeverity(value.severity) ||
    typeof value.path !== 'string' ||
    typeof value.startLine !== 'number' ||
    typeof value.endLine !== 'number' ||
    typeof value.title !== 'string' ||
    (value.threadId !== null && typeof value.threadId !== 'string') ||
    typeof value.lastSeenSha !== 'string'
  ) {
    return null;
  }
  const transitions = Array.isArray(value.transitions)
    ? value.transitions.filter((item): item is FindingTransition => {
        if (!isRecord(item) || !isStatus(item.status) || typeof item.at !== 'string') return false;
        return item.source === 'review' || item.source === 'manual' || item.source === 'automatic';
      })
    : [];
  return {
    fingerprint: value.fingerprint,
    status: value.status,
    severity: value.severity,
    path: value.path,
    startLine: value.startLine,
    endLine: value.endLine,
    title: value.title,
    threadId: value.threadId,
    lastSeenSha: value.lastSeenSha,
    transitions: transitions.slice(-MAX_TRANSITIONS_PER_FINDING),
  };
}

/** Parse the v2 hidden state marker. Corrupt, absent, or non-v2 markers return null. */
function parseV2StateMarker(body: string): ReviewState | null {
  const parsed = parseJsonMarker(body, STATE_MARKER_PREFIX);
  if (!isRecord(parsed) || parsed.v !== 2) return null;
  if (
    typeof parsed.lastReviewedSha !== 'string' ||
    typeof parsed.baseSha !== 'string' ||
    (parsed.blockingReviewId !== null && typeof parsed.blockingReviewId !== 'number') ||
    !Array.isArray(parsed.findings) ||
    !Array.isArray(parsed.recentEvents) ||
    !Array.isArray(parsed.autoResolvedThreads) ||
    (parsed.checkRunId !== null && typeof parsed.checkRunId !== 'number') ||
    (parsed.checkRunHeadSha !== null && typeof parsed.checkRunHeadSha !== 'string') ||
    !Array.isArray(parsed.runs)
  ) {
    return null;
  }
  const findings = parsed.findings.map(parseFinding);
  const runs = parsed.runs.map(parseRun);
  if (findings.some((finding) => finding === null) || runs.some((run) => run === null)) return null;
  return {
    v: 2,
    lastReviewedSha: parsed.lastReviewedSha,
    baseSha: parsed.baseSha,
    blockingReviewId: parsed.blockingReviewId,
    findings: findings as FindingRecord[],
    recentEvents: parsed.recentEvents.filter((event): event is string => typeof event === 'string').slice(-MAX_RECENT_EVENTS),
    autoResolvedThreads: parsed.autoResolvedThreads
      .filter((thread): thread is string => typeof thread === 'string')
      .slice(-MAX_AUTO_RESOLVED_THREADS),
    checkRunId: parsed.checkRunId,
    checkRunHeadSha: parsed.checkRunHeadSha,
    migratedFromV1: parsed.migratedFromV1 === true ? true : undefined,
    runs: runs as RunRecord[],
  };
}
/** Backward-compatible parser: v1 is returned for callers that inspect old markers. */
export function parseStateMarker(body: string): ReviewState | LegacyReviewState | null {
  return parseV2StateMarker(body) ?? parseLegacyStateMarker(body);
}

/** Parse the old marker for lazy, explicitly lossy migration. */
export function parseLegacyStateMarker(body: string): LegacyReviewState | null {
  const parsed = parseJsonMarker(body, LEGACY_MARKER_PREFIX);
  if (!isRecord(parsed) || parsed.v !== 1) return null;
  if (
    typeof parsed.lastReviewedSha !== 'string' ||
    typeof parsed.baseSha !== 'string' ||
    !Array.isArray(parsed.postedFingerprints) ||
    !isRecord(parsed.openCounts)
  ) {
    return null;
  }
  const runs = Array.isArray(parsed.runs) ? parsed.runs.map(parseRun) : [];
  if (runs.some((run) => run === null)) return null;
  return {
    v: 1,
    lastReviewedSha: parsed.lastReviewedSha,
    baseSha: parsed.baseSha,
    blockingReviewId: typeof parsed.blockingReviewId === 'number' ? parsed.blockingReviewId : null,
    postedFingerprints: parsed.postedFingerprints.filter((fp): fp is string => typeof fp === 'string'),
    openCounts: { ...EMPTY_COUNTS, ...parsed.openCounts },
    runs: runs as RunRecord[],
  };
}

/** Start v2 with no fabricated fixed/dismissed history; the next run is full. */
export function migrateLegacyState(legacy: LegacyReviewState): ReviewState {
  return {
    v: 2,
    lastReviewedSha: legacy.lastReviewedSha,
    baseSha: legacy.baseSha,
    blockingReviewId: legacy.blockingReviewId,
    findings: [],
    recentEvents: [],
    autoResolvedThreads: [],
    checkRunId: null,
    checkRunHeadSha: null,
    migratedFromV1: true,
    runs: legacy.runs,
  };
}

/** Measure the escaped v2 marker payload against its byte budget. */
function markerBytes(state: ReviewState): number {
  const payload = JSON.stringify(state).replace(/-->/g, '--\\u003e');
  return Buffer.byteLength(`${STATE_MARKER_PREFIX}${payload}${STATE_MARKER_SUFFIX}`, 'utf8');
}

/** Remove bounded history and terminal records until the marker fits. */
function compactState(state: ReviewState): ReviewState {
  const findings = state.findings.map((finding) => ({
    ...finding,
    transitions: finding.transitions.slice(-MAX_TRANSITIONS_PER_FINDING),
  }));
  const active = findings.filter((finding) => finding.status === 'open');
  let terminal = findings
    .filter((finding) => finding.status !== 'open')
    .sort((a, b) => (a.transitions.at(-1)?.at ?? '').localeCompare(b.transitions.at(-1)?.at ?? ''))
    .slice(-MAX_TERMINAL_FINDINGS);
  let compacted: ReviewState = {
    ...state,
    findings: [...active, ...terminal],
    recentEvents: state.recentEvents.slice(-MAX_RECENT_EVENTS),
    autoResolvedThreads: state.autoResolvedThreads.slice(-MAX_AUTO_RESOLVED_THREADS),
    runs: state.runs.slice(-MAX_RUN_HISTORY),
  };
  if (markerBytes(compacted) > MAX_STATE_MARKER_BYTES) {
    compacted = {
      ...compacted,
      findings: compacted.findings.map((finding) => ({ ...finding, transitions: [] })),
    };
  }
  const compactedActive = compacted.findings.filter((finding) => finding.status === 'open');
  terminal = compacted.findings.filter((finding) => finding.status !== 'open');
  while (markerBytes(compacted) > MAX_STATE_MARKER_BYTES && terminal.length > 0) {
    terminal = terminal.slice(1);
    compacted = { ...compacted, findings: [...compactedActive, ...terminal] };
  }
  if (markerBytes(compacted) > MAX_STATE_MARKER_BYTES) {
    throw new Error(`FiscalCR lifecycle state exceeds ${MAX_STATE_MARKER_BYTES} bytes with active findings`);
  }
  return compacted;
}

const SEVERITY_ORDER: Record<Severity, number> = {
  critical: 0,
  warning: 1,
  suggestion: 2,
  nitpick: 3,
};

/** Serialize the v1 or compacted v2 lifecycle state inside an HTML comment. */
export function renderStateMarker(state: ReviewState | LegacyReviewState): string {
  const serializable = state.v === 2 ? compactState(state) : state;
  const prefix = serializable.v === 1 ? LEGACY_MARKER_PREFIX : STATE_MARKER_PREFIX;
  const payload = JSON.stringify(serializable).replace(/-->/g, '--\\u003e');
  return `${prefix}${payload}${STATE_MARKER_SUFFIX}`;
}

export interface FindingReconciliation {
  findings: FindingRecord[];
  newlyOpen: string[];
  fixed: string[];
}

/** Append a lifecycle transition unless the record already has that status. */
function transition(
  finding: FindingRecord,
  status: FindingStatus,
  at: string,
  source: FindingTransitionSource,
  event?: string,
  force = false,
): FindingRecord {
  if (finding.status === status && !event && !force) return finding;
  return {
    ...finding,
    status,
    transitions: [
      ...finding.transitions,
      { status, at, source, ...(event ? { event } : {}) },
    ].slice(-MAX_TRANSITIONS_PER_FINDING),
  };
}

function rangesOverlap(
  startLine: number,
  endLine: number,
  rangeStart: number,
  rangeEnd: number,
): boolean {
  return rangeStart <= endLine && startLine <= rangeEnd;
}

function reviewedRangeCoversFinding(range: ReviewedRange, finding: FindingRecord): boolean {
  if (rangesOverlap(finding.startLine, finding.endLine, range.startLine, range.endLine)) return true;
  return (
    range.originalStartLine !== undefined &&
    range.originalEndLine !== undefined &&
    rangesOverlap(finding.startLine, finding.endLine, range.originalStartLine, range.originalEndLine)
  );
}

/** Apply review observations only to paths in the successful reviewed-scope manifest. */
export function reconcileFindingInventory(
  state: ReviewState | null,
  observed: ReviewAnnotation[],
  reviewedPaths: string[],
  headSha: string,
  at: string,
  reviewedRanges: ReviewedRange[] = [],
): FindingReconciliation {
  const previous = new Map((state?.findings ?? []).map((finding) => [finding.fingerprint, finding]));
  const manifest = new Set(reviewedPaths);
  const observedFingerprints = new Set<string>();
  const findings = [...(state?.findings ?? [])];
  const index = new Map(findings.map((finding, position) => [finding.fingerprint, position]));
  const newlyOpen: string[] = [];

  for (const annotation of observed) {
    const fingerprint = fingerprintAnnotation(annotation);
    observedFingerprints.add(fingerprint);
    const old = previous.get(fingerprint);
    const manuallyDismissed = old?.status === 'dismissed';
    const next: FindingRecord = {
      fingerprint,
      status: manuallyDismissed ? 'dismissed' : 'open',
      severity: annotation.severity,
      path: annotation.path,
      startLine: annotation.startLine,
      endLine: annotation.endLine,
      title: annotation.title,
      threadId: old?.threadId ?? null,
      lastSeenSha: headSha,
      transitions: old?.transitions ?? [],
    };
    const reopened = old?.status === 'fixed';
    const updated = manuallyDismissed ? next : transition(next, 'open', at, 'review', undefined, reopened);
    if (reopened) newlyOpen.push(fingerprint);
    const position = index.get(fingerprint);
    if (position === undefined) {
      index.set(fingerprint, findings.length);
      findings.push(updated);
    } else {
      findings[position] = updated;
    }
  }

  const fixed: string[] = [];
  for (let position = 0; position < findings.length; position++) {
    const finding = findings[position];
    const rangesForPath = reviewedRanges.filter((range) => range.path === finding.path);
    const coveredByReviewedScope =
      rangesForPath.length === 0
        ? manifest.has(finding.path)
        : rangesForPath.some((range) => reviewedRangeCoversFinding(range, finding));
    if (
      finding.status === 'open' &&
      !observedFingerprints.has(finding.fingerprint) &&
      coveredByReviewedScope
    ) {
      findings[position] = transition(finding, 'fixed', at, 'review');
      fixed.push(finding.fingerprint);
    }
  }
  return { findings, newlyOpen, fixed };
}
/**
 * Merge a review result with state written concurrently after the review began.
 * Manual transitions from the newer state win by transition timestamp.
 */
export function mergeConcurrentReviewState(
  base: ReviewState | null,
  proposed: ReviewState,
  latest: ReviewState,
): ReviewState {
  const baseFindings = new Map((base?.findings ?? []).map((finding) => [finding.fingerprint, finding]));
  const latestFindings = new Map(latest.findings.map((finding) => [finding.fingerprint, finding]));
  const proposedFindings = new Map(proposed.findings.map((finding) => [finding.fingerprint, finding]));
  const fingerprints = new Set([...latestFindings.keys(), ...proposedFindings.keys()]);
  const findings = [...fingerprints].map((fingerprint) => {
    const proposedFinding = proposedFindings.get(fingerprint);
    const latestFinding = latestFindings.get(fingerprint);
    if (!proposedFinding) return latestFinding!;
    if (!latestFinding || JSON.stringify(latestFinding) === JSON.stringify(baseFindings.get(fingerprint))) {
      return proposedFinding;
    }

    const transitions = [...proposedFinding.transitions, ...latestFinding.transitions]
      .filter(
        (transition, index, all) =>
          all.findIndex(
            (candidate) =>
              candidate.status === transition.status &&
              candidate.at === transition.at &&
              candidate.source === transition.source &&
              candidate.event === transition.event,
          ) === index,
      )
      .sort((a, b) => a.at.localeCompare(b.at))
      .slice(-MAX_TRANSITIONS_PER_FINDING);
    return {
      ...proposedFinding,
      status: transitions.at(-1)?.status ?? proposedFinding.status,
      threadId: proposedFinding.threadId ?? latestFinding.threadId,
      transitions,
    };
  });
  const latestChanged = <K extends keyof ReviewState>(key: K): boolean =>
    latest[key] !== base?.[key];
  const mergedEvents = [...new Set([...latest.recentEvents, ...proposed.recentEvents])].slice(-MAX_RECENT_EVENTS);
  const mergedAutoResolved = [
    ...new Set([...latest.autoResolvedThreads, ...proposed.autoResolvedThreads]),
  ].slice(-MAX_AUTO_RESOLVED_THREADS);
  const mergedRuns = [
    ...new Map(
      [...latest.runs, ...proposed.runs].map((run) => [`${run.sha}:${run.at}:${run.scope}`, run]),
    ).values(),
  ].slice(-MAX_RUN_HISTORY);

  return {
    ...proposed,
    blockingReviewId: latestChanged('blockingReviewId') ? latest.blockingReviewId : proposed.blockingReviewId,
    findings,
    recentEvents: mergedEvents,
    autoResolvedThreads: mergedAutoResolved,
    checkRunId: latestChanged('checkRunId') ? latest.checkRunId : proposed.checkRunId,
    checkRunHeadSha: latestChanged('checkRunHeadSha') ? latest.checkRunHeadSha : proposed.checkRunHeadSha,
    runs: mergedRuns,
  };
}

/** Append a run record while retaining only the bounded recent history. */
export function appendRun(runs: RunRecord[], run: RunRecord): RunRecord[] {
  return [...runs, run].slice(-MAX_RUN_HISTORY);
}

const reviewStateLocks = new Map<string, Promise<unknown>>();

/** Serialize all state publication paths for one pull request in-process. */
export async function withReviewStateLock<T>(key: string, work: () => Promise<T>): Promise<T> {
  const previous = reviewStateLocks.get(key) ?? Promise.resolve();
  const current = previous.catch(() => undefined).then(work);
  reviewStateLocks.set(key, current);
  try {
    return await current;
  } finally {
    if (reviewStateLocks.get(key) === current) reviewStateLocks.delete(key);
  }
}

/** Legacy helper retained for consumers that still inspect v1 FIFO behavior. */
export function appendFingerprints(existing: string[], added: string[]): string[] {
  const merged = [...existing];
  for (const fingerprint of added) {
    if (!merged.includes(fingerprint)) merged.push(fingerprint);
  }
  return merged.slice(-300);
}

export interface StickyComment {
  commentId: number;
  state: ReviewState | null;
  legacyState?: LegacyReviewState;
  /** Original body, preserved as a normal enumerable field. */
  body: string;
}

/** Find the app-authored sticky FiscalCR comment by marker. */
export async function loadReviewState(
  octokit: FiscalcrOctokit,
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
      const body = comment.body ?? '';
      const hasV2 = body.includes(STATE_MARKER_PREFIX);
      const hasV1 = body.includes('<!-- fiscalcr:state:v1 ');
      const appAuthored =
        comment.user?.login === 'github-actions[bot]' ||
        ('performed_via_github_app' in comment && comment.performed_via_github_app !== null);
      if ((hasV2 || hasV1) && appAuthored) {
        return {
          commentId: comment.id,
          state: parseV2StateMarker(body),
          body,
          ...(hasV1 ? { legacyState: parseLegacyStateMarker(body) ?? undefined } : {}),
        };
      }
    }
    if (data.length < 100) return null;
    page++;
  }
}

/** Create/update only after the caller has completed all other side effects. */
export async function saveStickyComment(
  octokit: FiscalcrOctokit,
  params: {
    owner: string;
    repo: string;
    pullNumber: number;
    commentId: number | null;
    body: string;
    /** Body observed before composing the update; detects external changes. */
    expectedBody?: string;
    /** Recompose once from the latest sticky state after a concurrent update. */
    onConflict?: (current: StickyComment) => Promise<{
      commentId?: number;
      body: string;
      expectedBody: string;
    }>;
  },
): Promise<number> {
  if (Buffer.byteLength(params.body, 'utf8') > MAX_STICKY_COMMENT_BYTES) {
    throw new Error(`FiscalCR sticky comment exceeds ${MAX_STICKY_COMMENT_BYTES} bytes`);
  }
  const { owner, repo, pullNumber } = params;
  let commentId = params.commentId;
  let body = params.body;
  let expectedBody = params.expectedBody;
  let conflictRetries = 0;
  if (commentId === null) {
    const existing = await loadReviewState(octokit, { owner, repo, pullNumber });
    commentId = existing?.commentId ?? null;
  }
  for (;;) {
    if (commentId !== null) {
      if (expectedBody !== undefined) {
        const current = await loadReviewState(octokit, { owner, repo, pullNumber });
        if (
          current &&
          (current.commentId !== commentId || current.body !== expectedBody)
        ) {
          if (conflictRetries === 0 && params.onConflict) {
            const retry = await params.onConflict(current);
            if (Buffer.byteLength(retry.body, 'utf8') > MAX_STICKY_COMMENT_BYTES) {
              throw new Error(`FiscalCR sticky comment exceeds ${MAX_STICKY_COMMENT_BYTES} bytes`);
            }
            commentId = retry.commentId ?? current.commentId;
            body = retry.body;
            expectedBody = retry.expectedBody;
            conflictRetries++;
            continue;
          }
          throw new Error('Sticky comment changed before update; refusing to overwrite concurrent update');
        }
      }
      try {
        await octokit.issues.updateComment({
          owner,
          repo,
          comment_id: commentId,
          body,
        });
        return commentId;
      } catch (err) {
        if (statusOf(err) !== 404) throw err;
        logger.warn({ err, commentId }, 'Sticky comment was deleted — creating a replacement');
      }
    }
    const { data } = await octokit.issues.createComment({ owner, repo, issue_number: pullNumber, body });
    return data.id;
  }
}

const SEVERITY_EMOJI: Record<Severity, string> = {
  critical: '🔴',
  warning: '🟡',
  suggestion: '🔵',
  nitpick: '⚪',
};

export interface StickyCommentInput {
  result: ReviewResult;
  state: ReviewState | LegacyReviewState;
  demoted: Array<{ path: string; startLine: number; severity: Severity; title: string }>;
  walkthrough?: WalkthroughEntry[];
  /** Preserve the code-owned diagram already stored in the sticky body. */
  preserveExistingDiagram?: boolean;
  /** Current persisted sticky body used when no new diagram is rendered. */
  existingBody?: string;
}

/**
 * Escape the code-owned open-findings heading in untrusted text so section
 * refreshes cannot mistake model output for the generated lifecycle section.
 */
function escapeOpenFindingsHeading(value: string): string {
  return value.replace(/^### Open findings:/gm, '###\\ Open findings:');
}

/**
 * Locate a Markdown heading only when it begins a line, preferring the
 * generated tail section over earlier untrusted text.
 */
function findLineHeadingIndex(body: string, heading: string): number {
  let from = body.length;
  for (;;) {
    const idx = body.lastIndexOf(heading, from);
    if (idx < 0) return -1;
    const prev = idx === 0 ? '' : body[idx - 1];
    if (prev === '' || prev === '\n') return idx;
    from = idx - 1;
  }
}

/**
 * Locate a complete generated diagram block independently of the findings
 * heading: the map precedes the walkthrough. A candidate must use the
 * renderer-owned heading and Mermaid fence, so a marker pasted into summary
 * text is ignored.
 */
interface OptionalDiagramBlock {
  start: number;
  end: number;
  body: string;
}

function findOptionalDiagram(body: string): OptionalDiagramBlock | null {
  let searchFrom = body.length;
  while (searchFrom >= 0) {
    const startIdx = body.lastIndexOf(DIAGRAM_SECTION_START, searchFrom);
    if (startIdx < 0) return null;
    const startAtLine = startIdx === 0 || body[startIdx - 1] === '\n';
    if (!startAtLine) {
      searchFrom = startIdx - 1;
      continue;
    }

    const endIdx = body.indexOf(DIAGRAM_SECTION_END, startIdx + DIAGRAM_SECTION_START.length);
    if (endIdx < 0) return null;
    const endAtLine = endIdx === 0 || body[endIdx - 1] === '\n';
    const afterEnd = body[endIdx + DIAGRAM_SECTION_END.length];
    if (!endAtLine || (afterEnd !== undefined && afterEnd !== '\n')) {
      searchFrom = startIdx - 1;
      continue;
    }

    const content = body.slice(startIdx + DIAGRAM_SECTION_START.length, endIdx);
    const rendered = content.startsWith('\n') && content.endsWith('\n')
      ? content.slice(1, -1)
      : '';
    const validShape =
      /^(?:### (?:Concept|Implementation) map|### Sequence diagram|### Change table)(?:\n|$)/.test(rendered) &&
      (rendered.includes('```mermaid') || /\n\| (?:\\\||[^|\n])+(?: \| (?:\\\||[^|\n])+)+ \|\n\| (?:--- \| )+--- \|/.test(rendered)) &&
      !rendered.includes(DIAGRAM_SECTION_START) &&
      !rendered.includes(DIAGRAM_SECTION_END);
    if (!validShape) {
      searchFrom = startIdx - 1;
      continue;
    }

    return {
      start: startIdx,
      end: endIdx + DIAGRAM_SECTION_END.length,
      body: body.slice(startIdx, endIdx + DIAGRAM_SECTION_END.length),
    };
  }
  return null;
}

function omitOptionalDiagram(body: string): string {
  const diagram = findOptionalDiagram(body);
  return diagram ? `${body.slice(0, diagram.start)}${body.slice(diagram.end)}` : body;
}
/**
 * Locate the legacy diagram format used before code-owned section boundaries
 * were added. Require its complete generated shape before removing it.
 */
function findLegacyDiagram(body: string): OptionalDiagramBlock | null {
  const match =
    /^### Visual changes\nSource commit:[^\n]*\n\n```mermaid\n[\s\S]*?\n```\n\nEvidence:\n(?:- [^\n]*(?:\n|$))*/m.exec(
      body,
    );
  if (!match || match.index === undefined) return null;
  return {
    start: match.index,
    end: match.index + match[0].length,
    body: match[0],
  };
}

function omitLegacyDiagram(body: string): string {
  const diagram = findLegacyDiagram(body);
  return diagram ? `${body.slice(0, diagram.start)}${body.slice(diagram.end)}` : body;
}

function omitAnyDiagram(body: string): string {
  return omitLegacyDiagram(omitOptionalDiagram(body));
}


function existingDiagramBlock(body: string | undefined): string | undefined {
  return body === undefined ? undefined : findOptionalDiagram(body)?.body;
}

/**
 * Replace the lifecycle marker, dropping only the optional diagram block when
 * the result would otherwise exceed the sticky budget (e.g. a webhook refresh
 * added reopened finding rows or a retained diagram plus a grown marker pushed
 * past the cap). Findings and state are never trimmed to make room.
 */
export function replaceStateMarkerWithinBudget(body: string, state: ReviewState): string {
  const updated = replaceStateMarker(body, state);
  if (Buffer.byteLength(updated, 'utf8') <= MAX_STICKY_COMMENT_BYTES) return updated;
  const withoutDiagram = omitAnyDiagram(body);
  if (withoutDiagram !== body) return replaceStateMarker(withoutDiagram, state);
  return updated;
}
/** Render the human-readable sticky summary; fixed and dismissed findings stay hidden. */
export function renderStickyComment(input: StickyCommentInput): string {
  const { result, state, demoted } = input;
  const walkthrough = input.walkthrough ?? result.walkthrough;

  const head: string[] = ['## 🤖 FiscalCR Code Review\n', escapeOpenFindingsHeading(result.summary), ''];
  if (state.v === 2 && state.migratedFromV1) {
    head.push('> Migrated from the v1 marker; prior finding statuses were not inferred.', '');
  }

  const walkthroughLines: string[] = [];
  if (walkthrough && walkthrough.length > 0) {
    walkthroughLines.push(
      '<details>',
      '<summary>📝 Walkthrough</summary>\n',
      '| File | Change Summary |',
      '|------|----------------|',
    );
    for (const entry of walkthrough) {
      walkthroughLines.push(
        `| \`${entry.path}\` | ${escapeOpenFindingsHeading(entry.summary).replace(/\|/g, '\\|')} |`,
      );
    }
    walkthroughLines.push('</details>\n');
  }

  const tail: string[] = [];
  const active = state.v === 2 ? state.findings.filter((finding) => finding.status === 'open') : [];
  const openCounts = state.v === 2 ? { ...EMPTY_COUNTS } : state.openCounts;
  for (const finding of active) openCounts[finding.severity]++;
  const openTotal = state.v === 2 ? active.length : Object.values(openCounts).reduce((a, b) => a + b, 0);
  tail.push(`### Open findings: ${openTotal}`);
  if (openTotal > 0) {
    tail.push('| Severity | Location | Finding |', '|----------|----------|---------|');
    const visible = [...active]
      .sort((a, b) => SEVERITY_ORDER[a.severity] - SEVERITY_ORDER[b.severity])
      .slice(0, MAX_VISIBLE_FINDINGS);
    for (const finding of visible) {
      tail.push(
        `| ${SEVERITY_EMOJI[finding.severity]} ${finding.severity} | \`${finding.path}:${finding.startLine}\` | ${escapeOpenFindingsHeading(finding.title).replace(/\|/g, '\\|')} |`,
      );
    }
    if (visible.length < active.length) {
      tail.push('', `_…${active.length - visible.length} more open finding(s) are included in the counts above._`);
    }
    tail.push('', '| Severity | Open |', '|----------|------|');
    for (const [severity, count] of Object.entries(openCounts)) {
      if (count > 0) tail.push(`| ${SEVERITY_EMOJI[severity as Severity]} ${severity} | ${count} |`);
    }
  }
  tail.push('', `**Score:** ${result.score}/100`, '');
  const cumulativeCostUsd =
    state.runs.length > 0
      ? state.runs.reduce((total, run) => total + (Number.parseFloat(run.cost) || 0), 0)
      : undefined;
  tail.push(
    ...renderTelemetrySummary(
      result,
      cumulativeCostUsd === undefined ? '📊 Token usage & cost' : '📊 Latest review usage & cost',
      { cumulativeCostUsd },
    ),
    '',
  );

  if (demoted.length > 0) {
    tail.push('<details>', `<summary>⚠️ ${demoted.length} finding(s) could not be placed inline</summary>\n`);
    for (const d of demoted) {
      tail.push(`- ${SEVERITY_EMOJI[d.severity]} \`${d.path}:${d.startLine}\` — ${escapeOpenFindingsHeading(d.title)}`);
    }
    tail.push('\nSee the check-run annotations for details.', '</details>\n');
  }
  if (state.runs.length > 0) {
    tail.push(
      '<details>',
      '<summary>🕘 Review history</summary>\n',
      '| Commit | Date | Scope | New findings | Review cost |',
      '|--------|------|-------|--------------|-------------|',
    );
    for (const run of [...state.runs].reverse()) {
      tail.push(`| \`${run.sha}\` | ${run.at} | ${run.scope} | ${run.newFindings} | $${run.cost} |`);
    }
    tail.push('</details>\n');
  }
  tail.push('---', '*Powered by [FiscalCR](https://github.com/mof-malaysia/fiscal-cr) — model-agnostic AI code review*', '', renderStateMarker(state));

  const baseline = [...head, ...walkthroughLines, ...tail].join('\n');

  // Full reviews replace the map; incremental reviews preserve the last
  // code-owned map when no delta diagram is intentionally generated.
  const diagram = result.diagram;
  const preservedDiagram =
    !diagram && input.preserveExistingDiagram ? existingDiagramBlock(input.existingBody) : undefined;
  if (!diagram && !preservedDiagram) return baseline;

  let diagramBlock: string | undefined = preservedDiagram;
  if (diagram) {
    try {
      const section = renderDiagramSection(diagram, 'mermaid');
      diagramBlock = `${DIAGRAM_SECTION_START}\n${section}\n${DIAGRAM_SECTION_END}`;
    } catch {
      return baseline;
    }
  }

  // The map is the high-level explanation, before per-file walkthrough detail.
  const candidate = [...head, diagramBlock!, ...walkthroughLines, ...tail].join('\n');
  if (Buffer.byteLength(candidate, 'utf8') > MAX_STICKY_COMMENT_BYTES) return baseline;
  return candidate;
}
export function refreshStickyCommentState(body: string, state: ReviewState): string {
  const start = findLineHeadingIndex(body, '### Open findings:');
  const footer = start >= 0 ? body.indexOf('\n---\n', start) : -1;
  if (start < 0 || footer < 0) return replaceStateMarkerWithinBudget(body, state);

  const active = state.findings.filter((finding) => finding.status === 'open');
  const openCounts = { ...EMPTY_COUNTS };
  for (const finding of active) openCounts[finding.severity]++;
  const lines = [`### Open findings: ${active.length}`];
  if (active.length > 0) {
    lines.push('| Severity | Location | Finding |', '|----------|----------|---------|');
    for (const finding of [...active].sort((a, b) => SEVERITY_ORDER[a.severity] - SEVERITY_ORDER[b.severity])) {
      lines.push(
        `| ${SEVERITY_EMOJI[finding.severity]} ${finding.severity} | \`${finding.path}:${finding.startLine}\` | ${escapeOpenFindingsHeading(finding.title).replace(/\|/g, '\\|')} |`,
      );
    }
    lines.push('', '| Severity | Open |', '|----------|------|');
    for (const [severity, count] of Object.entries(openCounts)) {
      if (count > 0) lines.push(`| ${SEVERITY_EMOJI[severity as Severity]} ${severity} | ${count} |`);
    }
  }
  lines.push('');
  const before = body.slice(0, start);
  const score = body.indexOf('\n**Score:**', start);
  const sectionEnd = score >= 0 && score < footer ? score : footer;
  const after = body.slice(sectionEnd);
  // Replace only the generated findings table. Keep the score, demoted
  // findings, run history, footer, and any previously rendered diagram.
  return replaceStateMarkerWithinBudget(`${before}${lines.join('\n')}${after}`, state);
}

/** Replace an existing v1/v2 marker without disturbing surrounding comment text. */
export function replaceStateMarker(body: string, state: ReviewState): string {
  const marker = renderStateMarker(state);
  const existing = findJsonMarker(body, STATE_MARKER_PREFIX) ?? findJsonMarker(body, LEGACY_MARKER_PREFIX);
  if (existing) {
    return `${body.slice(0, existing.start)}${marker}${body.slice(existing.end)}`;
  }
  return `${body.trim()}\n\n${marker}`;
}

/** Apply one matching current-thread resolution as a manual dismissal. */
export function applyManualThreadResolution(
  state: ReviewState,
  input: { fingerprint: string; threadId: string; eventKey: string; at: string },
): ReviewState {
  if (state.recentEvents.includes(input.eventKey)) return state;
  let applied = false;
  const findings = state.findings.map((finding) => {
    if (
      finding.fingerprint !== input.fingerprint ||
      finding.threadId !== input.threadId ||
      finding.status !== 'open' ||
      state.autoResolvedThreads.includes(input.threadId)
    ) {
      return finding;
    }
    applied = true;
    return transition(finding, 'dismissed', input.at, 'manual', input.eventKey);
  });
  if (!applied) return state;
  return {
    ...state,
    findings,
    recentEvents: [...state.recentEvents, input.eventKey].slice(-MAX_RECENT_EVENTS),
  };
}

/** Reopen one matching dismissed finding after a user reopens its thread. */
export function applyManualThreadReopening(
  state: ReviewState,
  input: { fingerprint: string; threadId: string; eventKey: string; at: string },
): ReviewState {
  if (state.recentEvents.includes(input.eventKey)) return state;
  let applied = false;
  const findings = state.findings.map((finding) => {
    if (
      finding.fingerprint !== input.fingerprint ||
      finding.threadId !== input.threadId ||
      finding.status !== 'dismissed'
    ) {
      return finding;
    }
    applied = true;
    return transition(finding, 'open', input.at, 'manual', input.eventKey);
  });
  if (!applied) return state;
  return {
    ...state,
    findings,
    recentEvents: [...state.recentEvents, input.eventKey].slice(-MAX_RECENT_EVENTS),
  };
}

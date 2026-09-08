import type { Octokit } from '@octokit/rest';
import type { ReviewAnnotation, ReviewResult, ReviewedRange, Severity, WalkthroughEntry } from '../types/review.js';
import { fingerprintAnnotation } from './fingerprint.js';
import { renderDiagramSection } from '../review/diagram-renderer.js';
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
    const coveredByReviewedScope =
      reviewedRanges.length > 0
        ? reviewedRanges.some(
            (range) =>
              range.path === finding.path &&
              range.startLine <= finding.endLine &&
              finding.startLine <= range.endLine,
          )
        : manifest.has(finding.path);
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
  /** ETag from the matched comment resource, used for optimistic updates. */
  etag?: string;
}

/** Find the app-authored sticky FiscalCR comment by marker. */
export async function loadReviewState(
  octokit: Octokit,
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
        let etag: string | undefined;
        const getComment = (
          octokit.issues as typeof octokit.issues & {
            getComment?: (params: { owner: string; repo: string; comment_id: number }) => Promise<{
              headers?: { etag?: string };
            }>;
          }
        ).getComment;
        if (getComment) {
          try {
            etag = (await getComment({ owner, repo, comment_id: comment.id })).headers?.etag;
          } catch (err) {
            logger.debug({ err, commentId: comment.id }, 'Could not read sticky comment ETag');
          }
        }
        return {
          commentId: comment.id,
          state: parseV2StateMarker(body),
          body,
          ...(hasV1 ? { legacyState: parseLegacyStateMarker(body) ?? undefined } : {}),
          ...(etag ? { etag } : {}),
        };
      }
    }
    if (data.length < 100) return null;
    page++;
  }
}

/** Create/update only after the caller has completed all other side effects. */
export async function saveStickyComment(
  octokit: Octokit,
  params: {
    owner: string;
    repo: string;
    pullNumber: number;
    commentId: number | null;
    body: string;
    expectedEtag?: string;
  },
): Promise<number> {
  if (Buffer.byteLength(params.body, 'utf8') > MAX_STICKY_COMMENT_BYTES) {
    throw new Error(`FiscalCR sticky comment exceeds ${MAX_STICKY_COMMENT_BYTES} bytes`);
  }
  const { owner, repo, pullNumber, body } = params;
  let commentId = params.commentId;
  let expectedEtag = params.expectedEtag;
  if (commentId === null) {
    const existing = await loadReviewState(octokit, { owner, repo, pullNumber });
    commentId = existing?.commentId ?? null;
    expectedEtag ??= existing?.etag;
  }
  if (commentId !== null) {
    try {
      await octokit.issues.updateComment({
        owner,
        repo,
        comment_id: commentId,
        body,
        ...(expectedEtag ? { headers: { 'If-Match': expectedEtag } } : {}),
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
}

/**
 * Locate a Markdown heading only when it begins a line (start of body or
 * immediately after a newline), so untrusted file paths or finding titles that
 * merely contain the heading text cannot be mistaken for the section anchor.
 */
function findLineHeadingIndex(body: string, heading: string): number {
  let from = 0;
  for (;;) {
    const idx = body.indexOf(heading, from);
    if (idx < 0) return -1;
    const prev = idx === 0 ? '' : body[idx - 1];
    if (prev === '' || prev === '\n') return idx;
    from = idx + heading.length;
  }
}

/**
 * Remove the optional generated diagram block, if present. The block is
 * code-owned and always rendered immediately before the line-start
 * `### Open findings:` heading, and the renderer escapes every raw delimiter
 * so untrusted content cannot forge a boundary. Anchor the lookup on that
 * heading and require the boundary pair to be directly adjacent to it: a
 * forged marker inside untrusted summary/intent/finding text is ignored, and
 * when the expected pair is absent or not adjacent to the section the body is
 * left unchanged rather than deleting content outside the generated diagram.
 */
  function omitOptionalDiagram(body: string): string {
  // The code-owned diagram block is always rendered immediately before the
  // line-start open-findings heading. Locate that heading first so a marker
  // forged inside untrusted text cannot be mistaken for the real boundary pair.
  const headingIdx = findLineHeadingIndex(body, '### Open findings:');
  if (headingIdx < 0) return body;

  // The end boundary must sit directly adjacent to the heading, joined only by
  // the single newline the renderer emits between the block and the tail.
  // Otherwise this is not the code-owned block and we delete nothing.
  const endIdx = body.lastIndexOf(DIAGRAM_SECTION_END, headingIdx - 1);
  if (endIdx < 0) return body;
  if (body.slice(endIdx + DIAGRAM_SECTION_END.length, headingIdx) !== '\n') return body;

  // The matching start boundary must precede the end with no extra boundary
  // markers nested between them. A forged start/end inside the pair would break
  // the clean boundary, so we leave the body untouched.
  const startIdx = body.lastIndexOf(DIAGRAM_SECTION_START, endIdx - 1);
  if (startIdx < 0) return body;
  const between = body.slice(startIdx + DIAGRAM_SECTION_START.length, endIdx);
  if (between.includes(DIAGRAM_SECTION_START) || between.includes(DIAGRAM_SECTION_END)) return body;

  // Drop the whole code-owned block, including the newline joining it to the
  // heading, so the refreshed body resumes cleanly at "### Open findings:".
  return `${body.slice(0, startIdx)}${body.slice(headingIdx)}`;
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
  if (!updated.includes(DIAGRAM_SECTION_START)) return updated;
  return replaceStateMarker(omitOptionalDiagram(body), state);
}
/** Render the human-readable sticky summary; fixed and dismissed findings stay hidden. */
export function renderStickyComment(input: StickyCommentInput): string {
  const { result, state, demoted } = input;
  const walkthrough = input.walkthrough ?? result.walkthrough;

  // Head: everything up to and including the walkthrough block.
  const head: string[] = [];
  head.push('## 🤖 FiscalCR Code Review\n');
  if (result.intent) head.push(`> ${result.intent}\n`);
  head.push(result.summary, '');
  head.push(`**Score:** ${result.score}/100 · last reviewed \`${state.lastReviewedSha.slice(0, 7)}\``, '');
  if (state.v === 2 && state.migratedFromV1) {
    head.push('> Migrated from the v1 marker; prior finding statuses were not inferred.', '');
  }

  if (walkthrough && walkthrough.length > 0) {
    head.push('<details>', '<summary>📝 Walkthrough</summary>\n', '| File | Change Summary |', '|------|----------------|');
    for (const entry of walkthrough) head.push(`| \`${entry.path}\` | ${entry.summary.replace(/\|/g, '\\|')} |`);
    head.push('</details>\n');
  }

  // Tail: open findings, demoted, run history, footer, and the hidden state marker.
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
        `| ${SEVERITY_EMOJI[finding.severity]} ${finding.severity} | \`${finding.path}:${finding.startLine}\` | ${finding.title.replace(/\|/g, '\\|')} |`,
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
  tail.push('');

  if (demoted.length > 0) {
    tail.push('<details>', `<summary>⚠️ ${demoted.length} finding(s) could not be placed inline</summary>\n`);
    for (const d of demoted) tail.push(`- ${SEVERITY_EMOJI[d.severity]} \`${d.path}:${d.startLine}\` — ${d.title}`);
    tail.push('\nSee the check-run annotations for details.', '</details>\n');
  }
  if (state.runs.length > 0) {
    tail.push('<details>', '<summary>🕘 Run history</summary>\n', '| Commit | When | Scope | New findings | Cost |', '|--------|------|-------|--------------|------|');
    for (const run of [...state.runs].reverse()) tail.push(`| \`${run.sha}\` | ${run.at} | ${run.scope} | ${run.newFindings} | $${run.cost} |`);
    tail.push('</details>\n');
  }
  tail.push('---', '*Powered by [FiscalCR](https://github.com/mof-malaysia/fiscal-cr) — model-agnostic AI code review*', '', renderStateMarker(state));

  // Baseline preserves the existing body byte-for-byte when no diagram is present.
  const baseline = [...head, ...tail].join('\n');

  const diagram = result.diagram;
  if (!diagram) return baseline;

  // Diagram-specific failures must not prevent the baseline comment from publishing.
  let section: string;
  try {
    section = renderDiagramSection(diagram, 'mermaid');
  } catch {
    return baseline;
  }

  // Insert after the walkthrough and before the open-findings heading, wrapped
  // in code-owned boundaries so untrusted content cannot forge a section edge.
  // Omit the diagram when the whole serialized body (marker included) would
  // overflow the existing sticky budget, so findings and state are never
  // truncated to fit.
  const diagramBlock = `${DIAGRAM_SECTION_START}\n${section}\n${DIAGRAM_SECTION_END}`;
  const candidate = [...head, diagramBlock, ...tail].join('\n');
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
        `| ${SEVERITY_EMOJI[finding.severity]} ${finding.severity} | \`${finding.path}:${finding.startLine}\` | ${finding.title.replace(/\|/g, '\\|')} |`,
      );
    }
    lines.push('', '| Severity | Open |', '|----------|------|');
    for (const [severity, count] of Object.entries(openCounts)) {
      if (count > 0) lines.push(`| ${SEVERITY_EMOJI[severity as Severity]} ${severity} | ${count} |`);
    }
  }
  lines.push('');
  const before = body.slice(0, start);
  const after = body.slice(footer);
  // Preserve any previously rendered (code-owned) optional diagram block and
  // place the refreshed findings table + marker; drop the diagram only if the
  // refreshed body would exceed the sticky budget.
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

import { describe, expect, it, vi } from 'vitest';
import {
  EMPTY_COUNTS,
  appendFingerprints,
  appendRun,
  applyManualThreadResolution,
  mergeConcurrentReviewState,
  loadReviewState,
  migrateLegacyState,
  parseStateMarker,
  reconcileFindingInventory,
  renderStateMarker,
  replaceStateMarker,
  replaceStateMarkerWithinBudget,
  refreshStickyCommentState,
  renderStickyComment,
  saveStickyComment,
  MAX_STATE_MARKER_BYTES,
  MAX_STICKY_COMMENT_BYTES,
  DIAGRAM_SECTION_START,
  DIAGRAM_SECTION_END,
  type ReviewState,
} from '../../src/github/review-state.js';
import type { DiagramArtifact } from '../../src/types/diagram.js';
import type { ReviewResult } from '../../src/types/review.js';

function state(overrides: Partial<ReviewState> = {}): ReviewState {
  return {
    v: 2,
    lastReviewedSha: 'abc1234def567890',
    baseSha: 'base000',
    blockingReviewId: 42,
    findings: [{
      fingerprint: 'aaaabbbbccccdddd',
      status: 'open',
      severity: 'critical',
      path: 'src/a.ts',
      startLine: 2,
      endLine: 2,
      title: 'Existing',
      threadId: 'thread-1',
      lastSeenSha: 'abc1234',
      transitions: [{ status: 'open', at: '2026-07-16', source: 'review' }],
    }],
    recentEvents: [],
    autoResolvedThreads: [],
    checkRunId: 9,
    checkRunHeadSha: 'abc1234def567890',
    runs: [{ sha: 'abc1234', at: '2026-07-16', scope: 'full', newFindings: 3, cost: '0.05' }],
    ...overrides,
  };
}

function annotation(overrides: Partial<ReviewResult['annotations'][number]> = {}) {
  return {
    path: 'src/a.ts',
    startLine: 2,
    endLine: 2,
    severity: 'critical' as const,
    category: 'bug' as const,
    title: 'Existing',
    body: 'body',
    ...overrides,
  };
}
function result(): ReviewResult {
  return {
    summary: 'All good',
    score: 90,
    annotations: [],
    findings: [],
    reviewedPaths: [],
    stats: { ...EMPTY_COUNTS },
    tokensUsed: { input: 100, output: 50, cached: 0 },
    intent: 'Adds a feature',
    walkthrough: [{ path: 'src/a.ts', summary: 'tweak' }],
  };
}
function diagram(): DiagramArtifact {
  return {
    mode: 'concept',
    nodes: [{ id: 'n0', label: 'Auth', change: 'modified', evidence: ['e1'] }],
    edges: [{ from: 'n0', to: 'n0', label: 'loops', change: 'context', evidence: ['e1'] }],
    evidence: [{ id: 'e1', path: 'src/auth.ts' }],
    headSha: 'abc1234def567890',
    scope: 'full',
    partial: false,
  };
}

function tableDiagram(): DiagramArtifact {
  return {
    ...diagram(),
    representation: 'table',
    nodes: [],
    edges: [],
    columns: ['State', 'Result'],
    rows: [{ cells: ['Waiting', 'Active'], evidence: ['e1'] }],
  };
}

// A large artifact used to push the sticky body over its byte budget.
function bigDiagram(): DiagramArtifact {
  return {
    mode: 'concept',
    nodes: Array.from({ length: 60 }, (_, i) => ({
      id: `n${i}`,
      label: 'x'.repeat(200),
      change: 'modified' as const,
      evidence: [],
    })),
    edges: [],
    evidence: [],
    headSha: 'abc1234def567890',
    scope: 'full',
    partial: false,
  };
}

describe('state marker', () => {
  it('roundtrips through render + parse', () => {
    const s = state();
    expect(parseStateMarker(`some comment text\n${renderStateMarker(s)}`)).toEqual(s);
  });
  it('parses and replaces markers when JSON contains the marker suffix text', () => {
    const s = state({
      findings: [{ ...state().findings[0], title: 'Message contains --> delimiter text' }],
    });
    const marker = renderStateMarker(s);
    expect(marker).toContain('--\\u003e delimiter text');
    expect(marker.slice(0, marker.lastIndexOf(' -->'))).not.toContain('-->');
    const body = `prefix\n${marker}\ntrailer`;
    expect(parseStateMarker(body)).toEqual(s);
    const replacement = replaceStateMarker(body, state({ lastReviewedSha: 'next-sha' }));
    expect(replacement).toContain('prefix');
    expect(replacement).toContain('trailer');
    expect(parseStateMarker(replacement)).toMatchObject({ v: 2, lastReviewedSha: 'next-sha' });
  });

  it('returns null for missing, corrupt, or unknown markers', () => {
    expect(parseStateMarker('no marker here')).toBeNull();
    expect(parseStateMarker('<!-- fiscalcr:state:v1 {not json} -->')).toBeNull();
    expect(parseStateMarker('<!-- fiscalcr:state:v1 {"v":99} -->')).toBeNull();
    expect(parseStateMarker('<!-- fiscalcr:state:v1 {"v":1,"lastReviewedSha":123} -->')).toBeNull();
  });

  it('fills defaults for missing optional fields', () => {
    const parsed = parseStateMarker(
      '<!-- fiscalcr:state:v1 {"v":1,"lastReviewedSha":"a","baseSha":"b","postedFingerprints":[],"openCounts":{}} -->',
    );
    expect(parsed).not.toBeNull();
    expect(parsed!.blockingReviewId).toBeNull();
    expect(parsed!.openCounts).toEqual(EMPTY_COUNTS);
    expect(parsed!.runs).toEqual([]);
  });
  it('migrates v1 without fabricating lifecycle history', () => {
    const legacy = parseStateMarker(
      '<!-- fiscalcr:state:v1 {"v":1,"lastReviewedSha":"a","baseSha":"b","postedFingerprints":["old"],"openCounts":{"critical":1}} -->',
    );
    expect(legacy?.v).toBe(1);
    const migrated = migrateLegacyState(legacy as Extract<typeof legacy, { v: 1 }>);
    expect(migrated).toMatchObject({
      v: 2,
      findings: [],
      checkRunId: null,
      migratedFromV1: true,
    });
  });

  it('bounds terminal lifecycle records before rendering the marker', () => {
    const findings = Array.from({ length: 200 }, (_, index) => ({
      ...state().findings[0],
      fingerprint: `${index.toString(16).padStart(16, '0')}`,
      status: 'fixed' as const,
      title: `historical finding ${index} ${'x'.repeat(200)}`,
      transitions: [{ status: 'fixed' as const, at: `2026-01-${(index % 28) + 1}`, source: 'review' as const }],
    }));
    const marker = renderStateMarker(state({ findings }));
    const parsed = parseStateMarker(marker);

    expect(Buffer.byteLength(marker, 'utf8')).toBeLessThanOrEqual(MAX_STATE_MARKER_BYTES);
    expect(parsed?.v).toBe(2);
    if (parsed?.v === 2) expect(parsed.findings.length).toBeLessThan(200);
  });

  it('keeps stripped active histories stripped while evicting terminals', () => {
    const active = {
      ...state().findings[0],
      transitions: Array.from({ length: 8 }, (_, index) => ({
        status: 'open' as const,
        at: `2026-02-${String(index + 1).padStart(2, '0')}`,
        source: 'review' as const,
        event: 'x'.repeat(3000),
      })),
    };
    const terminal = Array.from({ length: 80 }, (_, index) => ({
      ...state().findings[0],
      fingerprint: `${(index + 1).toString(16).padStart(16, '0')}`,
      status: 'fixed' as const,
      title: `terminal ${index} ${'x'.repeat(200)}`,
    }));

    const parsed = parseStateMarker(renderStateMarker(state({ findings: [active, ...terminal] })));

    expect(parsed?.v).toBe(2);
    if (parsed?.v === 2) {
      expect(parsed.findings.find((finding) => finding.fingerprint === active.fingerprint)?.transitions).toEqual([]);
      expect(parsed.findings.length).toBeLessThan(81);
    }
  });
});

describe('FIFO caps', () => {
  it('caps fingerprints at 300, dropping the oldest', () => {
    const existing = Array.from({ length: 295 }, (_, i) => `fp${i}`);
    const merged = appendFingerprints(existing, ['new1', 'new2', 'new3', 'new4', 'new5', 'new6']);
    expect(merged).toHaveLength(300);
    expect(merged.at(-1)).toBe('new6');
    expect(merged).not.toContain('fp0');
    expect(merged).toContain('fp1');
  });


  it('does not duplicate already-known fingerprints', () => {
    expect(appendFingerprints(['a', 'b'], ['b', 'c'])).toEqual(['a', 'b', 'c']);
  });

  it('caps run history at 20', () => {
    let runs = state().runs;
    for (let i = 0; i < 25; i++) {
      runs = appendRun(runs, { sha: `sha${i}`, at: 'x', scope: 'delta', newFindings: 0, cost: '0' });
    }
    expect(runs).toHaveLength(20);
    expect(runs.at(-1)!.sha).toBe('sha24');
  });
});
describe('finding lifecycle reconciliation', () => {
  it('opens unknown findings, updates severity, fixes only in-scope absences, and reopens terminals', () => {
    const first = reconcileFindingInventory(null, [annotation()], ['src/a.ts'], 'sha1', 'one');
    expect(first.findings[0]).toMatchObject({ status: 'open', severity: 'critical' });
    const fixed = reconcileFindingInventory(firstState(first.findings), [], ['src/a.ts'], 'sha2', 'two');
    expect(fixed.findings[0].status).toBe('fixed');
    const reopened = reconcileFindingInventory(
      firstState(fixed.findings),
      [annotation({ severity: 'warning' })],
      ['src/a.ts'],
      'sha3',
      'three',
    );
    expect(reopened.findings[0]).toMatchObject({ status: 'open', severity: 'warning' });
    expect(reopened.findings[0].transitions.at(-1)).toMatchObject({
      status: 'open',
      source: 'review',
    });
  });

  it('fixes delta findings only when their line is covered', () => {
    const open = firstState(reconcileFindingInventory(null, [annotation()], ['src/a.ts'], 'sha1', 'one').findings);
    const untouched = reconcileFindingInventory(open, [], [], 'sha2', 'two', [
      { path: 'src/a.ts', startLine: 3, endLine: 3 },
    ]);
    expect(untouched.findings[0].status).toBe('open');

    const covered = reconcileFindingInventory(open, [], [], 'sha3', 'three', [
      { path: 'src/a.ts', startLine: 2, endLine: 2 },
    ]);
    expect(covered.findings[0].status).toBe('fixed');
  });

  it('fixes findings covered only by a deletion hunk', () => {
    const open = firstState(
      reconcileFindingInventory(null, [annotation({ startLine: 7, endLine: 7 })], ['src/a.ts'], 'sha1', 'one').findings,
    );
    const fixed = reconcileFindingInventory(open, [], [], 'sha2', 'two', [
      {
        path: 'src/a.ts',
        startLine: 8,
        endLine: 8,
        originalStartLine: 7,
        originalEndLine: 7,
      },
    ]);
    expect(fixed.findings[0].status).toBe('fixed');
  });

  it('preserves a concurrent manual dismissal when saving review state', () => {
    const base = firstState(
      reconcileFindingInventory(null, [annotation()], ['src/a.ts'], 'sha1', '2026-01-01').findings.map((finding) => ({
        ...finding,
        threadId: 'thread-1',
      })),
    );
    const proposed = reconcileFindingInventory(base, [], ['src/a.ts'], 'sha2', '2026-01-02').findings;
    const latest: ReviewState = {
      ...base,
      findings: base.findings.map((finding) => ({
        ...finding,
        status: 'dismissed' as const,
        transitions: [
          ...finding.transitions,
          { status: 'dismissed' as const, at: '2026-01-03', source: 'manual' as const, event: 'delivery-1' },
        ],
      })),
      recentEvents: ['delivery-1'],
    };

    const merged = mergeConcurrentReviewState(base, { ...base, findings: proposed }, latest);

    const mergedFinding = merged.findings.find((finding) => finding.fingerprint === base.findings.at(-1)!.fingerprint);
    expect(mergedFinding?.status).toBe('dismissed');
    expect(merged.recentEvents).toContain('delivery-1');
  });

  it('keeps absent findings open outside the successful manifest', () => {
    const current = reconcileFindingInventory(null, [annotation()], ['src/a.ts'], 'sha1', 'one');
    const next = reconcileFindingInventory(firstState(current.findings), [], ['src/other.ts'], 'sha2', 'two');
    expect(next.findings[0].status).toBe('open');
  });

  it('dismisses only an open finding backed by the current thread', () => {
    const current = reconcileFindingInventory(null, [annotation()], ['src/a.ts'], 'sha1', 'one');
    const withThread = firstState(current.findings.map((finding) => ({ ...finding, threadId: 'thread-1' })));
    const dismissed = applyManualThreadResolution(withThread, {
      fingerprint: withThread.findings[0].fingerprint,
      threadId: 'thread-1',
      eventKey: 'delivery-1',
      at: 'two',
    });
    expect(dismissed.findings[0].status).toBe('dismissed');
    const duplicate = applyManualThreadResolution(dismissed, {
      fingerprint: withThread.findings[0].fingerprint,
      threadId: 'thread-1',
      eventKey: 'delivery-1',
      at: 'three',
    });
    expect(duplicate).toEqual(dismissed);
  });

  it('does not reopen a manually dismissed finding during review', () => {
    const current = reconcileFindingInventory(null, [annotation()], ['src/a.ts'], 'sha1', 'one');
    const withThread = firstState(current.findings.map((finding) => ({ ...finding, threadId: 'thread-1' })));
    const dismissed = applyManualThreadResolution(withThread, {
      fingerprint: withThread.findings[0].fingerprint,
      threadId: 'thread-1',
      eventKey: 'delivery-1',
      at: 'two',
    });

    const observed = reconcileFindingInventory(dismissed, [annotation()], ['src/a.ts'], 'sha2', 'three');

    expect(observed.findings[0].status).toBe('dismissed');
    expect(observed.newlyOpen).toEqual([]);
  });

  it('does not consume an event before its finding matches', () => {
    const current = reconcileFindingInventory(null, [annotation()], ['src/a.ts'], 'sha1', 'one');
    const withThread = firstState(current.findings.map((finding) => ({ ...finding, threadId: 'thread-1' })));
    const unmatched = applyManualThreadResolution(withThread, {
      fingerprint: withThread.findings[0].fingerprint,
      threadId: 'thread-2',
      eventKey: 'delivery-race',
      at: 'two',
    });

    expect(unmatched).toEqual(withThread);
    expect(unmatched.recentEvents).not.toContain('delivery-race');
  });
});

function firstState(findings: ReviewState['findings']): ReviewState {
  return {
    ...state(),
    findings,
  };
}

describe('renderStickyComment', () => {
  it('embeds the state marker, open counts, run history, and walkthrough', () => {
    const body = renderStickyComment({
      result: {
        ...result(),
        callCount: 2,
        costEstimate: { usd: 0.0123, source: 'exact', provider: 'openrouter', model: 'openai/gpt-5' },
      },
      state: state(),
      demoted: [],
    });
    expect(parseStateMarker(body)).toEqual(state());
    expect(body).toContain('📊 Latest review usage & cost');
    expect(body).toContain('| Uncached input | 100 |');
    expect(body).toContain('**Cumulative review cost:** $0.0500');
    expect(body).toContain('**Model:** `openrouter/openai/gpt-5`');
    expect(body).toContain('Open findings: 1');
    expect(body).toContain('critical | 1');
    expect(body).toContain('`abc1234`');
    expect(body).toContain('Walkthrough');
    expect(body).toContain('tweak');
    expect(body).not.toContain('> Adds a feature');
  });

  it('lists demoted findings when present', () => {
    const body = renderStickyComment({
      result: result(),
      state: state(),
      demoted: [{ path: 'src/x.ts', startLine: 9, severity: 'warning', title: 'Unplaceable' }],
    });
    expect(body).toContain('could not be placed inline');
    expect(body).toContain('`src/x.ts:9` — Unplaceable');
  });

  it('refreshes the visible lifecycle table after a manual state change', () => {
    const body = renderStickyComment({ result: result(), state: state(), demoted: [] });
    const updated = state({ findings: [{ ...state().findings[0], status: 'dismissed' }] });
    const refreshed = refreshStickyCommentState(body, updated);

    expect(refreshed).toContain('Open findings: 0');
    expect(refreshed).not.toContain('| Existing |');
    expect(parseStateMarker(refreshed)).toEqual(updated);
  });
  it('renders the optional diagram before the walkthrough and open findings', () => {
    const body = renderStickyComment({
      result: { ...result(), diagram: diagram() },
      state: state(),
      demoted: [],
    });
    expect(body).toContain('### Concept map');
    expect(body).toContain('```mermaid');
    expect(body.indexOf('### Concept map')).toBeLessThan(body.indexOf('Walkthrough'));
    expect(body.indexOf('### Concept map')).toBeLessThan(body.indexOf('### Open findings:'));
    expect(body.match(/### Concept map/g)).toHaveLength(1);
    expect(body).toContain('### Open findings: 1');
    expect(parseStateMarker(body)).toEqual(state());
  });

  it('keeps the state marker and findings valid while rendering the diagram', () => {
    const body = renderStickyComment({
      result: { ...result(), diagram: diagram() },
      state: state(),
      demoted: [],
    });
    expect(parseStateMarker(body)).toEqual(state());
    expect(body).toContain('critical | 1');
  });

  it('preserves lifecycle metadata across a refresh', () => {
    const body = renderStickyComment({
      result: { ...result(), diagram: diagram() },
      state: state(),
      demoted: [{ path: 'src/d.ts', startLine: 3, severity: 'warning', title: 'Demoted' }],
    });
    const updated = state({ findings: [{ ...state().findings[0], status: 'dismissed' }] });
    const refreshed = refreshStickyCommentState(body, updated);

    expect(refreshed).toContain('### Concept map');
    expect(refreshed).toContain('Open findings: 0');
    expect(refreshed).toContain('**Score:** 90/100');
    expect(refreshed).toContain('Demoted');
    expect(refreshed).toContain('Review history');
    expect(refreshed).not.toContain('| Existing |');
    expect(parseStateMarker(refreshed)).toEqual(updated);
  });

  it('preserves the last diagram when an incremental render has no replacement', () => {
    const previous = renderStickyComment({
      result: { ...result(), diagram: diagram() },
      state: state(),
      demoted: [],
    });
    const start = previous.indexOf(DIAGRAM_SECTION_START);
    const end = previous.indexOf(DIAGRAM_SECTION_END) + DIAGRAM_SECTION_END.length;
    const refreshed = renderStickyComment({
      result: { ...result(), summary: 'Incremental summary' },
      state: state(),
      demoted: [],
      preserveExistingDiagram: true,
      existingBody: previous,
    });

    expect(start).toBeGreaterThanOrEqual(0);
    expect(end).toBeGreaterThan(start);
    expect(refreshed.slice(refreshed.indexOf(DIAGRAM_SECTION_START), refreshed.indexOf(DIAGRAM_SECTION_END) + DIAGRAM_SECTION_END.length))
      .toBe(previous.slice(start, end));
    expect(refreshed).toContain('Incremental summary');
  });

  it('preserves a Markdown table artifact across an incremental refresh', () => {
    const previous = renderStickyComment({
      result: { ...result(), diagram: tableDiagram() },
      state: state(),
      demoted: [],
    });
    const refreshed = renderStickyComment({
      result: { ...result(), summary: 'Incremental summary' },
      state: state(),
      demoted: [],
      preserveExistingDiagram: true,
      existingBody: previous,
    });

    expect(refreshed).toContain('### Change table');
    expect(refreshed).toContain('| State | Result |');
    expect(refreshed).toContain('Incremental summary');
  });

  it('replaces the preserved diagram when a full review supplies a new one', () => {
    const previous = renderStickyComment({
      result: { ...result(), diagram: diagram() },
      state: state(),
      demoted: [],
    });
    const replacement = renderStickyComment({
      result: {
        ...result(),
        diagram: {
          ...diagram(),
          nodes: [
            { id: 'n0', label: 'New boundary', change: 'modified', evidence: ['e1'] },
            { id: 'n1', label: 'New output', change: 'added', evidence: ['e1'] },
          ],
          edges: [{ from: 'n0', to: 'n1', label: 'publishes', change: 'added', evidence: ['e1'] }],
        },
      },
      state: state(),
      demoted: [],
      preserveExistingDiagram: true,
      existingBody: previous,
    });

    expect(replacement).toContain('New boundary');
    expect(replacement).not.toContain('n0["Auth"]');
    expect(replacement.match(/### Concept map/g)).toHaveLength(1);
  });

  it('omits the diagram but keeps findings and state when it would overflow the sticky budget', () => {
    const body = renderStickyComment({
      result: { ...result(), summary: 'x'.repeat(50_000), diagram: bigDiagram() },
      state: state(),
      demoted: [],
    });
    expect(body).not.toContain('### Concept map');
    expect(body).toContain('### Open findings: 1');
    expect(parseStateMarker(body)).toEqual(state());
    expect(Buffer.byteLength(body, 'utf8')).toBeLessThanOrEqual(MAX_STICKY_COMMENT_BYTES);
  });

  it('removes a legacy diagram when marker replacement would overflow', () => {
    const historicalGraph = [
      '### Visual changes',
      'Source commit: old-sha',
      '',
      '```mermaid',
      'flowchart TD',
      '  n0["Request"]',
      '```',
      '',
      'Evidence:',
      '- (none referenced)',
    ].join('\n');
    const marker = renderStateMarker(state());
    const padding = 'x'.repeat(MAX_STICKY_COMMENT_BYTES - Buffer.byteLength(marker, 'utf8') - 100);
    const body = `${historicalGraph}\n\n${padding}\n${marker}`;

    const refreshed = replaceStateMarkerWithinBudget(body, state());

    expect(refreshed).not.toContain('### Visual changes');
    expect(Buffer.byteLength(refreshed, 'utf8')).toBeLessThanOrEqual(MAX_STICKY_COMMENT_BYTES);
    expect(parseStateMarker(refreshed)).toEqual(state());
  });

  it('publishes the baseline (no diagram) when the diagram artifact is malformed', () => {
    const malformed = { nodes: undefined } as unknown as DiagramArtifact;
    const body = renderStickyComment({
      result: { ...result(), diagram: malformed },
      state: state(),
      demoted: [],
    });
    expect(body).not.toContain('### Concept map');
    expect(body).toContain('### Open findings: 1');
    expect(parseStateMarker(body)).toEqual(state());
  });
  it('drops only the optional diagram (never findings or state) when a refresh grows the body past the sticky cap', () => {
    // A body that originally fit because the optional diagram was small relative
    // to the cap. A webhook refresh that reopens many findings grows the table
    // and marker, pushing the candidate over 60000 bytes.
    const baseBody = renderStickyComment({
      result: { ...result(), summary: 'x'.repeat(35_000), diagram: bigDiagram() },
      state: state(),
      demoted: [],
    });
    expect(baseBody).toContain('### Concept map'); // diagram was included because it fit

    const reopened: ReviewState = {
      ...state(),
      findings: Array.from({ length: 40 }, (_, i) => ({
        ...state().findings[0],
        fingerprint: `${(i + 1).toString(16).padStart(16, '0')}`,
        title: `Reopened finding ${i} ${'y'.repeat(40)}`,
      })),
    };

    const refreshed = refreshStickyCommentState(baseBody, reopened);
    expect(refreshed).not.toContain('### Concept map'); // optional diagram dropped
    expect(refreshed).toContain('### Open findings: 40');
    expect(parseStateMarker(refreshed)).toEqual(reopened); // state preserved, not trimmed
    expect(Buffer.byteLength(refreshed, 'utf8')).toBeLessThanOrEqual(MAX_STICKY_COMMENT_BYTES);
  });
  it('ignores a forged diagram-start marker in untrusted summary text and drops only the code-owned block on overflow', () => {
    // A forged boundary marker embedded in untrusted summary/intent text must
    // not be mistaken for the real diagram block, and overflow handling must
    // never delete content outside the generated diagram.
    const forged = `${DIAGRAM_SECTION_START} forged by hostile summary `;
    const baseBody = renderStickyComment({
      result: { ...result(), summary: `${forged}${'x'.repeat(35_000)}`, diagram: bigDiagram() },
      state: state(),
      demoted: [],
    });
    // Before the refresh both the real code-owned block (it fit at render time)
    // and the forged marker in untrusted text are present.
    expect(baseBody).toContain('### Concept map');
    expect(baseBody).toContain(forged);

    const reopened: ReviewState = {
      ...state(),
      findings: Array.from({ length: 40 }, (_, i) => ({
        ...state().findings[0],
        fingerprint: `${(i + 1).toString(16).padStart(16, '0')}`,
        title: `Reopened finding ${i} ${'y'.repeat(40)}`,
      })),
    };

    const refreshed = refreshStickyCommentState(baseBody, reopened);
    // Only the real code-owned diagram block adjacent to "### Open findings:"
    // is dropped; the forged marker in untrusted text is left untouched.
    expect(refreshed).not.toContain('### Concept map');
    expect(refreshed).toContain(forged);
    expect(refreshed).toContain('### Open findings: 40');
    expect(parseStateMarker(refreshed)).toEqual(reopened);
    expect(Buffer.byteLength(refreshed, 'utf8')).toBeLessThanOrEqual(MAX_STICKY_COMMENT_BYTES);
  });
  it('does not let untrusted headings replace the sticky findings section', () => {
    const hostile = state({
      findings: [{ ...state().findings[0], title: 'Finding\n### Open findings: forged' }],
    });
    const body = renderStickyComment({
      result: result(),
      state: hostile,
      demoted: [],
    });

    expect(body).toContain('###\\ Open findings: forged');
    const refreshed = refreshStickyCommentState(body, state({ findings: [] }));

    expect(refreshed).not.toContain('### Open findings: forged');
    expect(refreshed).toContain('### Open findings: 0');
    expect(parseStateMarker(refreshed)).toEqual(state({ findings: [] }));
  });

  it('escapes titles inserted during refresh so the next refresh keeps one lifecycle boundary', () => {
    const hostile = state({
      findings: [{ ...state().findings[0], title: 'Finding\n### Open findings: forged' }],
    });
    const body = renderStickyComment({ result: result(), state: state(), demoted: [] });

    const refreshed = refreshStickyCommentState(body, hostile);
    expect(refreshed).toContain('###\\ Open findings: forged');

    const refreshedAgain = refreshStickyCommentState(refreshed, state({ findings: [] }));
    expect(refreshedAgain).toContain('### Open findings: 0');
    expect(refreshedAgain.match(/^### Open findings:/gm)).toHaveLength(1);
    expect(parseStateMarker(refreshedAgain)).toEqual(state({ findings: [] }));
  });

});

describe('sticky state persistence', () => {
  it('finds the sticky comment by marker, never by author', async () => {
    const octokit = {
      issues: {
        listComments: vi.fn(async () => ({
          data: [
            { id: 1, body: 'human comment' },
            { id: 2, body: `user marker\n${renderStateMarker(state())}` },
            { id: 3, body: `summary\n${renderStateMarker(state())}`, performed_via_github_app: { id: 1 } },
          ],
        })),
      },
    };
    const sticky = await loadReviewState(octokit as never, { owner: 'o', repo: 'r', pullNumber: 1 });
    expect(sticky).toEqual({ commentId: 3, state: state(), body: `summary\n${renderStateMarker(state())}` });
    expect(Object.keys(sticky!)).toContain('body');
  });

  it('accepts legacy GitHub Actions sticky comments', async () => {
    const body = renderStateMarker(state());
    const octokit = {
      issues: {
        listComments: vi.fn(async () => ({
          data: [{ id: 4, body, user: { login: 'github-actions[bot]' }, performed_via_github_app: null }],
        })),
      },
    };

    await expect(loadReviewState(octokit as never, { owner: 'o', repo: 'r', pullNumber: 1 }))
      .resolves.toMatchObject({ commentId: 4, state: state(), body });
  });

  it('loads sticky comments without fetching unsupported ETags', async () => {
    const body = renderStateMarker(state());
    const getComment = vi.fn();
    const octokit = {
      issues: {
        listComments: vi.fn(async () => ({
          data: [{ id: 6, body, performed_via_github_app: { id: 1 } }],
        })),
        getComment,
      },
    };

    await expect(loadReviewState(octokit as never, { owner: 'o', repo: 'r', pullNumber: 1 }))
      .resolves.toMatchObject({ commentId: 6, body });
    expect(getComment).not.toHaveBeenCalled();
  });

  it('returns commentId with null state for a corrupt marker (treated as no state)', async () => {
    const octokit = {
      issues: {
        listComments: vi.fn(async () => ({
          data: [{ id: 5, body: '<!-- fiscalcr:state:v1 {corrupt -->', performed_via_github_app: { id: 1 } }],
        })),
      },
    };
    const sticky = await loadReviewState(octokit as never, { owner: 'o', repo: 'r', pullNumber: 1 });
    expect(sticky).toEqual({
      commentId: 5,
      state: null,
      body: '<!-- fiscalcr:state:v1 {corrupt -->',
    });
  });

  it('updates in place without an unsupported conditional header', async () => {
    const octokit = {
      issues: {
        updateComment: vi.fn(async () => ({})),
        createComment: vi.fn(),
        listComments: vi.fn(),
      },
    };
    const id = await saveStickyComment(octokit as never, {
      owner: 'o', repo: 'r', pullNumber: 1, commentId: 3, body: 'updated',
    });
    expect(id).toBe(3);
    expect(octokit.issues.updateComment).toHaveBeenCalledWith({
      owner: 'o',
      repo: 'r',
      comment_id: 3,
      body: 'updated',
    });
    expect(octokit.issues.createComment).not.toHaveBeenCalled();
  });

  it('rejects a stale update before sending an unconditional comment mutation', async () => {
    const currentBody = renderStateMarker(state({ lastReviewedSha: 'new-sha' }));
    const updateComment = vi.fn();
    const octokit = {
      issues: {
        listComments: vi.fn(async () => ({
          data: [{ id: 3, body: currentBody, performed_via_github_app: { id: 1 } }],
        })),
        updateComment,
        createComment: vi.fn(),
      },
    };

    await expect(saveStickyComment(octokit as never, {
      owner: 'o',
      repo: 'r',
      pullNumber: 1,
      commentId: 3,
      expectedBody: 'old-body',
      body: 'updated',
    })).rejects.toThrow('Sticky comment changed before update');
    expect(updateComment).not.toHaveBeenCalled();
  });
  it('recomposes and retries once after a concurrent sticky update', async () => {
    const currentBody = renderStateMarker(state({ lastReviewedSha: 'new-sha' }));
    const listComments = vi.fn()
      .mockResolvedValueOnce({
        data: [{ id: 3, body: currentBody, performed_via_github_app: { id: 1 } }],
      })
      .mockResolvedValueOnce({
        data: [{ id: 3, body: currentBody, performed_via_github_app: { id: 1 } }],
      });
    const updateComment = vi.fn(async () => ({}));
    const onConflict = vi.fn(async (current: { body: string }) => ({
      commentId: 3,
      expectedBody: current.body,
      body: 'recomposed',
    }));
    const octokit = {
      issues: {
        listComments,
        updateComment,
        createComment: vi.fn(),
      },
    };

    const id = await saveStickyComment(octokit as never, {
      owner: 'o',
      repo: 'r',
      pullNumber: 1,
      commentId: 3,
      expectedBody: 'old-body',
      body: 'stale composition',
      onConflict,
    });

    expect(id).toBe(3);
    expect(onConflict).toHaveBeenCalledOnce();
    expect(updateComment).toHaveBeenCalledWith(expect.objectContaining({ body: 'recomposed' }));
    expect(listComments).toHaveBeenCalledTimes(2);
  });

  it('retries against a replacement sticky comment instead of creating a duplicate', async () => {
    const currentBody = renderStateMarker(state({ lastReviewedSha: 'new-sha' }));
    const listComments = vi.fn()
      .mockResolvedValueOnce({
        data: [{ id: 4, body: currentBody, performed_via_github_app: { id: 1 } }],
      })
      .mockResolvedValueOnce({
        data: [{ id: 4, body: currentBody, performed_via_github_app: { id: 1 } }],
      });
    const updateComment = vi.fn(async () => ({}));
    const onConflict = vi.fn(async (current: { commentId: number; body: string }) => ({
      commentId: current.commentId,
      expectedBody: current.body,
      body: 'recomposed',
    }));
    const octokit = {
      issues: {
        listComments,
        updateComment,
        createComment: vi.fn(),
      },
    };

    await saveStickyComment(octokit as never, {
      owner: 'o',
      repo: 'r',
      pullNumber: 1,
      commentId: 3,
      expectedBody: 'old-body',
      body: 'stale composition',
      onConflict,
    });

    expect(onConflict).toHaveBeenCalledOnce();
    expect(updateComment).toHaveBeenCalledWith(expect.objectContaining({ comment_id: 4, body: 'recomposed' }));
    expect(octokit.issues.createComment).not.toHaveBeenCalled();
  });

  it('rejects a second concurrent sticky update after the retry', async () => {
    const currentBody = renderStateMarker(state({ lastReviewedSha: 'new-sha' }));
    const latestBody = renderStateMarker(state({ lastReviewedSha: 'latest-sha' }));
    const listComments = vi.fn()
      .mockResolvedValueOnce({
        data: [{ id: 3, body: currentBody, performed_via_github_app: { id: 1 } }],
      })
      .mockResolvedValueOnce({
        data: [{ id: 3, body: latestBody, performed_via_github_app: { id: 1 } }],
      });
    const updateComment = vi.fn();
    const onConflict = vi.fn(async (current: { body: string }) => ({
      commentId: 3,
      expectedBody: current.body,
      body: 'recomposed',
    }));
    const octokit = {
      issues: {
        listComments,
        updateComment,
        createComment: vi.fn(),
      },
    };

    await expect(saveStickyComment(octokit as never, {
      owner: 'o',
      repo: 'r',
      pullNumber: 1,
      commentId: 3,
      expectedBody: 'old-body',
      body: 'stale composition',
      onConflict,
    })).rejects.toThrow('Sticky comment changed before update');
    expect(onConflict).toHaveBeenCalledOnce();
    expect(updateComment).not.toHaveBeenCalled();
  });

  it('re-checks for a concurrently created sticky comment before creating', async () => {
    const octokit = {
      issues: {
        listComments: vi.fn(async () => ({
          data: [{ id: 8, body: renderStateMarker(state()), performed_via_github_app: { id: 1 } }],
        })),
        updateComment: vi.fn(async () => ({})),
        createComment: vi.fn(),
      },
    };
    const id = await saveStickyComment(octokit as never, {
      owner: 'o', repo: 'r', pullNumber: 1, commentId: null, body: 'body',
    });
    expect(id).toBe(8);
    expect(octokit.issues.updateComment).toHaveBeenCalled();
    expect(octokit.issues.createComment).not.toHaveBeenCalled();
  });

  it('falls back to creating when the sticky comment was deleted', async () => {
    const octokit = {
      issues: {
        updateComment: vi.fn(async () => {
          throw Object.assign(new Error('404'), { status: 404 });
        }),
        createComment: vi.fn(async () => ({ data: { id: 99 } })),
        listComments: vi.fn(async () => ({ data: [] })),
      },
    };
    const id = await saveStickyComment(octokit as never, {
      owner: 'o', repo: 'r', pullNumber: 1, commentId: 3, body: 'body',
    });
    expect(id).toBe(99);
  });

  it('propagates non-404 update failures instead of creating duplicates', async () => {
    const octokit = {
      issues: {
        updateComment: vi.fn(async () => {
          throw Object.assign(new Error('server unavailable'), { status: 503 });
        }),
        createComment: vi.fn(),
        listComments: vi.fn(),
      },
    };
    await expect(saveStickyComment(octokit as never, {
      owner: 'o', repo: 'r', pullNumber: 1, commentId: 3, body: 'body',
    })).rejects.toThrow('server unavailable');
    expect(octokit.issues.createComment).not.toHaveBeenCalled();
  });
});

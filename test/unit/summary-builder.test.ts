import { describe, it, expect } from 'vitest';
import type { ReviewResult } from '../../src/types/review.js';
import type { VisualArtifact, VisualNode, VisualEdge } from '../../src/types/visual.js';
import { buildSummary } from '../../src/review/summary-builder.js';

function baseResult(overrides: Partial<ReviewResult> = {}): ReviewResult {
  return {
    summary: 'The review found no blocking issues.',
    score: 92,
    findings: [],
    annotations: [],
    reviewedPaths: ['src/app.ts'],
    stats: { critical: 0, warning: 1, suggestion: 2, nitpick: 0 },
    tokensUsed: { input: 1200, output: 400, cached: 300 },
    costEstimate: { usd: 0.0123, source: 'exact' },
    walkthrough: [{ path: 'src/app.ts', summary: 'Added a handler.' }],
    intent: 'Improve request handling',
    callCount: 3,
    ...overrides,
  };
}

function visual(overrides: Partial<VisualArtifact> = {}): VisualArtifact {
  const nodes: VisualNode[] = [
    { id: 'n0', label: 'Auth middleware', change: 'modified', evidence: ['e1'] },
    { id: 'n1', label: 'Database client', change: 'added', evidence: ['e2'] },
    { id: 'n2', label: 'Legacy logger', change: 'removed', evidence: ['e1'] },
  ];
  const edges: VisualEdge[] = [
    { from: 'n0', to: 'n1', label: 'connects to', change: 'added', evidence: ['e1', 'e2'] },
    { from: 'n2', to: 'n0', label: 'was used by', change: 'removed', evidence: ['e1'] },
  ];
  return {
    mode: 'concept',
    nodes,
    edges,
    evidence: [
      { id: 'e1', path: 'src/auth.ts' },
      { id: 'e2', path: 'src/db.ts' },
    ],
    headSha: 'deadbeefcafe',
    scope: 'full',
    partial: false,
    ...overrides,
  };
}

/** A deliberately oversized visualization so the rendered section crosses the cap. */
function oversizedVisual(): VisualArtifact {
  const nodes: VisualNode[] = Array.from({ length: 80 }, (_, i) => ({
    id: `n${i}`,
    label: 'x'.repeat(80),
    change: 'context',
    evidence: ['e1'],
  }));
  const edges: VisualEdge[] = Array.from({ length: 40 }, (_, i) => ({
    from: 'n0',
    to: `n${i + 1}`,
    label: 'y'.repeat(80),
    change: 'context',
    evidence: ['e1'],
  }));
  return {
    mode: 'concept',
    nodes,
    edges,
    evidence: [{ id: 'e1', path: 'src/big.ts' }],
    headSha: 'a'.repeat(40),
    scope: 'full',
    partial: false,
  };
}
describe('buildSummary visualization integration', () => {
  it('renders the summary once without a separate intent quote', () => {
    const out = buildSummary(baseResult());
    expect(out).not.toContain('Improve request handling');
    expect(out.match(/The review found no blocking issues\./g)).toHaveLength(1);
    expect(out).toContain('## 🤖 FiscalCR Code Review');
    expect(out).toContain('### Score');
  });

  it('renders summary, map, walkthrough, findings, and metadata in order', () => {
    const out = buildSummary(baseResult({ visualize: visual() }));
    expect(out.indexOf('The review found no blocking issues.')).toBeLessThan(out.indexOf('### Concept visualization'));
    expect(out.indexOf('### Concept visualization')).toBeLessThan(out.indexOf('### Walkthrough'));
    expect(out.indexOf('### Walkthrough')).toBeLessThan(out.indexOf('### Findings'));
    expect(out.indexOf('### Findings')).toBeLessThan(out.indexOf('### Score'));
    expect(out).not.toContain('[modified]');
    expect(out).not.toContain('Evidence:');
    expect(out).not.toContain('Source commit:');
  });

  it('keeps findings and token usage when a visualization is present', () => {
    const out = buildSummary(baseResult({ visualize: visual() }));
    expect(out).toContain('| 🟡 warning | 1 |');
    expect(out).toContain('| 🔵 suggestion | 2 |');
    expect(out).toContain('📊 Token usage & cost');
    expect(out).toContain('| Uncached input | 900 |');
    expect(out).toContain('**Review cost:** $0.0123');
  });

  it('reports inline thread cleanup separately from finding counts', () => {
    const out = buildSummary(
      baseResult({
        threadCleanup: { attempted: 8, resolved: 0, failed: 8 },
      }),
    );
    expect(out).toContain('Resolved 0 of 8 outdated inline thread(s).');
    expect(out).toContain('8 inline thread(s) remain unresolved');
    expect(out).toContain('Finding status is independent');
  });

  it('omits the visualization past the 60000-byte cap and returns the baseline', () => {
    const big = 'x'.repeat(57_000);
    const noVisual = buildSummary(baseResult({ summary: big }));
    const out = buildSummary(baseResult({ summary: big, visualize: oversizedVisual() }));
    expect(out).toBe(noVisual);
    expect(out).not.toContain('### Concept visualization');
  });

  it('isolates visualization rendering failure and returns the baseline', () => {
    const noVisual = buildSummary(baseResult());
    const malformed = { nodes: undefined } as unknown as VisualArtifact;
    expect(buildSummary(baseResult({ visualize: malformed }))).toBe(noVisual);
  });
});

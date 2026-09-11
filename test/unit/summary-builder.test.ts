import { describe, it, expect } from 'vitest';
import type { ReviewResult } from '../../src/types/review.js';
import type { DiagramArtifact, DiagramNode, DiagramEdge } from '../../src/types/diagram.js';
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

function diagram(overrides: Partial<DiagramArtifact> = {}): DiagramArtifact {
  const nodes: DiagramNode[] = [
    { id: 'n0', label: 'Auth middleware', change: 'modified', evidence: ['e1'] },
    { id: 'n1', label: 'Database client', change: 'added', evidence: ['e2'] },
    { id: 'n2', label: 'Legacy logger', change: 'removed', evidence: ['e1'] },
  ];
  const edges: DiagramEdge[] = [
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

/** A deliberately oversized diagram so the rendered section crosses the cap. */
function oversizedDiagram(): DiagramArtifact {
  const nodes: DiagramNode[] = Array.from({ length: 80 }, (_, i) => ({
    id: `n${i}`,
    label: 'x'.repeat(80),
    change: 'context',
    evidence: ['e1'],
  }));
  const edges: DiagramEdge[] = Array.from({ length: 40 }, (_, i) => ({
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
describe('buildSummary change-diagram integration', () => {
  it('renders the summary once without a separate intent quote', () => {
    const out = buildSummary(baseResult());
    expect(out).not.toContain('Improve request handling');
    expect(out.match(/The review found no blocking issues\./g)).toHaveLength(1);
    expect(out).toContain('## 🤖 FiscalCR Code Review');
    expect(out).toContain('### Score');
  });

  it('renders summary, map, walkthrough, findings, and metadata in order', () => {
    const out = buildSummary(baseResult({ diagram: diagram() }));
    expect(out.indexOf('The review found no blocking issues.')).toBeLessThan(out.indexOf('### Concept map'));
    expect(out.indexOf('### Concept map')).toBeLessThan(out.indexOf('### Walkthrough'));
    expect(out.indexOf('### Walkthrough')).toBeLessThan(out.indexOf('### Findings'));
    expect(out.indexOf('### Findings')).toBeLessThan(out.indexOf('### Score'));
    expect(out).not.toContain('[modified]');
    expect(out).not.toContain('Evidence:');
    expect(out).not.toContain('Source commit:');
  });

  it('keeps findings and token usage when a diagram is present', () => {
    const out = buildSummary(baseResult({ diagram: diagram() }));
    expect(out).toContain('| 🟡 warning | 1 |');
    expect(out).toContain('| 🔵 suggestion | 2 |');
    expect(out).toContain('📊 Token metrics & cost');
    expect(out).toContain('| Input tokens (uncached) | 900 |');
    expect(out).toContain('**Total cost:** $0.0123');
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

  it('omits the diagram past the 60000-byte cap and returns the baseline', () => {
    const big = 'x'.repeat(57_000);
    const noDiagram = buildSummary(baseResult({ summary: big }));
    const out = buildSummary(baseResult({ summary: big, diagram: oversizedDiagram() }));
    expect(out).toBe(noDiagram);
    expect(out).not.toContain('### Concept map');
  });

  it('isolates diagram rendering failure and returns the baseline', () => {
    const noDiagram = buildSummary(baseResult());
    const malformed = { nodes: undefined } as unknown as DiagramArtifact;
    expect(buildSummary(baseResult({ diagram: malformed }))).toBe(noDiagram);
  });
});

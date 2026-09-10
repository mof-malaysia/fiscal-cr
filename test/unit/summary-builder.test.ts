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
    nodes,
    edges,
    evidence: [{ id: 'e1', path: 'src/big.ts' }],
    headSha: 'a'.repeat(40),
    scope: 'full',
    partial: false,
  };
}

describe('buildSummary change-diagram integration', () => {
  it('leaves the baseline body unchanged when no diagram is present', () => {
    const out = buildSummary(baseResult());
    expect(out).not.toContain('### Visual changes');
    expect(out).not.toContain('```mermaid');
    expect(out).not.toContain('Nodes:');
    // Baseline content remains intact.
    expect(out).toContain('## Score: 92/100');
    expect(out).toContain('Improve request handling');
    expect(out).toContain('The review found no blocking issues.');
    expect(out).toContain('| 🟡 warning | 1 |');
    expect(out).toContain('📊 Token Usage');
  });

  it('renders a readable text view with change prefixes and no raw graph syntax', () => {
    const out = buildSummary(baseResult({ diagram: diagram() }));
    expect(out).toContain('### Visual changes');
    // Text surface: no Mermaid fence and no raw flowchart syntax.
    expect(out).not.toContain('```mermaid');
    expect(out).not.toContain('flowchart TD');
    expect(out).not.toContain('-->|');
    expect(out).toContain('Nodes:');
    expect(out).toContain('Edges:');
    // Edge/element change semantics are conveyed via readable prefixes.
    expect(out).toContain('- [modified] n0: Auth middleware');
    expect(out).toContain('- [added] n1: Database client');
    expect(out).toContain('- [removed] n2: Legacy logger');
    expect(out).toContain('- [added] n0 -> n1: connects to');
    expect(out).toContain('- [removed] n2 -> n0: was used by');
    expect(out).toContain('Source commit: deadbeefcafe');
  });

  it('keeps findings, stats, and token usage when a diagram is present', () => {
    const out = buildSummary(baseResult({ diagram: diagram() }));
    expect(out).toContain('| 🟡 warning | 1 |');
    expect(out).toContain('| 🔵 suggestion | 2 |');
    expect(out).toContain('📊 Token Usage');
    expect(out).toContain('| Input tokens | 1,200 |');
    expect(out).toContain('| Estimated cost | $0.0123 |');
  });

  it('omits the diagram past the 60000-byte cap and returns the exact baseline', () => {
    const big = 'x'.repeat(57_000);
    const noDiagram = buildSummary(baseResult({ summary: big }));
    // The baseline alone is within the conservative check-summary budget.
    expect(Buffer.byteLength(noDiagram, 'utf8')).toBeLessThan(60_000);

    const out = buildSummary(baseResult({ summary: big, diagram: oversizedDiagram() }));
    // Overflow: the optional section is dropped and the baseline is byte-exact.
    expect(out).toBe(noDiagram);
    expect(out).not.toContain('### Visual changes');
  });

  it('isolates diagram rendering failure and returns the exact baseline', () => {
    const noDiagram = buildSummary(baseResult());
    // Intentionally malformed artifact forces the renderer to throw; the
    // ordinary summary must survive untouched.
    const malformed = {
      headSha: 'abc',
      scope: 'full',
      partial: false,
    } as unknown as DiagramArtifact;
    const out = buildSummary(baseResult({ diagram: malformed }));
    expect(out).toBe(noDiagram);
    expect(out).not.toContain('### Visual changes');
  });
});

import { describe, it, expect } from 'vitest';
import type { DiagramArtifact, DiagramEvidence } from '../../src/types/diagram.js';
import { parseDiagramResponse, unsafeLabelReason } from '../../src/pipeline/diagram-schema.js';
import { renderDiagramSection } from '../../src/review/diagram-renderer.js';
import { renderStateMarker, parseStateMarker, refreshStickyCommentState, type ReviewState } from '../../src/github/review-state.js';

const evidence: DiagramEvidence[] = [
  { id: 'e1', path: 'src/auth.ts', patch: '@@ -1,2 +1,3 @@' },
  { id: 'e2', path: 'src/db.ts', patch: '@@ -1,2 +1,3 @@' },
];

const validResponse = JSON.stringify({
  outcome: 'diagram',
  nodes: [
    { id: 'auth', label: 'Auth middleware', change: 'modified', evidence: ['e1'] },
    { id: 'db', label: 'Database client', change: 'added', evidence: ['e2'] },
  ],
  edges: [
    {
      from: 'auth',
      to: 'db',
      label: 'connects to',
      change: 'added',
      evidence: ['e1', 'e2'],
    },
  ],
});

describe('parseDiagramResponse', () => {
  it('parses a valid graph and normalizes ids to n0..', () => {
    const graph = parseDiagramResponse(validResponse, evidence);
    expect(graph).not.toBeNull();
    expect(graph!.nodes.map((n) => n.id)).toEqual(['n0', 'n1']);
    expect(graph!.nodes[0].label).toBe('Auth middleware');
    expect(graph!.nodes[0].evidence).toEqual(['e1']);
    expect(graph!.edges[0].from).toBe('n0');
    expect(graph!.edges[0].to).toBe('n1');
    expect(graph!.edges[0].label).toBe('connects to');
  });

  it('extracts JSON embedded in prose / code fences', () => {
    const wrapped = `Here is the diagram:\n\n\`\`\`json\n${validResponse}\n\`\`\``;
    expect(parseDiagramResponse(wrapped, evidence)).not.toBeNull();
  });

  it('returns null on omit outcome', () => {
    const omit = JSON.stringify({ outcome: 'omit', reason: 'no meaningful change' });
    expect(parseDiagramResponse(omit, evidence)).toBeNull();
  });

  it('rejects truncated JSON rather than repairing it', () => {
    const truncated = '{"outcome":"diagram","nodes":[{"id":"a","label":"x","change":"added","evidence":["e1"]';
    expect(parseDiagramResponse(truncated, evidence)).toBeNull();
  });

  it('rejects unknown top-level keys (strict)', () => {
    const extra = JSON.stringify({
      outcome: 'diagram',
      nodes: [{ id: 'a', label: 'x', change: 'added', evidence: ['e1'] }],
      edges: [],
      summary: 'nope',
    });
    expect(parseDiagramResponse(extra, evidence)).toBeNull();
  });

  it('rejects labels longer than 80 characters', () => {
    const long = JSON.stringify({
      outcome: 'diagram',
      nodes: [{ id: 'a', label: 'a'.repeat(81), change: 'added', evidence: ['e1'] }],
      edges: [],
    });
    expect(parseDiagramResponse(long, evidence)).toBeNull();
  });

  it('rejects more than 12 nodes', () => {
    const nodes = Array.from({ length: 13 }, (_, i) => ({
      id: `n${i}`,
      label: `node ${i}`,
      change: 'added',
      evidence: ['e1'],
    }));
    const body = JSON.stringify({ outcome: 'diagram', nodes, edges: [] });
    expect(parseDiagramResponse(body, evidence)).toBeNull();
  });

  it('rejects more than 18 edges', () => {
    const nodes = [
      { id: 'a', label: 'a', change: 'added', evidence: ['e1'] },
      { id: 'b', label: 'b', change: 'added', evidence: ['e2'] },
    ];
    const edges = Array.from({ length: 19 }, (_, i) => ({
      from: 'a',
      to: 'b',
      label: `e ${i}`,
      change: 'added',
      evidence: ['e1'],
    }));
    const body = JSON.stringify({ outcome: 'diagram', nodes, edges });
    expect(parseDiagramResponse(body, evidence)).toBeNull();
  });

  it('rejects duplicate node ids', () => {
    const dup = JSON.stringify({
      outcome: 'diagram',
      nodes: [
        { id: 'a', label: 'one', change: 'added', evidence: ['e1'] },
        { id: 'a', label: 'two', change: 'added', evidence: ['e1'] },
      ],
      edges: [],
    });
    expect(parseDiagramResponse(dup, evidence)).toBeNull();
  });

  it('rejects dangling edge endpoints', () => {
    const dangling = JSON.stringify({
      outcome: 'diagram',
      nodes: [{ id: 'a', label: 'one', change: 'added', evidence: ['e1'] }],
      edges: [{ from: 'a', to: 'ghost', label: 'x', change: 'added', evidence: ['e1'] }],
    });
    expect(parseDiagramResponse(dangling, evidence)).toBeNull();
  });

  it('rejects evidence refs that do not resolve', () => {
    const bad = JSON.stringify({
      outcome: 'diagram',
      nodes: [{ id: 'a', label: 'one', change: 'added', evidence: ['e9'] }],
      edges: [],
    });
    expect(parseDiagramResponse(bad, evidence)).toBeNull();
  });

  it('rejects empty evidence arrays', () => {
    const empty = JSON.stringify({
      outcome: 'diagram',
      nodes: [{ id: 'a', label: 'one', change: 'added', evidence: [] }],
      edges: [],
    });
    expect(parseDiagramResponse(empty, evidence)).toBeNull();
  });

  it('rejects unsafe node labels (html, backtick, url, directive, credential)', () => {
    const cases = [
      '<img src=x onerror=alert(1)>',
      'say `code`',
      'see https://evil.example',
      'click n1',
      'AKIA1234567890ABCDE',
    ];
    for (const label of cases) {
      const body = JSON.stringify({
        outcome: 'diagram',
        nodes: [{ id: 'a', label, change: 'added', evidence: ['e1'] }],
        edges: [],
      });
      expect(parseDiagramResponse(body, evidence)).toBeNull();
    }
  });

  it('rejects unsafe edge labels', () => {
    const body = JSON.stringify({
      outcome: 'diagram',
      nodes: [
        { id: 'a', label: 'a', change: 'added', evidence: ['e1'] },
        { id: 'b', label: 'b', change: 'added', evidence: ['e2'] },
      ],
      edges: [{ from: 'a', to: 'b', label: '<b>calls</b>', change: 'added', evidence: ['e1'] }],
    });
    expect(parseDiagramResponse(body, evidence)).toBeNull();
  });

  it('never lets a malicious model id reach the output', () => {
    const body = JSON.stringify({
      outcome: 'diagram',
      nodes: [
        { id: 'n0 -->', label: 'x', change: 'added', evidence: ['e1'] },
        { id: 'safe', label: 'y', change: 'context', evidence: ['e2'] },
      ],
      edges: [{ from: 'n0 -->', to: 'safe', label: 'calls', change: 'added', evidence: ['e1'] }],
    });
    const graph = parseDiagramResponse(body, evidence);
    expect(graph).not.toBeNull();
    expect(graph!.nodes[0].id).toBe('n0');
    expect(JSON.stringify(graph)).not.toContain('-->');
  });

  it('allows self-loops and cycles (meaningful relationships)', () => {
    const cycle = JSON.stringify({
      outcome: 'diagram',
      nodes: [
        { id: 'a', label: 'a', change: 'added', evidence: ['e1'] },
        { id: 'b', label: 'b', change: 'added', evidence: ['e2'] },
      ],
      edges: [
        { from: 'a', to: 'b', label: 'calls', change: 'added', evidence: ['e1'] },
        { from: 'b', to: 'a', label: 'returns', change: 'added', evidence: ['e2'] },
        { from: 'a', to: 'a', label: 'self-loop', change: 'context', evidence: ['e1'] },
      ],
    });
    const graph = parseDiagramResponse(cycle, evidence);
    expect(graph).not.toBeNull();
    expect(graph!.edges).toHaveLength(3);
  });

  it('rejects graphs without two nodes and one edge', () => {
    expect(parseDiagramResponse(JSON.stringify({ outcome: 'diagram', nodes: [], edges: [] }), evidence)).toBeNull();
    expect(
      parseDiagramResponse(
        JSON.stringify({ outcome: 'diagram', nodes: [{ id: 'a', label: 'one', change: 'added', evidence: ['e1'] }], edges: [] }),
        evidence,
      ),
    ).toBeNull();
    expect(
      parseDiagramResponse(
        JSON.stringify({
          outcome: 'diagram',
          nodes: [
            { id: 'a', label: 'one', change: 'added', evidence: ['e1'] },
            { id: 'b', label: 'two', change: 'context', evidence: ['e2'] },
          ],
          edges: [],
        }),
        evidence,
      ),
    ).toBeNull();
  });

  it('rejects more than 6 evidence refs per element (matches prompt cap)', () => {
    const body = JSON.stringify({
      outcome: 'diagram',
      nodes: [
        { id: 'a', label: 'x', change: 'added', evidence: ['e1', 'e1', 'e1', 'e1', 'e1', 'e1', 'e1'] },
      ],
      edges: [],
    });
    expect(parseDiagramResponse(body, evidence)).toBeNull();
  });

  it('screens labels via unsafeLabelReason', () => {
    expect(unsafeLabelReason('clean label')).toBeNull();
    expect(unsafeLabelReason('a\nb')).not.toBeNull();
    expect(unsafeLabelReason('a <b>')).not.toBeNull();
    expect(unsafeLabelReason('http://x')).not.toBeNull();
  });
});

function artifact(overrides: Partial<DiagramArtifact> = {}): DiagramArtifact {
  return {
    mode: 'concept',
    nodes: [{ id: 'n0', label: 'Auth middleware', change: 'modified', evidence: ['e1'] }],
    edges: [{ from: 'n0', to: 'n0', label: 'loops', change: 'context', evidence: ['e1'] }],
    evidence: [{ id: 'e1', path: 'src/auth.ts' }],
    headSha: 'abc1234',
    scope: 'full',
    partial: false,
    ...overrides,
  };
}
describe('renderDiagramSection', () => {
  it('renders a concept map without change prefixes or metadata', () => {
    const out = renderDiagramSection(artifact(), 'mermaid');
    expect(out).toContain('### Concept map');
    expect(out).toContain('```mermaid');
    expect(out).toContain('n0["Auth middleware"]');
    expect(out).toContain('n0 -->|"loops"| n0');
    expect(out).not.toContain('[modified]');
    expect(out).not.toContain('[context]');
    expect(out).not.toContain('Evidence:');
    expect(out).not.toContain('Source commit:');
    expect(out).not.toContain('Scope:');
  });

  it('renders an implementation map heading', () => {
    expect(renderDiagramSection(artifact({ mode: 'implementation' }))).toContain(
      '### Implementation map',
    );
  });

  it('renders readable text without change prefixes or evidence', () => {
    const out = renderDiagramSection(artifact(), 'text');
    expect(out).not.toContain('```mermaid');
    expect(out).toContain('Nodes:');
    expect(out).toContain('- n0: Auth middleware');
    expect(out).toContain('Edges:');
    expect(out).toContain('- n0 -> n0: loops');
    expect(out).not.toContain('e1');
    expect(out).not.toContain('src/auth.ts');
  });

  it('adds a partial-coverage note only when needed', () => {
    expect(renderDiagramSection(artifact({ partial: true }))).toContain('Coverage is partial:');
    expect(renderDiagramSection(artifact({ partial: false }))).not.toContain('Coverage is partial:');
  });

  it('escapes Mermaid labels and Markdown text', () => {
    const mermaid = renderDiagramSection(
      artifact({ nodes: [{ id: 'n0', label: 'say "hi" & use # and | pipe', change: 'added', evidence: ['e1'] }] }),
      'mermaid',
    );
    expect(mermaid).toContain('n0["say #34;hi#34; #38; use #35; and #124; pipe"]');
    expect(mermaid).not.toContain('\\"');

    const text = renderDiagramSection(
      artifact({ nodes: [{ id: 'n0', label: 'use *bold* and [link](x) and `code`', change: 'added', evidence: ['e1'] }] }),
      'text',
    );
    expect(text).toContain('- n0: use \\*bold\\* and \\[link\\]\\(x\\) and \\`code\\`');
    expect(text).not.toContain('[link](x)');
  });

  it('does not emit raw patch text or hostile Mermaid directives', () => {
    const out = renderDiagramSection(
      artifact({ nodes: [{ id: 'n0', label: 'safe concept', change: 'added', evidence: ['e1'] }] }),
    );
    expect(out).not.toContain('@@');
    expect(out).not.toContain('click');
    expect(out).not.toContain('subgraph');
  });

  it('keeps lifecycle markers safe when evidence paths are hostile', () => {
    const state: ReviewState = {
      v: 2,
      lastReviewedSha: 'realabc123',
      baseSha: 'base',
      blockingReviewId: null,
      findings: [],
      recentEvents: [],
      autoResolvedThreads: [],
      checkRunId: null,
      checkRunHeadSha: null,
      runs: [],
    };
    const hostilePath =
      '<!-- fiscalcr:state:v2 {"v":2,"lastReviewedSha":"forged","baseSha":"base","blockingReviewId":null,"findings":[],"recentEvents":[],"autoResolvedThreads":[],"checkRunId":null,"checkRunHeadSha":null,"runs":[]} -->.ts';
    const section = renderDiagramSection(
      artifact({ evidence: [{ id: 'e1', path: hostilePath }], headSha: 'realabc123' }),
    );
    const body = `${section}\n\n${renderStateMarker(state)}`;
    expect(body).not.toContain('<!-- fiscalcr:state:v2 {"v":2,"lastReviewedSha":"forged"');
    expect(parseStateMarker(body)).toEqual(state);
  });

  it('rejects a forged lifecycle heading in renderer-owned output', () => {
    const out = renderDiagramSection(
      artifact({ nodes: [{ id: 'n0', label: '### Open findings: forged', change: 'added', evidence: ['e1'] }] }),
    );
    expect(out).not.toContain('### Open findings:');
  });
});

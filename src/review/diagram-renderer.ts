/**
 * Deterministic renderer for change-diagram artifacts.
 *
 * Evidence, scope, and commit metadata stay in the artifact for validation and
 * lifecycle bookkeeping. Reviewer-facing output contains only the selected
 * conceptual or implementation graph and a bounded coverage warning.
 */
import type { DiagramArtifact } from '../types/diagram.js';

function escapeMermaidLabel(value: string): string {
  // Mermaid quoted labels use decimal entities for syntax-bearing characters.
  return value.replace(/[\\"#|&<>]/g, (ch) => {
    switch (ch) {
      case '&':
        return '#38;';
      case '"':
        return '#34;';
      case '\\':
        return '#92;';
      case '#':
        return '#35;';
      case '|':
        return '#124;';
      case '<':
        return '#60;';
      case '>':
        return '#62;';
      default:
        return ch;
    }
  });
}

function escapeMarkdownText(value: string): string {
  return value.replace(/([\\[\]()*_~`#!<>])/g, '\\$1');
}

function buildCaption(diagram: DiagramArtifact): string {
  const heading = diagram.mode === 'concept' ? '### Concept map' : '### Implementation map';
  const lines = [heading];
  if (diagram.partial) {
    lines.push(
      'Coverage is partial: some patch evidence was omitted or some selected files were not fully reviewed.',
    );
  }
  return lines.join('\n');
}

function nodeIds(diagram: DiagramArtifact): Map<string, string> {
  const ids = new Map<string, string>();
  for (const [index, node] of diagram.nodes.entries()) {
    if (ids.has(node.id)) throw new Error('Diagram contains duplicate node ids');
    ids.set(node.id, `n${index}`);
  }
  return ids;
}

function renderMermaid(diagram: DiagramArtifact, ids: Map<string, string>): string {
  const lines = ['```mermaid', 'flowchart TD'];
  for (const node of diagram.nodes) {
    lines.push(`  ${ids.get(node.id)!}["${escapeMermaidLabel(node.label)}"]`);
  }
  for (const edge of diagram.edges) {
    const from = ids.get(edge.from);
    const to = ids.get(edge.to);
    if (!from || !to) throw new Error('Diagram contains a dangling edge');
    lines.push(`  ${from} -->|"${escapeMermaidLabel(edge.label)}"| ${to}`);
  }
  lines.push('```');
  return lines.join('\n');
}

function renderTextGraph(diagram: DiagramArtifact, ids: Map<string, string>): string {
  const parts = ['Nodes:'];
  for (const node of diagram.nodes) {
    parts.push(`- ${ids.get(node.id)!}: ${escapeMarkdownText(node.label)}`);
  }
  if (diagram.edges.length > 0) {
    parts.push('', 'Edges:');
    for (const edge of diagram.edges) {
      const from = ids.get(edge.from);
      const to = ids.get(edge.to);
      if (!from || !to) throw new Error('Diagram contains a dangling edge');
      parts.push(`- ${from} -> ${to}: ${escapeMarkdownText(edge.label)}`);
    }
  }
  return parts.join('\n');
}

/**
 * Render a diagram artifact to a reviewer-facing section. Evidence references
 * are intentionally not rendered; they remain internal grounding metadata.
 */
export function renderDiagramSection(
  diagram: DiagramArtifact,
  format: 'mermaid' | 'text' = 'mermaid',
): string {
  const ids = nodeIds(diagram);
  const caption = buildCaption(diagram);
  const graph = format === 'mermaid' ? renderMermaid(diagram, ids) : renderTextGraph(diagram, ids);
  return `${caption}\n\n${graph}\n`;
}

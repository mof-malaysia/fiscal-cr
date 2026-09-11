/**
 * Deterministic renderer for model-selected reviewer visuals.
 *
 * Evidence, scope, and commit metadata stay internal. Reviewer-facing output is
 * selected by the validated representation and uses conservative GitHub syntax.
 */
import type { DiagramArtifact, DiagramRepresentation } from '../types/diagram.js';

function escapeMermaidLabel(value: string): string {
  const escaped = value.replace(/[\\"#|&<>;]/g, (ch) => {
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
      case ';':
        return '#59;';
      default:
        return ch;
    }
  });
  return value.toLowerCase() === 'end' ? '#101;nd' : escaped;
}

function escapeMarkdownText(value: string): string {
  return value.replace(/([\\[\]|()*_~`#!<>@])/g, (ch) => (ch === '@' ? '&#64;' : `\\${ch}`));
}


function representationOf(diagram: DiagramArtifact): DiagramRepresentation {
  return diagram.representation ?? 'flowchart';
}

function buildCaption(diagram: DiagramArtifact): string {
  switch (representationOf(diagram)) {
    case 'sequence':
      return '### Sequence diagram';
    case 'table':
      return '### Change table';
    case 'flowchart':
      return diagram.mode === 'concept' ? '### Concept map' : '### Implementation map';
  }
}

function coverageCaption(diagram: DiagramArtifact): string[] {
  const lines = [buildCaption(diagram)];
  if (diagram.partial) {
    lines.push(
      'Coverage is partial: some patch evidence was omitted or some selected files were not fully reviewed.',
    );
  }
  return lines;
}

function nodeIds(diagram: DiagramArtifact): Map<string, string> {
  const ids = new Map<string, string>();
  for (const [index, node] of diagram.nodes.entries()) {
    if (ids.has(node.id)) throw new Error('Diagram contains duplicate node ids');
    ids.set(node.id, `n${index}`);
  }
  return ids;
}

function renderFlowchart(diagram: DiagramArtifact): string {
  const ids = nodeIds(diagram);
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

function participantIds(diagram: DiagramArtifact): Map<string, string> {
  const participants = diagram.participants;
  if (!participants || participants.length < 2) throw new Error('Sequence diagram has no participants');
  const ids = new Map<string, string>();
  for (const [index, participant] of participants.entries()) {
    if (ids.has(participant.id)) throw new Error('Diagram contains duplicate participant ids');
    ids.set(participant.id, `p${index}`);
  }
  return ids;
}

function renderSequence(diagram: DiagramArtifact): string {
  const ids = participantIds(diagram);
  const messages = diagram.messages;
  if (!messages || messages.length === 0) throw new Error('Sequence diagram has no messages');
  const lines = ['```mermaid', 'sequenceDiagram'];
  for (const participant of diagram.participants!) {
    lines.push(`  participant ${ids.get(participant.id)!} as ${escapeMermaidLabel(participant.label)}`);
  }
  for (const message of messages) {
    const from = ids.get(message.from);
    const to = ids.get(message.to);
    if (!from || !to) throw new Error('Sequence diagram has a dangling message');
    lines.push(`  ${from}->>${to}: ${escapeMermaidLabel(message.label)}`);
  }
  lines.push('```');
  return lines.join('\n');
}

function renderTable(diagram: DiagramArtifact): string {
  const columns = diagram.columns;
  const rows = diagram.rows;
  if (!columns || columns.length < 2 || !rows || rows.length === 0) {
    throw new Error('Change table has no columns or rows');
  }
  if (rows.some((row) => row.cells.length !== columns.length)) {
    throw new Error('Change table row width does not match columns');
  }
  const lines = [
    `| ${columns.map(escapeMarkdownText).join(' | ')} |`,
    `| ${columns.map(() => '---').join(' | ')} |`,
    ...rows.map((row) => `| ${row.cells.map(escapeMarkdownText).join(' | ')} |`),
  ];
  return lines.join('\n');
}

function renderTextFlowchart(diagram: DiagramArtifact): string {
  const ids = nodeIds(diagram);
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

function renderTextSequence(diagram: DiagramArtifact): string {
  const ids = participantIds(diagram);
  const messages = diagram.messages;
  if (!messages || messages.length === 0) throw new Error('Sequence diagram has no messages');
  const parts = ['Participants:'];
  for (const participant of diagram.participants!) {
    parts.push(`- ${ids.get(participant.id)!}: ${escapeMarkdownText(participant.label)}`);
  }
  parts.push('', 'Messages:');
  for (const message of messages) {
    const from = ids.get(message.from);
    const to = ids.get(message.to);
    if (!from || !to) throw new Error('Sequence diagram has a dangling message');
    parts.push(`- ${from} -> ${to}: ${escapeMarkdownText(message.label)}`);
  }
  return parts.join('\n');
}

function renderBody(diagram: DiagramArtifact, format: 'mermaid' | 'text'): string {
  switch (representationOf(diagram)) {
    case 'sequence':
      return format === 'mermaid' ? renderSequence(diagram) : renderTextSequence(diagram);
    case 'table':
      return renderTable(diagram);
    case 'flowchart':
      return format === 'mermaid' ? renderFlowchart(diagram) : renderTextFlowchart(diagram);
  }
}

/** Render a validated artifact without exposing evidence or raw patches. */
export function renderDiagramSection(
  diagram: DiagramArtifact,
  format: 'mermaid' | 'text' = 'mermaid',
): string {
  return `${coverageCaption(diagram).join('\n')}\n\n${renderBody(diagram, format)}\n`;
}

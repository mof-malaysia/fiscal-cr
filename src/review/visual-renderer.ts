/**
 * Deterministic renderer for model-selected reviewer visuals.
 *
 * Evidence, scope, and commit metadata stay internal. Reviewer-facing output is
 * selected by the validated representation and uses conservative GitHub syntax.
 */
import type { VisualArtifact, VisualRepresentation } from '../types/visual.js';

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

function representationOf(visual: VisualArtifact): VisualRepresentation {
  return visual.representation ?? 'flowchart';
}

function buildCaption(visual: VisualArtifact): string {
  switch (representationOf(visual)) {
    case 'sequence':
      return '### Sequence visualization';
    case 'table':
      return '### Change table';
    case 'flowchart':
      return visual.mode === 'concept' ? '### Concept visualization' : '### Implementation visualization';
  }
}

function coverageCaption(visual: VisualArtifact): string[] {
  const lines = [buildCaption(visual)];
  if (visual.partial) {
    lines.push(
      'Coverage is partial: some patch evidence was omitted or some selected files were not fully reviewed.',
    );
  }
  return lines;
}

function nodeIds(visual: VisualArtifact): Map<string, string> {
  const ids = new Map<string, string>();
  for (const [index, node] of visual.nodes.entries()) {
    if (ids.has(node.id)) throw new Error('Visual contains duplicate node ids');
    ids.set(node.id, `n${index}`);
  }
  return ids;
}

function renderFlowchart(visual: VisualArtifact): string {
  const ids = nodeIds(visual);
  const lines = ['```mermaid', 'flowchart TD'];
  for (const node of visual.nodes) {
    lines.push(`  ${ids.get(node.id)!}["${escapeMermaidLabel(node.label)}"]`);
  }
  for (const edge of visual.edges) {
    const from = ids.get(edge.from);
    const to = ids.get(edge.to);
    if (!from || !to) throw new Error('Visual contains a dangling edge');
    lines.push(`  ${from} -->|"${escapeMermaidLabel(edge.label)}"| ${to}`);
  }
  lines.push('```');
  return lines.join('\n');
}

function participantIds(visual: VisualArtifact): Map<string, string> {
  const participants = visual.participants;
  if (!participants || participants.length < 2) throw new Error('Sequence visualization has no participants');
  const ids = new Map<string, string>();
  for (const [index, participant] of participants.entries()) {
    if (ids.has(participant.id)) throw new Error('Visual contains duplicate participant ids');
    ids.set(participant.id, `p${index}`);
  }
  return ids;
}

function renderSequence(visual: VisualArtifact): string {
  const ids = participantIds(visual);
  const messages = visual.messages;
  if (!messages || messages.length === 0) throw new Error('Sequence visualization has no messages');
  const lines = ['```mermaid', 'sequenceDiagram'];
  for (const participant of visual.participants!) {
    lines.push(`  participant ${ids.get(participant.id)!} as ${escapeMermaidLabel(participant.label)}`);
  }
  for (const message of messages) {
    const from = ids.get(message.from);
    const to = ids.get(message.to);
    if (!from || !to) throw new Error('Sequence visualization has a dangling message');
    lines.push(`  ${from}->>${to}: ${escapeMermaidLabel(message.label)}`);
  }
  lines.push('```');
  return lines.join('\n');
}

function renderTable(visual: VisualArtifact): string {
  const columns = visual.columns;
  const rows = visual.rows;
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

function renderTextFlowchart(visual: VisualArtifact): string {
  const ids = nodeIds(visual);
  const parts = ['Nodes:'];
  for (const node of visual.nodes) {
    parts.push(`- ${ids.get(node.id)!}: ${escapeMarkdownText(node.label)}`);
  }
  if (visual.edges.length > 0) {
    parts.push('', 'Edges:');
    for (const edge of visual.edges) {
      const from = ids.get(edge.from);
      const to = ids.get(edge.to);
      if (!from || !to) throw new Error('Visual contains a dangling edge');
      parts.push(`- ${from} -> ${to}: ${escapeMarkdownText(edge.label)}`);
    }
  }
  return parts.join('\n');
}

function renderTextSequence(visual: VisualArtifact): string {
  const ids = participantIds(visual);
  const messages = visual.messages;
  if (!messages || messages.length === 0) throw new Error('Sequence visualization has no messages');
  const parts = ['Participants:'];
  for (const participant of visual.participants!) {
    parts.push(`- ${ids.get(participant.id)!}: ${escapeMarkdownText(participant.label)}`);
  }
  parts.push('', 'Messages:');
  for (const message of messages) {
    const from = ids.get(message.from);
    const to = ids.get(message.to);
    if (!from || !to) throw new Error('Sequence visualization has a dangling message');
    parts.push(`- ${from} -> ${to}: ${escapeMarkdownText(message.label)}`);
  }
  return parts.join('\n');
}

function renderBody(visual: VisualArtifact, format: 'mermaid' | 'text'): string {
  switch (representationOf(visual)) {
    case 'sequence':
      return format === 'mermaid' ? renderSequence(visual) : renderTextSequence(visual);
    case 'table':
      return renderTable(visual);
    case 'flowchart':
      return format === 'mermaid' ? renderFlowchart(visual) : renderTextFlowchart(visual);
  }
}

/** Render a validated visual artifact without exposing evidence or raw patches. */
export function renderVisualSection(
  visual: VisualArtifact,
  format: 'mermaid' | 'text' = 'mermaid',
): string {
  return `${coverageCaption(visual).join('\n')}\n\n${renderBody(visual, format)}\n`;
}

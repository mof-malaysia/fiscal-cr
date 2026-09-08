/**
 * Deterministic renderer for change-diagram artifacts.
 *
 * Produces either a fenced Mermaid `flowchart TD` (for surfaces that render
 * Mermaid) or a plain-text bullet view (for check / Action surfaces). All
 * untrusted content (node/edge labels, repository paths) is escaped so nothing
 * can inject Markdown, HTML, URLs, or Mermaid directives. Change kinds are
 * conveyed with textual prefixes on nodes and edges; no per-element styling is
 * generated from untrusted data.
 */
import type { DiagramArtifact, DiagramChange } from '../types/diagram.js';

const CHANGE_PREFIX: Record<DiagramChange, string> = {
  added: '[added]',
  modified: '[modified]',
  removed: '[removed]',
  context: '[context]',
};

/**
 * Defensive, minimal HTML escape for untrusted values embedded in the code-owned
 * diagram caption (currently the head SHA). The caption is plain text in the
 * rendered section, so a hostile value would otherwise be honored by the
 * raw-text lifecycle state parser. Replacing `&`, `<`, `>`, and `#` with their
 * HTML entities prevents forging a hidden state marker (`<!--`, `-->`) or a
 * lifecycle heading (`### …`) while leaving ordinary hex SHAs untouched — GitHub
 * renders the entities back to the exact original characters.
 */
function escapeCaptionValue(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/#/g, '&#35;');
}

function buildCaption(diagram: DiagramArtifact): string {
  const scopeLine =
    diagram.scope === 'full'
      ? 'Changes in the filtered pull-request patches supplied as diagram input (not the whole repository).'
      : 'PR changes in the files selected for this incremental review.';
  const lines = [
    '### Visual changes',
    `Source commit: ${escapeCaptionValue(diagram.headSha)}`,
    `Scope: ${scopeLine}`,
  ];
  if (diagram.partial) {
    lines.push(
      'Coverage is partial: some patch evidence was omitted or some selected files were not fully reviewed.',
    );
  }
  return lines.join('\n');
}

/**
 * Escape a label for use inside a Mermaid quoted string (`"..."`). Mermaid
 * parses quoted labels with its own grammar, not JavaScript, so backslash
 * escapes do not apply; the documented mechanism is decimal Mermaid entities
 * for any character that would otherwise break the string or graph syntax.
 */
function escapeMermaidLabel(value: string): string {
  // Single pass: a chained `.replace` would re-encode characters already
  // written as numeric entities (e.g. the `#` inside `#34;`). A replacer
  // function emits each entity exactly once.
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
/**
 * Escape Markdown metacharacters in a plain-text label so it cannot inject
 * emphasis, links, code spans, or headings into a surface that renders Markdown.
 */
function escapeMarkdownText(value: string): string {
  return value
    .replace(/\\/g, '\\\\')
    .replace(/([\\[\]()*_~`#!<>])/g, '\\$1');
}

function renderMermaid(diagram: DiagramArtifact): string {
  const lines = ['```mermaid', 'flowchart TD'];
  for (const node of diagram.nodes) {
    const label = escapeMermaidLabel(`${CHANGE_PREFIX[node.change]} ${node.label}`);
    lines.push(`  ${node.id}["${label}"]`);
  }
  for (const edge of diagram.edges) {
    const label = escapeMermaidLabel(`${CHANGE_PREFIX[edge.change]} ${edge.label}`);
    lines.push(`  ${edge.from} -->|"${label}"| ${edge.to}`);
  }
  lines.push('```');
  return lines.join('\n');
}

function renderTextGraph(diagram: DiagramArtifact): string {
  const parts = ['Nodes:'];
  for (const node of diagram.nodes) {
    parts.push(`- ${CHANGE_PREFIX[node.change]} ${node.id}: ${escapeMarkdownText(node.label)}`);
  }
  if (diagram.edges.length > 0) {
    parts.push('', 'Edges:');
    for (const edge of diagram.edges) {
      parts.push(`- ${CHANGE_PREFIX[edge.change]} ${edge.from} -> ${edge.to}: ${escapeMarkdownText(edge.label)}`);
    }
  }
  return parts.join('\n');
}

/**
 * Render a repository path safely for the diagram evidence list.
 *
 * Paths are untrusted (they come from the diff), so a crafted filename can carry
 * anything. Two strategies keep the raw rendered section free of the literal
 * state-marker delimiters (`<!--`, `-->`) and lifecycle headings (`### …`) that
 * the raw-text lifecycle state parser would otherwise honor:
 *  - Ordinary paths (no `&`, `<`, `>`, `#`) stay in a readable backtick code span.
 *  - Paths carrying those delimiter-bearing characters are wrapped in a
 *    code-owned `<code>` element with the dangerous characters HTML-escaped
 *    (`&lt;`, `&gt;`, `&#35;`, `&amp;`). GitHub renders the exact original
 *    filename, yet the raw Markdown contains no literal `<`, `>`, or `#`, so a
 *    filename like `<!-- fiscalcr:state:v2 {…} -->.ts` cannot be accepted as the
 *    marker. Control characters / newlines are normalized to a space first.
 */
function escapeMarkdownPath(path: string): string {
  const normalized = path.replace(/[\r\n]/g, ' ');
  if (/[<>&#]/.test(normalized)) {
    const escaped = normalized
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/#/g, '&#35;');
    return `<code>${escaped}</code>`;
  }
  return '`' + normalized.replace(/`/g, "'") + '`';
}

function renderEvidence(diagram: DiagramArtifact): string {
  const referenced = new Set<string>();
  for (const node of diagram.nodes) {
    for (const ref of node.evidence) referenced.add(ref);
  }
  for (const edge of diagram.edges) {
    for (const ref of edge.evidence) referenced.add(ref);
  }

  const rows = diagram.evidence.filter((evidence) => referenced.has(evidence.id));
  const lines = ['Evidence:'];
  if (rows.length === 0) {
    lines.push('- (none referenced)');
  } else {
    for (const evidence of rows) {
      lines.push(`- ${evidence.id}: ${escapeMarkdownPath(evidence.path)}`);
    }
  }
  return lines.join('\n');
}

/**
 * Render a diagram artifact to a human-readable section. `format` selects
 * Mermaid (fenced) or plain text. Patch text is never emitted; the evidence
 * list is bounded to referenced ids and paths are Markdown-escaped.
 */
export function renderDiagramSection(
  diagram: DiagramArtifact,
  format: 'mermaid' | 'text' = 'mermaid',
): string {
  const caption = buildCaption(diagram);
  const graph = format === 'mermaid' ? renderMermaid(diagram) : renderTextGraph(diagram);
  const evidence = renderEvidence(diagram);
  return `${caption}\n\n${graph}\n\n${evidence}\n`;
}

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
import type { DiagramArtifact } from '../types/diagram.js';
/**
 * Render a diagram artifact to a human-readable section. `format` selects
 * Mermaid (fenced) or plain text. Patch text is never emitted; the evidence
 * list is bounded to referenced ids and paths are Markdown-escaped.
 */
export declare function renderDiagramSection(diagram: DiagramArtifact, format?: 'mermaid' | 'text'): string;
//# sourceMappingURL=diagram-renderer.d.ts.map
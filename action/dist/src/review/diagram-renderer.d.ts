/**
 * Deterministic renderer for model-selected reviewer visuals.
 *
 * Evidence, scope, and commit metadata stay internal. Reviewer-facing output is
 * selected by the validated representation and uses conservative GitHub syntax.
 */
import type { DiagramArtifact } from '../types/diagram.js';
/** Render a validated artifact without exposing evidence or raw patches. */
export declare function renderDiagramSection(diagram: DiagramArtifact, format?: 'mermaid' | 'text'): string;
//# sourceMappingURL=diagram-renderer.d.ts.map
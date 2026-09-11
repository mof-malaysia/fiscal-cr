/**
 * Deterministic renderer for change-diagram artifacts.
 *
 * Evidence, scope, and commit metadata stay in the artifact for validation and
 * lifecycle bookkeeping. Reviewer-facing output contains only the selected
 * conceptual or implementation graph and a bounded coverage warning.
 */
import type { DiagramArtifact } from '../types/diagram.js';
/**
 * Render a diagram artifact to a reviewer-facing section. Evidence references
 * are intentionally not rendered; they remain internal grounding metadata.
 */
export declare function renderDiagramSection(diagram: DiagramArtifact, format?: 'mermaid' | 'text'): string;
//# sourceMappingURL=diagram-renderer.d.ts.map
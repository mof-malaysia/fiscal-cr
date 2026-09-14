/**
 * Deterministic renderer for model-selected reviewer visuals.
 *
 * Evidence, scope, and commit metadata stay internal. Reviewer-facing output is
 * selected by the validated representation and uses conservative GitHub syntax.
 */
import type { VisualArtifact } from '../types/visual.js';
/** Render a validated visual artifact without exposing evidence or raw patches. */
export declare function renderVisualSection(visual: VisualArtifact, format?: 'mermaid' | 'text'): string;
//# sourceMappingURL=visual-renderer.d.ts.map
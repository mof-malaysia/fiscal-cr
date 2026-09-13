import type { VisualEvidence, VisualGraph, VisualSequenceMessage, VisualSequenceParticipant, VisualTableRow } from '../types/visual.js';
export declare const MAX_NODES = 12;
export declare const MAX_EDGES = 18;
export declare const MAX_LABEL_LENGTH = 80;
export declare const MAX_EVIDENCE_REFS = 6;
export declare const MAX_ID_LENGTH = 64;
export declare const MAX_PARTICIPANTS = 8;
export declare const MAX_MESSAGES = 24;
export declare const MAX_TABLE_COLUMNS = 8;
export declare const MAX_TABLE_ROWS = 20;
/** Return a reason if a reviewer-facing label is unsafe to render. */
export declare function unsafeLabelReason(label: string): string | null;
export interface ParsedVisual extends VisualGraph {
    representation: 'flowchart' | 'sequence' | 'table';
    participants?: VisualSequenceParticipant[];
    messages?: VisualSequenceMessage[];
    columns?: string[];
    rows?: VisualTableRow[];
}
/**
 * Parse and normalize a model visual response. Omit outcomes, malformed
 * payloads, unsafe labels, and unresolved evidence are rejected as a unit.
 */
export declare function parseVisualResponse(content: string, evidence: readonly VisualEvidence[]): ParsedVisual | null;
//# sourceMappingURL=visual-schema.d.ts.map
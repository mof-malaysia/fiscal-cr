import type { DiagramEvidence, DiagramGraph, DiagramSequenceMessage, DiagramSequenceParticipant, DiagramTableRow } from '../types/diagram.js';
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
export interface ParsedDiagram extends DiagramGraph {
    representation: 'flowchart' | 'sequence' | 'table';
    participants?: DiagramSequenceParticipant[];
    messages?: DiagramSequenceMessage[];
    columns?: string[];
    rows?: DiagramTableRow[];
}
/**
 * Parse and normalize a model visual response. Omit outcomes, malformed
 * payloads, unsafe labels, and unresolved evidence are rejected as a unit.
 */
export declare function parseDiagramResponse(content: string, evidence: readonly DiagramEvidence[]): ParsedDiagram | null;
//# sourceMappingURL=diagram-schema.d.ts.map
export type VisualMode = 'concept' | 'implementation';
export type VisualChange = 'added' | 'modified' | 'removed' | 'context';
export interface VisualEvidence {
    id: string;
    path: string;
    patch: string;
}
export interface VisualNode {
    id: string;
    label: string;
    change: VisualChange;
    evidence: string[];
}
export interface VisualEdge {
    from: string;
    to: string;
    label: string;
    change: VisualChange;
    evidence: string[];
}
export type VisualRepresentation = 'flowchart' | 'sequence' | 'table';
export interface VisualSequenceParticipant {
    id: string;
    label: string;
    change: VisualChange;
    evidence: string[];
}
export interface VisualSequenceMessage {
    from: string;
    to: string;
    label: string;
    change: VisualChange;
    evidence: string[];
}
export interface VisualTableRow {
    cells: string[];
    evidence: string[];
}
export interface VisualTable {
    columns: string[];
    rows: VisualTableRow[];
}
export interface VisualGraph {
    nodes: VisualNode[];
    edges: VisualEdge[];
}
export interface VisualArtifact extends VisualGraph {
    /**
     * Legacy artifacts omit this field and are rendered as flowcharts.
     * New model responses always carry an explicit representation.
     */
    representation?: VisualRepresentation;
    participants?: VisualSequenceParticipant[];
    messages?: VisualSequenceMessage[];
    columns?: VisualTable['columns'];
    rows?: VisualTableRow[];
    mode: VisualMode;
    evidence: Array<{
        id: string;
        path: string;
    }>;
    headSha: string;
    scope: 'full' | 'delta';
    partial: boolean;
}
//# sourceMappingURL=visual.d.ts.map
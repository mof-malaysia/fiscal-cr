export type DiagramMode = 'concept' | 'implementation';
export type DiagramChange = 'added' | 'modified' | 'removed' | 'context';
export interface DiagramEvidence {
    id: string;
    path: string;
    patch: string;
}
export interface DiagramNode {
    id: string;
    label: string;
    change: DiagramChange;
    evidence: string[];
}
export interface DiagramEdge {
    from: string;
    to: string;
    label: string;
    change: DiagramChange;
    evidence: string[];
}
export type DiagramRepresentation = 'flowchart' | 'sequence' | 'table';
export interface DiagramSequenceParticipant {
    id: string;
    label: string;
    change: DiagramChange;
    evidence: string[];
}
export interface DiagramSequenceMessage {
    from: string;
    to: string;
    label: string;
    change: DiagramChange;
    evidence: string[];
}
export interface DiagramTableRow {
    cells: string[];
    evidence: string[];
}
export interface DiagramTable {
    columns: string[];
    rows: DiagramTableRow[];
}
export interface DiagramGraph {
    nodes: DiagramNode[];
    edges: DiagramEdge[];
}
export interface DiagramArtifact extends DiagramGraph {
    /**
     * Legacy artifacts omit this field and are rendered as flowcharts.
     * New model responses always carry an explicit representation.
     */
    representation?: DiagramRepresentation;
    participants?: DiagramSequenceParticipant[];
    messages?: DiagramSequenceMessage[];
    columns?: DiagramTable['columns'];
    rows?: DiagramTableRow[];
    mode: DiagramMode;
    evidence: Array<{
        id: string;
        path: string;
    }>;
    headSha: string;
    scope: 'full' | 'delta';
    partial: boolean;
}
//# sourceMappingURL=diagram.d.ts.map
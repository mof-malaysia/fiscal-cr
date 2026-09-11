import type { DiagramEvidence, DiagramGraph } from '../types/diagram.js';
export declare const MAX_NODES = 12;
export declare const MAX_EDGES = 18;
export declare const MAX_LABEL_LENGTH = 80;
export declare const MAX_EVIDENCE_REFS = 6;
export declare const MAX_ID_LENGTH = 64;
/**
 * Return a reason string if the label is unsafe to render, else null.
 * "where practical" credential detection targets actual secret-shaped tokens
 * rather than ordinary words like "auth" or "token".
 */
export declare function unsafeLabelReason(label: string): string | null;
/**
 * Parse a model change-diagram response into a normalized, validated graph.
 *
 * Returns `null` for:
 *  - unparseable or truncated JSON,
 *  - `outcome: 'omit'` (and any non-diagram outcome),
 *  - strict-key / schema violations,
 *  - graphs with fewer than two nodes or one edge,
 *  - node/edge count or label-length caps exceeded,
 *  - duplicate node ids, dangling edge endpoints,
 *  - evidence references that do not resolve to the supplied evidence,
 *  - unsafe labels.
 *
 * The whole graph is rejected as a unit; no partial acceptance.
 */
export declare function parseDiagramResponse(content: string, evidence: readonly DiagramEvidence[]): DiagramGraph | null;
//# sourceMappingURL=diagram-schema.d.ts.map
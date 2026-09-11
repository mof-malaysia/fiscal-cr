/**
 * Contract parser for model-produced reviewer visuals.
 *
 * The model emits `{ outcome: 'diagram', representation, ... }` (or
 * `{ outcome: 'omit', reason }`). This module validates and normalizes every
 * representation before untrusted labels reach the renderer.
 */
import { z } from 'zod';
import type {
  DiagramEdge,
  DiagramEvidence,
  DiagramGraph,
  DiagramSequenceMessage,
  DiagramSequenceParticipant,
  DiagramTableRow,
} from '../types/diagram.js';
import { extractJson } from '../utils/json.js';
import { logger } from '../utils/logger.js';

export const MAX_NODES = 12;
export const MAX_EDGES = 18;
export const MAX_LABEL_LENGTH = 80;
export const MAX_EVIDENCE_REFS = 6;
export const MAX_ID_LENGTH = 64;
export const MAX_PARTICIPANTS = 8;
export const MAX_MESSAGES = 24;
export const MAX_TABLE_COLUMNS = 8;
export const MAX_TABLE_ROWS = 20;

const CHANGE_VALUES = ['added', 'modified', 'removed', 'context'] as const;

/** Return a reason if a reviewer-facing label is unsafe to render. */
export function unsafeLabelReason(label: string): string | null {
  for (let i = 0; i < label.length; i++) {
    const code = label.charCodeAt(i);
    if (code < 0x20 || code === 0x7f) return 'control character';
  }
  if (label.includes('`')) return 'backtick';
  if (label.includes('<') || label.includes('>')) return 'html';
  if (/(https?|ftp):\/\/|www\./i.test(label)) return 'url';
  if (label.includes('%%')) return 'directive';
  if (/\b(click|classDef|linkStyle|subgraph)\b/i.test(label)) return 'directive';
  if (
    /(AKIA[0-9A-Z]{8,}|gh[po]_[A-Za-z0-9]{12,}|sk-[A-Za-z0-9]{12,}|xox[baprs]-|eyJ[A-Za-z0-9_-]{8,}|password\s*=|secret\s*=|api[_-]?key\s*=|token\s*=|authorization\s*:|bearer\s+[A-Za-z0-9._-]+|-----BEGIN)/i.test(
      label,
    )
  ) {
    return 'credential';
  }
  return null;
}

const rawNodeSchema = z
  .object({
    id: z.string().min(1).max(MAX_ID_LENGTH),
    label: z.string().min(1).max(MAX_LABEL_LENGTH),
    change: z.enum(CHANGE_VALUES),
    evidence: z.array(z.string().min(1).max(MAX_ID_LENGTH)).min(1).max(MAX_EVIDENCE_REFS),
  })
  .strict();

const rawEdgeSchema = z
  .object({
    from: z.string().min(1).max(MAX_ID_LENGTH),
    to: z.string().min(1).max(MAX_ID_LENGTH),
    label: z.string().min(1).max(MAX_LABEL_LENGTH),
    change: z.enum(CHANGE_VALUES),
    evidence: z.array(z.string().min(1).max(MAX_ID_LENGTH)).min(1).max(MAX_EVIDENCE_REFS),
  })
  .strict();

const rawParticipantSchema = rawNodeSchema;
const rawMessageSchema = rawEdgeSchema;
const rawTableRowSchema = z
  .object({
    cells: z.array(z.string().min(1).max(MAX_LABEL_LENGTH)).min(2).max(MAX_TABLE_COLUMNS),
    evidence: z.array(z.string().min(1).max(MAX_ID_LENGTH)).min(1).max(MAX_EVIDENCE_REFS),
  })
  .strict();

const rawFlowchartSchema = z
  .object({
    outcome: z.literal('diagram'),
    // Default preserves acceptance of pre-representation model responses.
    representation: z.literal('flowchart').default('flowchart'),
    nodes: z.array(rawNodeSchema).min(2).max(MAX_NODES),
    edges: z.array(rawEdgeSchema).min(1).max(MAX_EDGES),
  })
  .strict();

const rawSequenceSchema = z
  .object({
    outcome: z.literal('diagram'),
    representation: z.literal('sequence'),
    participants: z.array(rawParticipantSchema).min(2).max(MAX_PARTICIPANTS),
    messages: z.array(rawMessageSchema).min(1).max(MAX_MESSAGES),
  })
  .strict();

const rawTableSchema = z
  .object({
    outcome: z.literal('diagram'),
    representation: z.literal('table'),
    columns: z.array(z.string().min(1).max(MAX_LABEL_LENGTH)).min(2).max(MAX_TABLE_COLUMNS),
    rows: z.array(rawTableRowSchema).min(1).max(MAX_TABLE_ROWS),
  })
  .strict();

const rawDiagramSchema = z.union([rawFlowchartSchema, rawSequenceSchema, rawTableSchema]);

export interface ParsedDiagram extends DiagramGraph {
  representation: 'flowchart' | 'sequence' | 'table';
  participants?: DiagramSequenceParticipant[];
  messages?: DiagramSequenceMessage[];
  columns?: string[];
  rows?: DiagramTableRow[];
}

function refsResolve(refs: readonly string[], evidenceIds: Set<string>): boolean {
  return refs.every((ref) => evidenceIds.has(ref));
}

function labelsAreSafe(labels: readonly string[]): boolean {
  return labels.every((label) => !unsafeLabelReason(label));
}

function normalizeGraph(
  rawNodes: z.infer<typeof rawNodeSchema>[],
  rawEdges: z.infer<typeof rawEdgeSchema>[],
): Pick<ParsedDiagram, 'nodes' | 'edges'> | null {
  const nodeIds = new Set<string>();
  for (const node of rawNodes) {
    if (nodeIds.has(node.id) || unsafeLabelReason(node.label)) return null;
    nodeIds.add(node.id);
  }
  for (const edge of rawEdges) {
    if (!nodeIds.has(edge.from) || !nodeIds.has(edge.to) || unsafeLabelReason(edge.label)) return null;
  }

  const idMap = new Map<string, string>();
  rawNodes.forEach((node, index) => idMap.set(node.id, `n${index}`));
  const nodes = rawNodes.map((node, index) => ({ ...node, id: `n${index}` }));
  const edges = rawEdges.map((edge) => ({
    ...edge,
    from: idMap.get(edge.from) as string,
    to: idMap.get(edge.to) as string,
  }));
  return { nodes, edges };
}

/**
 * Parse and normalize a model visual response. Omit outcomes, malformed
 * payloads, unsafe labels, and unresolved evidence are rejected as a unit.
 */
export function parseDiagramResponse(
  content: string,
  evidence: readonly DiagramEvidence[],
): ParsedDiagram | null {
  const json = extractJson(content, { repairTruncated: false });
  if (!json || typeof json !== 'object' || Array.isArray(json)) return null;
  if ((json as Record<string, unknown>).outcome !== 'diagram') return null;

  const parsed = rawDiagramSchema.safeParse(json);
  if (!parsed.success) {
    logger.warn({ reason: 'schema' }, 'Diagram response rejected');
    return null;
  }

  const evidenceIds = new Set(evidence.map((item) => item.id));
  const raw = parsed.data;

  if (raw.representation === 'flowchart') {
    if (!raw.nodes.every((node) => refsResolve(node.evidence, evidenceIds))) return null;
    if (!raw.edges.every((edge) => refsResolve(edge.evidence, evidenceIds))) return null;
    const graph = normalizeGraph(raw.nodes, raw.edges);
    return graph ? { representation: 'flowchart', ...graph } : null;
  }

  if (raw.representation === 'sequence') {
    const participantIds = new Set<string>();
    for (const participant of raw.participants) {
      if (
        participantIds.has(participant.id) ||
        unsafeLabelReason(participant.label) ||
        !refsResolve(participant.evidence, evidenceIds)
      ) {
        return null;
      }
      participantIds.add(participant.id);
    }
    for (const message of raw.messages) {
      if (
        !participantIds.has(message.from) ||
        !participantIds.has(message.to) ||
        unsafeLabelReason(message.label) ||
        !refsResolve(message.evidence, evidenceIds)
      ) {
        return null;
      }
    }
    const idMap = new Map<string, string>();
    raw.participants.forEach((participant, index) => idMap.set(participant.id, `p${index}`));
    return {
      representation: 'sequence',
      nodes: [],
      edges: [],
      participants: raw.participants.map((participant, index) => ({ ...participant, id: `p${index}` })),
      messages: raw.messages.map((message) => ({
        ...message,
        from: idMap.get(message.from) as string,
        to: idMap.get(message.to) as string,
      })),
    };
  }

  if (
    !labelsAreSafe(raw.columns) ||
    !raw.rows.every(
      (row) =>
        row.cells.length === raw.columns.length &&
        labelsAreSafe(row.cells) &&
        refsResolve(row.evidence, evidenceIds),
    )
  ) {
    return null;
  }
  return {
    representation: 'table',
    nodes: [],
    edges: [],
    columns: raw.columns,
    rows: raw.rows,
  };
}

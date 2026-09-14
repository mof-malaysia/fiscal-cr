/**
 * Contract parser for the model-produced change-diagram JSON.
 *
 * The model emits `{ outcome: 'diagram', nodes, edges }` (or
 * `{ outcome: 'omit', reason }`). This module extracts the JSON object,
 * validates it strictly, and normalizes the graph so that untrusted model
 * identifiers never reach the Mermaid renderer.
 * Safety posture:
 *  - No partial JSON repair. A graph cut off at the token cap is malformed and
 *    is rejected as a unit (the renderer/text fallback is the safe path).
 *  - All node/edge labels are screened for injection (HTML, URLs, directives,
 *    backticks, control chars, credential-looking tokens).
 *  - Every evidence reference must resolve to a code-assigned evidence id.
 *  - Model ids are remapped to n0..nN; edge endpoints are remapped to match.
 */
import { z } from 'zod';
import type { DiagramEvidence, DiagramGraph } from '../types/diagram.js';
import { extractJson } from '../utils/json.js';
import { logger } from '../utils/logger.js';

export const MAX_NODES = 12;
export const MAX_EDGES = 18;
export const MAX_LABEL_LENGTH = 80;
export const MAX_EVIDENCE_REFS = 6;
export const MAX_ID_LENGTH = 64;

const CHANGE_VALUES = ['added', 'modified', 'removed', 'context'] as const;

/**
 * Return a reason string if the label is unsafe to render, else null.
 * "where practical" credential detection targets actual secret-shaped tokens
 * rather than ordinary words like "auth" or "token".
 */
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

const rawDiagramSchema = z
  .object({
    outcome: z.literal('diagram'),
    nodes: z.array(rawNodeSchema).min(1).max(MAX_NODES),
    edges: z.array(rawEdgeSchema).max(MAX_EDGES),
  })
  .strict();


/**
 * Parse a model change-diagram response into a normalized, validated graph.
 *
 * Returns `null` for:
 *  - unparseable or truncated JSON,
 *  - `outcome: 'omit'` (and any non-diagram outcome),
 *  - strict-key / schema violations,
 *  - node/edge count or label-length caps exceeded,
 *  - duplicate node ids, dangling edge endpoints,
 *  - evidence references that do not resolve to the supplied evidence,
 *  - unsafe labels.
 *
 * The whole graph is rejected as a unit; no partial acceptance.
 */
export function parseDiagramResponse(
  content: string,
  evidence: readonly DiagramEvidence[],
): DiagramGraph | null {
  const json = extractJson(content, { repairTruncated: false });
  if (!json || typeof json !== 'object' || Array.isArray(json)) return null;

  // `omit` (and any non-diagram outcome) is a normal, honest result — reject
  // it quietly without logging any user-controlled content.
  if ((json as Record<string, unknown>).outcome !== 'diagram') return null;

  const parsed = rawDiagramSchema.safeParse(json);
  if (!parsed.success) {
    logger.warn({ reason: 'schema' }, 'Diagram response rejected');
    return null;
  }

  const { nodes: rawNodes, edges: rawEdges } = parsed.data;

  const evidenceIds = new Set(evidence.map((e) => e.id));
  const nodeIds = new Set<string>();

  for (const node of rawNodes) {
    if (nodeIds.has(node.id)) {
      logger.warn({ reason: 'duplicate-node-id' }, 'Diagram response rejected');
      return null;
    }
    nodeIds.add(node.id);
    if (unsafeLabelReason(node.label)) {
      logger.warn({ reason: 'unsafe-node-label' }, 'Diagram response rejected');
      return null;
    }
    for (const ref of node.evidence) {
      if (!evidenceIds.has(ref)) {
        logger.warn({ reason: 'unknown-node-ref' }, 'Diagram response rejected');
        return null;
      }
    }
  }

  for (const edge of rawEdges) {
    if (!nodeIds.has(edge.from) || !nodeIds.has(edge.to)) {
      logger.warn({ reason: 'dangling-edge' }, 'Diagram response rejected');
      return null;
    }
    if (unsafeLabelReason(edge.label)) {
      logger.warn({ reason: 'unsafe-edge-label' }, 'Diagram response rejected');
      return null;
    }
    for (const ref of edge.evidence) {
      if (!evidenceIds.has(ref)) {
        logger.warn({ reason: 'unknown-edge-ref' }, 'Diagram response rejected');
        return null;
      }
    }
  }

  // Normalize: assign code-owned ids and remap edge endpoints.
  const idMap = new Map<string, string>();
  rawNodes.forEach((node, i) => idMap.set(node.id, `n${i}`));

  return {
    nodes: rawNodes.map((node, i) => ({
      id: `n${i}`,
      label: node.label,
      change: node.change,
      evidence: node.evidence,
    })),
    edges: rawEdges.map((edge) => ({
      from: idMap.get(edge.from) as string,
      to: idMap.get(edge.to) as string,
      label: edge.label,
      change: edge.change,
      evidence: edge.evidence,
    })),
  };
}

import { z } from 'zod';
import type { AnnotationCategory, ReviewAnnotation, WalkthroughEntry } from '../types/review.js';
import { extractJson } from '../kimi/response-parser.js';
import { logger } from '../utils/logger.js';

/** Confidence assumed when a model omits the field entirely. */
export const DEFAULT_CONFIDENCE = 0.7;

// Tolerant annotation schema: accepts camelCase and snake_case, salvages
// alternate field names — models vary in how faithfully they follow schemas.
const findingSchema = z
  .object({
    path: z.string(),
    startLine: z.number().int().positive().optional(),
    start_line: z.number().int().positive().optional(),
    endLine: z.number().int().positive().optional(),
    end_line: z.number().int().positive().optional(),
    line: z.number().int().positive().optional(),
    severity: z.enum(['critical', 'warning', 'suggestion', 'nitpick']),
    category: z
      .enum([
        'bug', 'security', 'performance', 'style',
        'best-practice', 'documentation', 'testing', 'other',
      ])
      .catch('other'),
    title: z.string(),
    body: z.string().optional().default(''),
    message: z.string().optional(),
    description: z.string().optional(),
    suggestedFix: z.string().nullable().optional(),
    suggested_fix: z.string().nullable().optional(),
    confidence: z.number().min(0).max(1).optional(),
  })
  .transform((a): ReviewAnnotation => {
    const startLine = a.startLine ?? a.start_line ?? a.line ?? 1;
    const endLine = Math.max(startLine, a.endLine ?? a.end_line ?? startLine);
    return {
      path: a.path,
      startLine,
      endLine,
      severity: a.severity,
      category: a.category as AnnotationCategory,
      title: a.title,
      body: a.body || a.message || a.description || '',
      suggestedFix: a.suggestedFix ?? a.suggested_fix ?? undefined,
      confidence: a.confidence ?? DEFAULT_CONFIDENCE,
    };
  });

const walkthroughSchema = z
  .array(z.object({ path: z.string(), summary: z.string() }))
  .catch([]);

// ---------------------------------------------------------------------------
// Pass 1: intent & walkthrough

export interface IntentResult {
  intent: string;
  walkthrough: WalkthroughEntry[];
  groups: Array<{ label: string; files: string[] }>;
  riskHotspots: Array<{ path: string; reason: string }>;
}

const intentSchema = z.object({
  intent: z.string().default(''),
  walkthrough: walkthroughSchema.default([]),
  groups: z
    .array(z.object({ label: z.string().default(''), files: z.array(z.string()) }))
    .catch([])
    .default([]),
  riskHotspots: z
    .array(z.object({ path: z.string(), reason: z.string().default('') }))
    .catch([])
    .default([]),
});

export function parseIntentResponse(raw: string): IntentResult | null {
  const json = extractJson(raw);
  if (!json || typeof json !== 'object') return null;
  const parsed = intentSchema.safeParse(json);
  if (!parsed.success) {
    logger.warn({ errors: parsed.error.issues }, 'Intent response failed validation');
    return null;
  }
  return parsed.data;
}

// ---------------------------------------------------------------------------
// Pass 2: per-group findings

export interface GroupReviewResult {
  groupSummary: string;
  findings: ReviewAnnotation[];
}

const groupReviewSchema = z.object({
  groupSummary: z.string().optional(),
  group_summary: z.string().optional(),
  summary: z.string().optional(),
  findings: z.array(z.unknown()).default([]),
  annotations: z.array(z.unknown()).optional(),
});

export function parseGroupResponse(raw: string): GroupReviewResult | null {
  const json = extractJson(raw);
  if (!json || typeof json !== 'object') return null;
  const parsed = groupReviewSchema.safeParse(json);
  if (!parsed.success) {
    logger.warn({ errors: parsed.error.issues }, 'Group response failed validation');
    return null;
  }
  const rawFindings = parsed.data.findings.length > 0
    ? parsed.data.findings
    : parsed.data.annotations ?? [];
  const findings: ReviewAnnotation[] = [];
  for (const item of rawFindings) {
    const finding = findingSchema.safeParse(item);
    if (finding.success) findings.push(finding.data);
  }
  return {
    groupSummary:
      parsed.data.groupSummary ?? parsed.data.group_summary ?? parsed.data.summary ?? '',
    findings,
  };
}

// ---------------------------------------------------------------------------
// Pass 3: synthesis

export interface SynthesisResult {
  summary: string;
  score: number | null;
  walkthrough: WalkthroughEntry[];
  nearDuplicates: string[][];
  likelyFalsePositives: string[];
}

const synthesisSchema = z.object({
  summary: z.string().default(''),
  score: z.number().min(0).max(100).nullish(),
  walkthrough: walkthroughSchema.default([]),
  nearDuplicates: z.array(z.array(z.string())).catch([]).default([]),
  near_duplicates: z.array(z.array(z.string())).catch([]).optional(),
  likelyFalsePositives: z.array(z.string()).catch([]).default([]),
  likely_false_positives: z.array(z.string()).catch([]).optional(),
});

export function parseSynthesisResponse(raw: string): SynthesisResult | null {
  const json = extractJson(raw);
  if (!json || typeof json !== 'object') return null;
  const parsed = synthesisSchema.safeParse(json);
  if (!parsed.success) {
    logger.warn({ errors: parsed.error.issues }, 'Synthesis response failed validation');
    return null;
  }
  const d = parsed.data;
  return {
    summary: d.summary,
    score: d.score ?? null,
    walkthrough: d.walkthrough,
    nearDuplicates: d.nearDuplicates.length > 0 ? d.nearDuplicates : d.near_duplicates ?? [],
    likelyFalsePositives:
      d.likelyFalsePositives.length > 0 ? d.likelyFalsePositives : d.likely_false_positives ?? [],
  };
}

// ---------------------------------------------------------------------------
// Fast path: single call combining intent + review

export interface FastPathResult {
  intent: string;
  summary: string;
  score: number | null;
  walkthrough: WalkthroughEntry[];
  findings: ReviewAnnotation[];
}

const fastPathSchema = z.object({
  intent: z.string().default(''),
  summary: z.string().default(''),
  score: z.number().min(0).max(100).nullish(),
  walkthrough: walkthroughSchema.default([]),
  findings: z.array(z.unknown()).default([]),
  annotations: z.array(z.unknown()).optional(),
});

export function parseFastPathResponse(raw: string): FastPathResult | null {
  const json = extractJson(raw);
  if (!json || typeof json !== 'object') return null;
  const parsed = fastPathSchema.safeParse(json);
  if (!parsed.success) {
    logger.warn({ errors: parsed.error.issues }, 'Fast-path response failed validation');
    return null;
  }
  const rawFindings = parsed.data.findings.length > 0
    ? parsed.data.findings
    : parsed.data.annotations ?? [];
  const findings: ReviewAnnotation[] = [];
  for (const item of rawFindings) {
    const finding = findingSchema.safeParse(item);
    if (finding.success) findings.push(finding.data);
  }
  return {
    intent: parsed.data.intent,
    summary: parsed.data.summary,
    score: parsed.data.score ?? null,
    walkthrough: parsed.data.walkthrough,
    findings,
  };
}

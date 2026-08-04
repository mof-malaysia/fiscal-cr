/**
 * Blind Markdown pack + answer-key generator for the FiscalCR eval harness.
 *
 * Pure: no network, no fs, no secrets, no side effects — fully unit-testable.
 * The pack renders complete A/B pairs with deterministic randomized side
 * assignment so human reviewers can score without knowing which variant is
 * baseline or experimental.
 *
 * Secret discipline: the pack and key never contain the API key, base URL,
 * prompt metadata, token counts, timing, gold issue manifests, or quality
 * metrics. Only retained review annotations are rendered.
 */

import type { PullRequestContext, ReviewAnnotation, ReviewResult, WalkthroughEntry } from '../src/types/review.js';
import type { BenchmarkCase } from './quality.js';
import type { CompletedAttempt } from './benchmark.js';

// ---------------------------------------------------------------------------
// Types

export interface BlindPair {
  blindPairId: string;
  pairId: string;
  caseId: string;
  roundIndex: number;
  caseLabel: string;
  context: PullRequestContext;
  reviewA: ReviewResult;
  reviewB: ReviewResult;
  assignment: { a: 'baseline' | 'experimental'; b: 'baseline' | 'experimental' };
}

export interface BlindKeyEntry {
  blindPairId: string;
  pairId: string;
  caseId: string;
  roundIndex: number;
  reviewA: 'baseline' | 'experimental';
  reviewB: 'baseline' | 'experimental';
}

export interface BlindKey {
  schema: 'fiscalcr-blind-key-v1';
  seed: string;
  generatedAt: string;
  pairs: BlindKeyEntry[];
}

export interface BuildBlindReportInput {
  seed: string;
  pairs: BlindPair[];
  excludedPairIds: string[];
}

// ---------------------------------------------------------------------------
// Deterministic assignment

/** FNV-1a hash of a string (same algorithm as eval-plan.ts). */
function fnv1a(text: string): number {
  let h = 2166136261 >>> 0;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

/**
 * Deterministic randomized side assignment for one pair.
 * Returns which variant is Review A and which is Review B.
 * The decision is a 50/50 coin flip based on `seed + ":" + pairId`.
 */
export function deterministicAssignment(
  seed: string,
  pairId: string,
): { a: 'baseline' | 'experimental'; b: 'baseline' | 'experimental' } {
  const hash = fnv1a(`${seed}:${pairId}`);
  if (hash % 2 === 0) {
    return { a: 'baseline', b: 'experimental' };
  }
  return { a: 'experimental', b: 'baseline' };
}

// ---------------------------------------------------------------------------
// Markdown helpers

/** Choose a backtick fence that does not appear inside `content`. */
export function chooseFence(content: string): string {
  let n = 4;
  let fence = '`'.repeat(n);
  while (content.includes(fence)) {
    n += 1;
    fence = '`'.repeat(n);
  }
  return fence;
}

/** Escape pipe characters inside table cells. */
function escapeTableCell(s: string): string {
  return s.replace(/\|/g, '\\|');
}

/** Indent every line by two spaces (safe code block alternative). */
function indentBlock(text: string): string {
  return text
    .split('\n')
    .map((l) => `  ${l}`)
    .join('\n');
}

// ---------------------------------------------------------------------------
// Render review

function renderWalkthrough(entries: WalkthroughEntry[]): string {
  if (entries.length === 0) return '_(none)_';
  return entries.map((e) => `- \`${e.path}\`: ${e.summary}`).join('\n');
}

function renderFindings(annotations: ReviewAnnotation[]): string {
  if (annotations.length === 0) return '_(none)_';
  const lines: string[] = [];
  for (let i = 0; i < annotations.length; i++) {
    const a = annotations[i];
    const fix = a.suggestedFix ? `\n   **Suggested fix:** ${a.suggestedFix}` : '';
    lines.push(
      `${i + 1}. **[${a.severity}]** [${a.category}] \`${a.path}\`:${a.startLine}-${a.endLine}\n` +
        `   **${escapeTableCell(a.title)}**${fix}\n\n   ${escapeTableCell(a.body)}`,
    );
  }
  return lines.join('\n\n');
}

/** Render one review (summary + walkthrough + findings) for the pack. */
export function renderReview(review: ReviewResult, label: 'A' | 'B'): string {
  const parts: string[] = [
    `### Review ${label}`,
    '',
    '**Summary**',
    review.summary || '_(none)_',
    '',
    '**Walkthrough**',
    renderWalkthrough(review.walkthrough ?? []),
    '',
    `**Findings (${review.annotations.length})**`,
    renderFindings(review.annotations),
  ];
  return parts.join('\n');
}

// ---------------------------------------------------------------------------
// Render case context

/** Render PR context (title, description, changed files) for the pack. */
export function renderCaseContext(ctx: PullRequestContext, label: string): string {
  const parts: string[] = [
    `### Context — ${label}`,
    '',
    `**Title:** ${ctx.title}`,
    '',
    '**Description:**',
    ctx.body || '_(none)_',
    '',
    '**Changed files:**',
  ];

  for (const f of ctx.changedFiles) {
    const patchFence = chooseFence(f.patch ?? '');
    parts.push(`- \`${f.filename}\` (${f.status}, +${f.additions}/-${f.deletions})`);
    parts.push('');
    parts.push(`${patchFence}diff`);
    parts.push(f.patch ?? '');
    parts.push(patchFence);
    parts.push('');

    const content = ctx.fileContents.get(f.filename);
    if (content !== undefined) {
      const contentFence = chooseFence(content);
      parts.push(`Full file content:`);
      parts.push(`${contentFence}`);
      parts.push(content);
      parts.push(contentFence);
      parts.push('');
    }
  }

  return parts.join('\n');
}

// ---------------------------------------------------------------------------
// Render scoring worksheet

function renderWorksheet(): string {
  return [
    '### Scoring Worksheet',
    '',
    '| Criterion | Score (1–5) |',
    '| --- | --- |',
    '| Correctness | ____ |',
    '| Important-issue coverage | ____ |',
    '| Actionability | ____ |',
    '| Clarity / readability | ____ |',
    '| Redundancy (5 = no unnecessary repetition) | ____ |',
    '',
    '- **Misleading or harmful:** [ ] yes &nbsp;&nbsp; [ ] no',
    '- **Preferred review:** [ ] A &nbsp;&nbsp; [ ] B &nbsp;&nbsp; [ ] Tie',
    '',
    '**Reasons** (check all that apply):',
    '- [ ] Better detection of real issues',
    '- [ ] Fewer false positives',
    '- [ ] Clearer explanations',
    '- [ ] More actionable suggestions',
    '- [ ] Less repetitive',
    '',
    '**Notes:**',
    '________________________________________',
    '________________________________________',
    '',
  ].join('\n');
}

// ---------------------------------------------------------------------------
// Build blind pair from attempts

export interface BuildBlindPairInput {
  pairId: string;
  caseId: string;
  roundIndex: number;
  baselineAttempt: CompletedAttempt;
  experimentalAttempt: CompletedAttempt;
  case: BenchmarkCase;
  seed: string;
}

export function buildBlindPair(input: BuildBlindPairInput): BlindPair {
  const assignment = deterministicAssignment(input.seed, input.pairId);
  const baselineReview = input.baselineAttempt.metrics.review;
  const experimentalReview = input.experimentalAttempt.metrics.review;
  return {
    blindPairId: `pair-${input.caseId}-r${input.roundIndex}`,
    pairId: input.pairId,
    caseId: input.caseId,
    roundIndex: input.roundIndex,
    caseLabel: input.case.label,
    context: input.case.context,
    reviewA: assignment.a === 'baseline' ? baselineReview : experimentalReview,
    reviewB: assignment.b === 'baseline' ? baselineReview : experimentalReview,
    assignment,
  };
}

// ---------------------------------------------------------------------------
// Build full report Markdown

export function buildBlindReport(input: BuildBlindReportInput): string {
  const { seed, pairs, excludedPairIds } = input;
  const lines: string[] = [
    '# FiscalCR Blind Review Pack',
    '',
    '> **Instructions:** Score every pair before opening the answer key. ' +
      'Do not look at the artifact JSON or the `-blind-key.json` until scoring is complete.',
    '',
    `- **Seed:** ${seed}`,
    `- **Pairs in pack:** ${pairs.length}`,
  ];

  if (excludedPairIds.length > 0) {
    lines.push(`- **Excluded (incomplete):** ${excludedPairIds.length} pair(s) — ${excludedPairIds.join(', ')}`);
  }

  lines.push('');

  for (const p of pairs) {
    lines.push(`---`);
    lines.push('');
    lines.push(`## ${p.blindPairId}`);
    lines.push('');
    lines.push(renderCaseContext(p.context, p.blindPairId));
    lines.push('');
    lines.push(renderReview(p.reviewA, 'A'));
    lines.push('');
    lines.push(renderReview(p.reviewB, 'B'));
    lines.push('');
    lines.push(renderWorksheet());
    lines.push('');
  }

  lines.push('---');
  lines.push('');
  lines.push('## Scoring rubric');
  lines.push('');
  lines.push([
    '- **Correctness (1–5):** Are the reported issues real? Does the review miss anything important?',
    '  1 = many false positives or severe misses; 5 = accurate and thorough.',
    '- **Important-issue coverage (1–5):** Does the review catch the most important problems?',
    '  1 = misses critical issues; 5 = catches everything that matters.',
    '- **Actionability (1–5):** Are suggestions concrete and fixable?',
    '  1 = vague or unhelpful; 5 = precise, prioritized, and ready to act on.',
    '- **Clarity / readability (1–5):** Is the review easy to understand?',
    '  1 = confusing or verbose; 5 = concise and well-structured.',
    '- **Redundancy (1–5):** Does the review repeat itself unnecessarily?',
    '  1 = highly repetitive; 5 = every sentence adds value.',
    '- **Misleading / harmful:** Could following the review damage the code or waste time?',
  ].join('\n'));
  lines.push('');

  return lines.join('\n');
}

// ---------------------------------------------------------------------------
// Build answer key JSON

export function buildBlindKey(pairs: readonly BlindPair[], seed: string, generatedAt: string): BlindKey {
  return {
    schema: 'fiscalcr-blind-key-v1',
    seed,
    generatedAt,
    pairs: pairs.map((p) => ({
      blindPairId: p.blindPairId,
      pairId: p.pairId,
      caseId: p.caseId,
      roundIndex: p.roundIndex,
      reviewA: p.assignment.a,
      reviewB: p.assignment.b,
    })),
  };
}

// ---------------------------------------------------------------------------
// Convenience: build pairs from benchmark result structures

export interface BuildBlindPairsFromAttemptsInput {
  seed: string;
  attempts: readonly CompletedAttempt[];
  casesById: Map<string, BenchmarkCase>;
}

/**
 * Group completed attempts into complete baseline+experimental pairs and
 * build blind pairs with deterministic side assignment.
 * Returns { pairs, excludedPairIds }.
 */
export function buildBlindPairsFromAttempts(
  input: BuildBlindPairsFromAttemptsInput,
): { pairs: BlindPair[]; excludedPairIds: string[] } {
  const { seed, attempts, casesById } = input;

  // Group completed attempts by pairId
  const byPair = new Map<string, CompletedAttempt[]>();
  for (const a of attempts) {
    const list = byPair.get(a.identity.pairId) ?? [];
    list.push(a);
    byPair.set(a.identity.pairId, list);
  }

  const pairs: BlindPair[] = [];
  const excludedPairIds: string[] = [];

  for (const [pairId, list] of byPair) {
    const baseline = list.find((a) => a.identity.variant === 'baseline');
    const experimental = list.find((a) => a.identity.variant === 'experimental');
    if (baseline === undefined || experimental === undefined) {
      excludedPairIds.push(pairId);
      continue;
    }
    const c = casesById.get(baseline.case.caseId);
    if (!c) {
      excludedPairIds.push(pairId);
      continue;
    }
    pairs.push(
      buildBlindPair({
        pairId,
        caseId: baseline.case.caseId,
        roundIndex: baseline.identity.roundIndex,
        baselineAttempt: baseline,
        experimentalAttempt: experimental,
        case: c,
        seed,
      }),
    );
  }

  // Sort by roundIndex then caseId for stable output order
  pairs.sort((a, b) => {
    if (a.roundIndex !== b.roundIndex) return a.roundIndex - b.roundIndex;
    return a.caseId.localeCompare(b.caseId);
  });

  return { pairs, excludedPairIds };
}

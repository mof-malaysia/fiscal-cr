import type {
  ChangedFile,
  PullRequestContext,
  ReviewAnnotation,
  ReviewResult,
  Severity,
  WalkthroughEntry,
} from '../types/review.js';
import type { ReviewConfig } from '../config/schema.js';
import { modelForRole } from '../config/schema.js';
import type { LLMProvider } from '../providers/interface.js';
import { lineToDiffPosition } from '../review/diff-analyzer.js';
import { buildSynthesisSystemPrompt, buildSynthesisUserPrompt } from './prompts.js';
import { parseSynthesisResponse, DEFAULT_CONFIDENCE, type IntentResult } from './schemas.js';
import type { GroupReviewOutcome } from './pass2-review.js';
import { reviewTemperature } from './temperature.js';
import type { UsageTracker } from './usage.js';
import { logger } from '../utils/logger.js';

const SEVERITY_ORDER: Severity[] = ['critical', 'warning', 'suggestion', 'nitpick'];
/** Criticals survive the confidence filter down to this floor, flagged as low-confidence. */
const CRITICAL_CONFIDENCE_FLOOR = 0.4;

function severityRank(severity: Severity): number {
  return SEVERITY_ORDER.indexOf(severity);
}

export function deterministicScore(stats: Record<Severity, number>): number {
  const raw = 100 - 15 * stats.critical - 5 * stats.warning - 1 * stats.suggestion;
  return Math.max(0, Math.min(100, Math.round(raw)));
}

export function countBySeverity(annotations: ReviewAnnotation[]): Record<Severity, number> {
  const stats: Record<Severity, number> = { critical: 0, warning: 0, suggestion: 0, nitpick: 0 };
  for (const a of annotations) stats[a.severity]++;
  return stats;
}
// ---------------------------------------------------------------------------
// Summary simplification (STE-inspired guardrail)

const MAX_SUMMARY_SENTENCE_WORDS = 25;

const PLAIN_WORD_SUBSTITUTIONS: Array<[RegExp, string]> = [
  [/\bin order to\b/gi, 'to'],
  [/\bprior to\b/gi, 'before'],
  [/\bsubsequent to\b/gi, 'after'],
  [/\bwith regard to\b/gi, 'about'],
  [/\bregarding\b/gi, 'about'],
  [/\bin the event that\b/gi, 'if'],
  [/\bat this point in time\b/gi, 'now'],
  [/\ba total of\b/gi, ''],
  [/\bit is important to note that\b/gi, ''],
  [/\bplease note that\b/gi, ''],
  [/\butilized\b/gi, 'used'],
  [/\butilizes\b/gi, 'uses'],
  [/\butilizing\b/gi, 'using'],
  [/\butilize\b/gi, 'use'],
  [/\badditionally\b/gi, 'also'],
];

function wordCount(text: string): number {
  return (text.match(/\S+/g) ?? []).length;
}

function capitalizeFirst(text: string): string {
  return text.replace(/^[a-z](?=[a-z]*\s|$)/, (char) => char.toUpperCase());
}

function isListItem(line: string): boolean {
  return /^\s*(?:[-*•]|\d+\.)\s+/.test(line);
}

function normalizeForDedupe(text: string): string {
  return text
    .toLowerCase()
    .replace(/^\s*(?:[-*•]|\d+\.)\s+/, '')
    .replace(/[^a-z0-9]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function dedupeSummaryLines(text: string): string {
  const keptLines: string[] = [];
  const seen: string[] = [];

  for (const line of text.split('\n')) {
    if (!line.trim()) {
      keptLines.push(line);
      continue;
    }

    const units = isListItem(line) ? [line] : splitIntoSentences(line);
    const keptUnits: string[] = [];
    for (const unit of units) {
      const normalized = normalizeForDedupe(unit);
      if (!normalized) {
        keptUnits.push(unit);
        continue;
      }

      const duplicate = seen.some((previous) => previous === normalized);
      if (duplicate) continue;

      seen.push(normalized);
      keptUnits.push(unit);
    }

    if (keptUnits.length > 0) keptLines.push(keptUnits.join(' ').trim());
  }

  return keptLines.join('\n');
}

function splitIntoSentences(line: string): string[] {
  return line.split(
    /(?<!\b[A-Z]\.)(?<!\be\.g)(?<!\bi\.e)(?<!\bvs)(?<!\betc)(?<=[.!?])\s+(?=["'A-Za-z0-9])/,
  );
}

function findBestSplit(text: string): number {
  const total = wordCount(text);
  const midpoint = total / 2;
  let bestIndex = -1;
  let bestDistance = Number.POSITIVE_INFINITY;

  const consider = (index: number, before: number, after: number): void => {
    if (before < 6 || after < 6) return;
    const distance = Math.abs(before - midpoint);
    if (distance < bestDistance) {
      bestDistance = distance;
      bestIndex = index;
    }
  };

  let match: RegExpExecArray | null;
  const commaConjunction = /,\s+(and|but|so|or|yet)\s+/gi;
  while ((match = commaConjunction.exec(text)) !== null) {
    const before = wordCount(text.slice(0, match.index));
    consider(match.index, before, total - before - 1);
  }

  const bareConjunction = /(?<!,)\s+(and|but|so|or|yet)\s+/gi;
  while ((match = bareConjunction.exec(text)) !== null) {
    const afterConjunction = text.slice(match.index + match[0].length);
    if (/^that\b/i.test(afterConjunction) && /\bso\s*$/i.test(match[0].trim())) continue;
    const before = wordCount(text.slice(0, match.index));
    consider(match.index, before, total - before - 1);
  }

  return bestIndex;
}

function enforceSentenceLength(sentence: string): string {
  if (wordCount(sentence) <= MAX_SUMMARY_SENTENCE_WORDS) return sentence;
  if (/[`]|:\/\/|https?:|e\.g\./i.test(sentence)) return sentence;

  const splitAt = findBestSplit(sentence);
  if (splitAt < 0) return sentence;

  const first = `${sentence.slice(0, splitAt).trimEnd().replace(/[.!?]+$/, '')}.`;
  const second = sentence
    .slice(splitAt + 1)
    .replace(/^\s*(?:and|but|so|or|yet)\s+/i, '')
    .trim();
  if (!second) return sentence;

  return `${first} ${capitalizeFirst(second)}`;
}

function simplifySummaryLine(line: string, capitalizeStarts: boolean): string {
  let current = line;
  for (let attempt = 0; attempt < 5; attempt++) {
    const next = splitIntoSentences(current)
      .map((sentence) => {
        const simplified = enforceSentenceLength(sentence.trim());
        return capitalizeStarts ? capitalizeFirst(simplified) : simplified;
      })
      .join(' ');
    if (next === current) return current;
    current = next;
  }
  return current;
}

/**
 * Apply safe, deterministic readability improvements to model-generated
 * summary prose. Ambiguous rewrites remain untouched.
 */
export function simplifySummaryProse(text: string): string {
  if (!text) return text;

  const protectedSpans: string[] = [];
  const spanIds = new Map<string, number>();
  const protect = (span: string): string => {
    let id = spanIds.get(span);
    if (id === undefined) {
      id = protectedSpans.length;
      spanIds.set(span, id);
      protectedSpans.push(span);
    }
    return `\uE000${id}\uE001`;
  };

  let simplified = text.replace(/```[\s\S]*?```|`[^`\n]*`|https?:\/\/[^\s<>)]+/gi, protect);
  let substitutionsApplied = false;
  for (const [pattern, replacement] of PLAIN_WORD_SUBSTITUTIONS) {
    const replaced = simplified.replace(pattern, replacement);
    substitutionsApplied ||= replaced !== simplified;
    simplified = replaced;
  }
  simplified = simplified
    .split('\n')
    .map((line) => line.replace(/[ \t]{2,}/g, ' ').trimEnd())
    .join('\n');
  simplified = dedupeSummaryLines(simplified);
  simplified = simplified
    .split('\n')
    .map((line) => (isListItem(line) ? line : simplifySummaryLine(line, substitutionsApplied)))
    .join('\n')
    .trim();

  return simplified.replace(/\uE000(\d+)\uE001/g, (_, id: string) => protectedSpans[Number(id)]);
}

/** Apply the same safe plain-English cleanup to inline finding comments. */
export function simplifyFindingBody(body: string): string {
  return simplifySummaryProse(body).replace(
    /(^|\n|\s+)(?:\*\*)?Suggested fix:\s*(?:\*\*)?\s*/gi,
    '$1',
  );
}

/**
 * Put each sentence on a visible Markdown list line when the model returns
 * several sentences as one paragraph.
 */
export function formatSummaryLines(text: string): string {
  const normalized = text.trim();
  if (!normalized || normalized.includes('\n')) return normalized;

  const body = normalized.replace(/^\s*(?:[-*•]|\d+\.)\s+/, '');
  const sentences = splitIntoSentences(body).map((sentence) => sentence.trim()).filter(Boolean);
  if (sentences.length < 2) return normalized;

  return sentences.map((sentence) => `- ${sentence}`).join('\n');
}

/**
 * Simplify summary prose, then put each sentence on a visible Markdown line.
 */
export function formatSummaryProse(text: string): string {
  return formatSummaryLines(simplifySummaryProse(text));
}
/**
 * Deterministic quality gate applied to all findings regardless of path:
 * 1. drop findings whose lines don't exist in the PR diff (hallucinated lines)
 * 2. drop low-confidence findings (criticals get a lower floor, flagged)
 * 3. dedupe overlapping same-category findings on the same file
 * 4. severity floor + rank by severity/confidence + cap
 */
export function validateAndRankFindings(
  findings: ReviewAnnotation[],
  changedFiles: ChangedFile[],
  config: ReviewConfig,
): ReviewAnnotation[] {
  const patches = new Map(changedFiles.map((f) => [f.filename, f.patch]));

  // 1. Diff validation
  const placeable = findings.filter((f) => {
    const patch = patches.get(f.path);
    if (!patch) return false;
    if (!lineToDiffPosition(patch, f.endLine).found) {
      logger.debug({ path: f.path, line: f.endLine }, 'Dropping finding: line not in diff');
      return false;
    }
    return true;
  });

  // 2. Confidence filter
  const confident = placeable.filter((f) => {
    const confidence = f.confidence ?? DEFAULT_CONFIDENCE;
    if (confidence >= config.pipeline.minConfidence) return true;
    if (f.severity === 'critical' && confidence >= CRITICAL_CONFIDENCE_FLOOR) {
      f.body = `${f.body}\n\n_(low confidence — please verify)_`;
      return true;
    }
    return false;
  });

  // 3. Dedupe: same file + same category + overlapping line ranges.
  //    Keep the higher-severity (then higher-confidence) finding.
  const sorted = [...confident].sort(
    (a, b) =>
      severityRank(a.severity) - severityRank(b.severity) ||
      (b.confidence ?? DEFAULT_CONFIDENCE) - (a.confidence ?? DEFAULT_CONFIDENCE),
  );
  const deduped: ReviewAnnotation[] = [];
  for (const finding of sorted) {
    const duplicate = deduped.some(
      (kept) =>
        kept.path === finding.path &&
        kept.category === finding.category &&
        kept.startLine <= finding.endLine &&
        finding.startLine <= kept.endLine,
    );
    if (!duplicate) deduped.push(finding);
  }

  // 4. Severity floor + cap (list is already ranked best-first)
  const minIdx = severityRank(config.review.minSeverity);
  return deduped
    .filter((f) => severityRank(f.severity) <= minIdx)
    .slice(0, config.review.maxAnnotations)
    .map((f) => ({ ...f, body: simplifyFindingBody(f.body) }));
}

export interface SynthesisInput {
  ctx: PullRequestContext;
  intent: IntentResult | null;
  outcomes: GroupReviewOutcome[];
  /** Findings that already passed validateAndRankFindings. */
  findings: ReviewAnnotation[];
}

/**
 * Pass 3: assemble the final ReviewResult. Uses one LLM call to write the
 * summary and prune near-duplicates/false positives; skipped for single-group
 * runs, and every LLM decision has a deterministic fallback.
 */
export async function synthesize(
  llm: LLMProvider,
  input: SynthesisInput,
  config: ReviewConfig,
  usage: UsageTracker,
): Promise<ReviewResult> {
  const { ctx, intent, outcomes, findings } = input;

  const failedGroups = outcomes.filter((o) => o.failed);
  const failedGroupNote =
    failedGroups.length > 0
      ? `${failedGroups.flatMap((o) => o.group.files).length} file(s) could not be fully reviewed (LLM call failed).`
      : undefined;
  const simplifySummary = config.experimental ? simplifySummaryProse : (text: string) => text;
  const formatSummary = config.experimental ? formatSummaryProse : (text: string) => text;
  let annotations = findings;
  let summary = '';
  let score: number | null = null;
  let walkthrough: WalkthroughEntry[] = (intent?.walkthrough ?? []).map((entry) => ({
    ...entry,
    summary: simplifySummary(entry.summary),
  }));

  const shouldCallLLM = outcomes.length > 1;
  if (shouldCallLLM) {
    try {
      const ids = new Map(findings.map((f, i) => [`f${i + 1}`, f]));
      const messages = [
        { role: 'system' as const, content: buildSynthesisSystemPrompt(config) },
        {
          role: 'user' as const,
          content: buildSynthesisUserPrompt({
            ctx,
            intent,
            groupSummaries: outcomes.map((o) => ({ label: o.group.label, summary: o.summary })),
            findings: [...ids.entries()].map(([id, f]) => ({
              id,
              line: `${id} | ${f.path}:${f.startLine}-${f.endLine} | ${f.severity} | ${(f.confidence ?? DEFAULT_CONFIDENCE).toFixed(2)} | ${f.title}`,
            })),
            failedGroupNote,
          }),
        },
      ];
      const startedAt = Date.now();
      usage.startCall();
      const model = modelForRole(config, 'synthesis');
      const response = await llm.chatCompletion({
        messages,
        model,
        responseFormat: { type: 'json_object' },
        maxTokens: 4_096,
        temperature: reviewTemperature(config, 0.3, model),
        timeoutMs: 90_000,
      });
      usage.add(response.usage, {
        model,
        stage: 'synthesis',
        messages,
        maxOutputTokens: 4_096,
        durationMs: Date.now() - startedAt,
        finishReason: response.finishReason,
      });

      const parsed = parseSynthesisResponse(response.content);
      if (parsed) {
        summary = formatSummary(parsed.summary);
        score = parsed.score;
        if (parsed.walkthrough.length > 0) {
          walkthrough = parsed.walkthrough.map((entry) => ({
            ...entry,
            summary: simplifySummary(entry.summary),
          }));
        }

        // Apply LLM pruning conservatively: never drop criticals.
        const toDrop = new Set<ReviewAnnotation>();
        for (const dupSet of parsed.nearDuplicates) {
          for (const id of dupSet.slice(1)) {
            const f = ids.get(id);
            if (f && f.severity !== 'critical') toDrop.add(f);
          }
        }
        for (const id of parsed.likelyFalsePositives) {
          const f = ids.get(id);
          if (!f) continue;
          if (f.severity === 'critical') {
            logger.info({ title: f.title }, 'Synthesis flagged a critical as false positive — keeping it');
            continue;
          }
          toDrop.add(f);
        }
        if (toDrop.size > 0) {
          logger.info({ dropped: toDrop.size }, 'Synthesis pruned findings');
          annotations = findings.filter((f) => !toDrop.has(f));
        }
        usage.emit({
          type: 'stage_result',
          stage: 'synthesis',
          status: 'success',
          findingsGenerated: findings.length,
          findingsRetained: annotations.length,
        });
      } else {
        usage.emit({ type: 'stage_result', stage: 'synthesis', status: 'failed' });
      }
    } catch (err) {
      usage.emit({ type: 'stage_result', stage: 'synthesis', status: 'failed' });
      logger.warn({ err }, 'Synthesis pass failed, using deterministic assembly');
    }
  }

  // Deterministic fallbacks
  if (!summary) {
    const parts = [
      intent?.intent ?? '',
      ...outcomes.map((o) => o.summary).filter(Boolean),
    ].filter(Boolean);
    summary = formatSummary(parts.join(' ') || 'Automated review completed.');
  }
  if (failedGroupNote) summary += `\n\n> ⚠️ ${failedGroupNote}`;

  const stats = countBySeverity(annotations);
  return {
    summary,
    score: score ?? deterministicScore(stats),
    annotations,
    stats,
    tokensUsed: usage.total(),
    walkthrough,
    intent: intent?.intent,
    callCount: usage.calls(),
  };
}

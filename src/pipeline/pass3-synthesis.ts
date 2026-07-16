import type {
  ChangedFile,
  PullRequestContext,
  ReviewAnnotation,
  ReviewResult,
  Severity,
  WalkthroughEntry,
} from '../types/review.js';
import type { ReviewConfig } from '../config/schema.js';
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
    .slice(0, config.review.maxAnnotations);
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

  let annotations = findings;
  let summary = '';
  let score: number | null = null;
  let walkthrough: WalkthroughEntry[] = intent?.walkthrough ?? [];

  const shouldCallLLM = outcomes.length > 1;
  if (shouldCallLLM) {
    try {
      const ids = new Map(findings.map((f, i) => [`f${i + 1}`, f]));
      const response = await llm.chatCompletion({
        messages: [
          { role: 'system', content: buildSynthesisSystemPrompt(config) },
          {
            role: 'user',
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
        ],
        responseFormat: { type: 'json_object' },
        maxTokens: 4_096,
        temperature: reviewTemperature(config),
        timeoutMs: 90_000,
      });
      usage.add(response.usage);

      const parsed = parseSynthesisResponse(response.content);
      if (parsed) {
        summary = parsed.summary;
        score = parsed.score;
        if (parsed.walkthrough.length > 0) walkthrough = parsed.walkthrough;

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
      }
    } catch (err) {
      logger.warn({ err }, 'Synthesis pass failed, using deterministic assembly');
    }
  }

  // Deterministic fallbacks
  if (!summary) {
    const parts = [
      intent?.intent ?? '',
      ...outcomes.map((o) => o.summary).filter(Boolean),
    ].filter(Boolean);
    summary = parts.join(' ') || 'Automated review completed.';
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

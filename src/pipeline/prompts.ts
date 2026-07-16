import type { ChangedFile, PullRequestContext } from '../types/review.js';
import type { ReviewConfig } from '../config/schema.js';
import type { FileGroup } from './grouper.js';
import type { IntentResult } from './schemas.js';
import { estimateTokens } from '../utils/tokens.js';

const LANGUAGE_NAMES: Record<ReviewConfig['language'], string> = {
  en: 'English',
  'zh-TW': 'Traditional Chinese (繁體中文)',
  'zh-CN': 'Simplified Chinese (简体中文)',
  ja: 'Japanese (日本語)',
  ko: 'Korean (한국어)',
};

const SEVERITY_RUBRIC = `## Severity Definitions
- critical: Bugs, security vulnerabilities, data loss risks — must fix before merge
- warning: Performance issues, potential bugs, bad practices — should fix
- suggestion: Code improvements, readability, maintainability — nice to have
- nitpick: Style preferences, minor formatting — optional`;

const CONFIDENCE_RUBRIC = `## Confidence
Every finding must carry a "confidence" between 0 and 1:
- 0.9–1.0: provable from the code shown (e.g. a null dereference on a visible path)
- 0.7–0.9: very likely, but depends on plausible assumptions about unshown code
- 0.5–0.7: plausible concern that needs verification
- below 0.5: speculative — usually not worth reporting`;

const QUALITY_BAR = `## Quality Bar
- Report only findings a strong senior engineer would raise in review.
- Do NOT report style or formatting issues unless they hide a bug.
- Prefer 2 deep, specific findings over 10 shallow observations.
- Every finding must cite the exact code shown — reference variable names, functions, and line numbers.
- Reason about how the pieces interact: callers, error paths, edge cases, concurrency — not just line-by-line pattern matching.
- If the code is genuinely fine, return an empty findings list. Silence beats noise.`;

const FINDING_SCHEMA = `{
  "path": "string — file path relative to repo root",
  "startLine": "number — starting line in the NEW version of the file (1-indexed)",
  "endLine": "number — ending line (1-indexed, >= startLine)",
  "severity": "critical | warning | suggestion | nitpick",
  "category": "bug | security | performance | style | best-practice | documentation | testing | other",
  "title": "string — short issue title",
  "body": "string — detailed explanation in markdown",
  "suggestedFix": "string | null — replacement code snippet for exactly lines startLine-endLine",
  "confidence": "number 0-1"
}`;

function sharedReviewerPreamble(config: ReviewConfig): string {
  const aspects = Object.entries(config.review.aspects)
    .filter(([, enabled]) => enabled)
    .map(([name]) => name)
    .join(', ');

  const customRules = config.rules
    .map((r) => `- [${r.severity}] ${r.name}: ${r.description}${r.filePattern ? ` (applies to ${r.filePattern})` : ''}`)
    .join('\n');

  const parts = [
    'You are an expert senior code reviewer. You review pull requests the way a meticulous staff engineer would: understanding what the change is trying to accomplish, then hunting for real problems.',
    '',
    `## Review Dimensions\nFocus on: ${aspects}`,
    '',
    SEVERITY_RUBRIC,
    '',
    CONFIDENCE_RUBRIC,
    '',
    QUALITY_BAR,
  ];

  if (config.language !== 'en') {
    parts.push('', `## Language\nWrite all summaries, titles, and finding bodies in ${LANGUAGE_NAMES[config.language]}. Keep code identifiers and code snippets as-is.`);
  }
  if (customRules) {
    parts.push('', `## Repository Rules\n${customRules}`);
  }
  if (config.prompt.reviewFocus) {
    parts.push('', `## Review Focus (from repository config)\n${config.prompt.reviewFocus}`);
  }
  if (config.prompt.systemAppend) {
    parts.push('', config.prompt.systemAppend);
  }

  return parts.join('\n');
}

// ---------------------------------------------------------------------------
// Pass 1: intent & walkthrough

export function buildIntentSystemPrompt(config: ReviewConfig): string {
  const language =
    config.language !== 'en'
      ? `\nWrite "intent" and all "summary" values in ${LANGUAGE_NAMES[config.language]}.`
      : '';
  return `You are a senior engineer skimming a pull request to understand it before a detailed review.

Analyze the PR and respond with a single JSON object:
{
  "intent": "1-3 sentences: what this PR does and why (its essence, not a file list)",
  "walkthrough": [{ "path": "file path", "summary": "one line: what changed in this file and its role in the PR" }],
  "groups": [{ "label": "short label", "files": ["paths that belong together logically and should be reviewed together"] }],
  "riskHotspots": [{ "path": "file path", "reason": "why this file deserves extra scrutiny" }]
}

Rules:
- Every changed file must appear in the walkthrough and in exactly one group.
- Group files that implement one logical change together (feature + its tests + its types).
- Mark at most 5 riskHotspots — the places where a bug would hurt most.${language}`;
}

const INTENT_PATCH_TOKEN_CAP = 2_000;
const INTENT_TOTAL_TOKEN_CAP = 25_000;

/** Truncate a unified patch at hunk boundaries to fit a token budget. */
export function truncatePatch(patch: string, tokenCap: number): string {
  if (estimateTokens(patch) <= tokenCap) return patch;
  const hunks = patch.split(/(?=^@@ )/m);
  const kept: string[] = [];
  let used = 0;
  for (const hunk of hunks) {
    const tokens = estimateTokens(hunk);
    if (used + tokens > tokenCap) break;
    kept.push(hunk);
    used += tokens;
  }
  if (kept.length === 0) {
    // Even the first hunk is too big — hard-truncate it.
    kept.push(patch.slice(0, tokenCap * 4));
  }
  return `${kept.join('')}\n... [patch truncated]`;
}

export function buildIntentUserPrompt(ctx: PullRequestContext): string {
  const parts: string[] = [];
  parts.push(`## Pull Request #${ctx.pullNumber}: ${ctx.title}`);
  if (ctx.body) parts.push(`\n### Description\n${ctx.body}`);

  parts.push(`\n### Changed Files (${ctx.changedFiles.length})`);
  parts.push('| File | Status | +/- |');
  parts.push('|------|--------|-----|');
  for (const f of ctx.changedFiles) {
    parts.push(`| ${f.filename} | ${f.status} | +${f.additions}/-${f.deletions} |`);
  }

  parts.push('\n### Patches');
  const byChangeSize = [...ctx.changedFiles].sort(
    (a, b) => b.additions + b.deletions - (a.additions + a.deletions),
  );
  let used = 0;
  for (const f of byChangeSize) {
    if (!f.patch) continue;
    const truncated = truncatePatch(f.patch, INTENT_PATCH_TOKEN_CAP);
    const tokens = estimateTokens(truncated);
    if (used + tokens > INTENT_TOTAL_TOKEN_CAP) {
      parts.push(`\n(remaining file patches omitted for budget — see the file table above)`);
      break;
    }
    used += tokens;
    parts.push(`\n#### ${f.filename}\n\`\`\`diff\n${truncated}\n\`\`\``);
  }

  parts.push('\nRespond with the JSON object described in the system prompt.');
  return parts.join('\n');
}

// ---------------------------------------------------------------------------
// Pass 2: per-group review

export function buildGroupSystemPrompt(config: ReviewConfig): string {
  return `${sharedReviewerPreamble(config)}

## Output Format
Respond with a single JSON object:
{
  "groupSummary": "2-3 sentences describing this group of changes",
  "findings": [${FINDING_SCHEMA}]
}

## Line Number Rules
- Only report findings on lines that are added or modified in the diff.
- startLine/endLine refer to the NEW version of the file (right side of the diff).
- suggestedFix must be a drop-in replacement for exactly the lines startLine-endLine.`;
}

export interface GroupPromptInput {
  ctx: PullRequestContext;
  group: FileGroup;
  intent: IntentResult | null;
  relatedFiles: Map<string, string>;
  deltaHint?: string;
}

export function buildGroupUserPrompt(input: GroupPromptInput): string {
  const { ctx, group, intent, relatedFiles, deltaHint } = input;
  const parts: string[] = [];

  // Stable-prefix block: identical across all groups of the same run so the
  // provider's prefix cache can reuse it after the first group call.
  parts.push(`## Pull Request #${ctx.pullNumber}: ${ctx.title}`);
  if (intent?.intent) parts.push(`\n### PR Intent\n${intent.intent}`);
  else if (ctx.body) parts.push(`\n### Description\n${ctx.body}`);

  if (deltaHint) parts.push(`\n${deltaHint}`);

  const hotspots = (intent?.riskHotspots ?? []).filter((h) =>
    group.files.some((f) => f.filename === h.path),
  );
  if (hotspots.length > 0) {
    parts.push('\n### Risk Hotspots — pay extra attention');
    for (const h of hotspots) parts.push(`- ${h.path}: ${h.reason}`);
  }

  if (relatedFiles.size > 0) {
    parts.push('\n### Related Files (unchanged — context only, do not review)');
    for (const [path, content] of relatedFiles) {
      parts.push(`\n#### ${path}\n\`\`\`\n${content}\n\`\`\``);
    }
  }

  if (!group.diffOnly) {
    const withContent = group.files.filter((f) => ctx.fileContents.has(f.filename));
    if (withContent.length > 0) {
      parts.push('\n### Changed Files — full contents (new version)');
      for (const f of withContent) {
        parts.push(`\n#### ${f.filename}\n\`\`\`\n${ctx.fileContents.get(f.filename)}\n\`\`\``);
      }
    }
  }

  parts.push(`\n### Diffs for this review group (${group.files.length} files)`);
  for (const f of group.files) {
    if (!f.patch) continue;
    parts.push(`\n#### ${f.filename}\n\`\`\`diff\n${f.patch}\n\`\`\``);
  }

  parts.push('\nReview ONLY the files in this group. Respond with the JSON object described in the system prompt.');
  return parts.join('\n');
}

// ---------------------------------------------------------------------------
// Pass 3: synthesis

export function buildSynthesisSystemPrompt(config: ReviewConfig): string {
  const language =
    config.language !== 'en'
      ? `\nWrite "summary" and walkthrough summaries in ${LANGUAGE_NAMES[config.language]}.`
      : '';
  return `You are the review lead consolidating parallel code-review results into one final review.

Respond with a single JSON object:
{
  "summary": "final PR review summary in markdown, 3-6 sentences: what the PR does, overall quality, the most important issues",
  "score": "number 0-100 (90-100 excellent, 70-89 good, 50-69 needs improvement, <50 significant issues)",
  "walkthrough": [{ "path": "file path", "summary": "one line per changed file" }],
  "nearDuplicates": [["finding ids that describe the same underlying issue"]],
  "likelyFalsePositives": ["finding ids that are probably wrong or not worth raising"]
}

Rules:
- Judge findings by the one-line descriptions given; do not invent new findings.
- Be conservative with likelyFalsePositives — only flag findings that clearly contradict the PR intent or duplicate the walkthrough's understanding.${language}`;
}

export interface SynthesisPromptInput {
  ctx: PullRequestContext;
  intent: IntentResult | null;
  groupSummaries: Array<{ label: string; summary: string }>;
  findings: Array<{ id: string; line: string }>;
  failedGroupNote?: string;
}

export function buildSynthesisUserPrompt(input: SynthesisPromptInput): string {
  const parts: string[] = [];
  parts.push(`## Pull Request #${input.ctx.pullNumber}: ${input.ctx.title}`);
  if (input.intent?.intent) parts.push(`\n### PR Intent\n${input.intent.intent}`);

  if (input.intent && input.intent.walkthrough.length > 0) {
    parts.push('\n### Draft Walkthrough');
    for (const w of input.intent.walkthrough) parts.push(`- ${w.path}: ${w.summary}`);
  }

  parts.push('\n### Group Summaries');
  for (const g of input.groupSummaries) {
    parts.push(`- **${g.label}**: ${g.summary || '(no summary)'}`);
  }

  parts.push(`\n### Findings (${input.findings.length})`);
  parts.push('id | location | severity | confidence | title');
  for (const f of input.findings) parts.push(f.line);

  if (input.failedGroupNote) parts.push(`\n> Note: ${input.failedGroupNote}`);

  parts.push('\nRespond with the JSON object described in the system prompt.');
  return parts.join('\n');
}

// ---------------------------------------------------------------------------
// Fast path: single combined call

export function buildFastPathSystemPrompt(config: ReviewConfig): string {
  return `${sharedReviewerPreamble(config)}

## Output Format
Respond with a single JSON object:
{
  "intent": "1-3 sentences: what this PR does and why",
  "summary": "overall review summary in markdown, 3-6 sentences",
  "score": "number 0-100 (90-100 excellent, 70-89 good, 50-69 needs improvement, <50 significant issues)",
  "walkthrough": [{ "path": "file path", "summary": "one line: what changed in this file" }],
  "findings": [${FINDING_SCHEMA}]
}

## Line Number Rules
- Only report findings on lines that are added or modified in the diff.
- startLine/endLine refer to the NEW version of the file (right side of the diff).
- suggestedFix must be a drop-in replacement for exactly the lines startLine-endLine.`;
}

export function buildFastPathUserPrompt(
  ctx: PullRequestContext,
  files: ChangedFile[],
  deltaHint?: string,
): string {
  const parts: string[] = [];
  parts.push(`## Pull Request #${ctx.pullNumber}: ${ctx.title}`);
  if (ctx.body) parts.push(`\n### Description\n${ctx.body}`);
  if (deltaHint) parts.push(`\n${deltaHint}`);

  const withContent = files.filter((f) => ctx.fileContents.has(f.filename));
  if (withContent.length > 0) {
    parts.push('\n### Changed Files — full contents (new version)');
    for (const f of withContent) {
      parts.push(`\n#### ${f.filename}\n\`\`\`\n${ctx.fileContents.get(f.filename)}\n\`\`\``);
    }
  }

  parts.push('\n### Diffs');
  for (const f of files) {
    if (!f.patch) continue;
    parts.push(`\n#### ${f.filename}\n\`\`\`diff\n${f.patch}\n\`\`\``);
  }

  parts.push('\nRespond with the JSON object described in the system prompt.');
  return parts.join('\n');
}

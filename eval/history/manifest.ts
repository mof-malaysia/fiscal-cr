import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';
import { ISSUE_CATEGORIES, SEVERITY_ORDER, type ExpectedIssue } from '../quality.js';

/**
 * The committed manifest of real-PR eval cases (`eval/history/cases.json`).
 *
 * The manifest holds pointers and hand-written labels only: repo, PR number,
 * pinned SHAs, licence, evidence link, size and the cause label. It never
 * holds third-party code, PR titles or bodies, or author identities. The code
 * is fetched at run time into a gitignored cache (see `materialize.ts`).
 *
 * Format reference: `eval/history/README.md`.
 */

export const HISTORY_MANIFEST_PATH = fileURLToPath(new URL('./cases.json', import.meta.url));

export const HISTORY_SCHEMA_VERSION = 1;
export const HISTORY_SUITE_ID = 'fiscalcr-eval-history';

/** OSI-permissive licences accepted for the history suite (SPDX ids). */
export const PERMISSIVE_LICENCES = [
  'MIT',
  'Apache-2.0',
  'BSD-2-Clause',
  'BSD-3-Clause',
  'ISC',
] as const;

const sha = z.string().regex(/^[0-9a-f]{40}$/, 'expected a full 40-char lowercase SHA');
const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/, 'expected an ISO UTC timestamp');
const repoName = z.string().regex(/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/, 'expected owner/name');

const lineRange = z
  .object({ startLine: z.number().int().positive(), endLine: z.number().int().positive() })
  .strict()
  .refine((r) => r.endLine >= r.startLine, 'endLine must be >= startLine');

const severity = z.enum(SEVERITY_ORDER as unknown as [string, ...string[]]);
const category = z.enum(ISSUE_CATEGORIES as unknown as [string, ...string[]]);

/** `ExpectedIssue` from `eval/quality.ts`, as JSON. */
const causeLabel = z
  .object({
    issueId: z.string().min(1),
    acceptedPaths: z.array(z.string().min(1)).min(1),
    acceptedLineRanges: z.array(lineRange).min(1),
    acceptedCategories: z.array(category).min(1),
    minSeverity: severity,
    maxSeverity: severity,
    expectedSeverity: severity.optional(),
    /** The one-sentence cause. */
    rationale: z.string().min(10),
    /** Where the cause is shown: the evidence link plus a short note. */
    evidence: z.string().min(10),
  })
  .strict();

const evidence = z
  .object({
    /** `revert`: a PR or commit that reverts P. `fix`: a PR that fixes lines P added or changed. */
    kind: z.enum(['revert', 'fix']),
    url: z.string().regex(/^https:\/\/github\.com\/[^/]+\/[^/]+\/(pull|commit|issues)\/[0-9a-f]+$/),
    /** Number of the revert or fix PR (the leak check looks for it in P's body). */
    pr: z.number().int().positive().optional(),
    mergedAt: isoDate,
  })
  .strict();

const baseCase = z.object({
  id: z.string().regex(/^[a-z0-9]+(-[a-z0-9]+)*$/, 'expected kebab-case'),
  repo: repoName,
  licence: z.enum(PERMISSIVE_LICENCES),
  pr: z.number().int().positive(),
  mergedAt: isoDate,
  baseSha: sha,
  headSha: sha,
  mergeSha: sha,
  /** Primary language of the changed code (lowercase), for the language mix. */
  language: z.string().min(1),
  size: z
    .object({
      files: z.number().int().nonnegative(),
      additions: z.number().int().nonnegative(),
      deletions: z.number().int().nonnegative(),
      /** Fast-path token estimate of the materialised context (patches + full files). */
      estimatedTokens: z.number().int().positive(),
    })
    .strict(),
  description: z
    .object({
      titleChars: z.number().int().positive(),
      bodyChars: z.number().int().nonnegative(),
    })
    .strict(),
  tags: z.array(z.string().regex(/^[a-z0-9-]+$/)),
});

const badCase = baseCase
  .extend({ kind: z.literal('bad'), evidence, cause: causeLabel })
  .strict();
const healthyCase = baseCase.extend({ kind: z.literal('healthy') }).strict();

export const historyCaseSchema = z.discriminatedUnion('kind', [badCase, healthyCase]);

export const historyManifestSchema = z
  .object({
    schemaVersion: z.literal(HISTORY_SCHEMA_VERSION),
    suiteId: z.literal(HISTORY_SUITE_ID),
    cases: z.array(historyCaseSchema),
  })
  .strict();

export type HistoryCase = z.infer<typeof historyCaseSchema>;
export type BadHistoryCase = Extract<HistoryCase, { kind: 'bad' }>;
export type HistoryManifest = z.infer<typeof historyManifestSchema>;

/** Tag every case with an empty PR body carries ("claimed" is weak there). */
export const EMPTY_BODY_TAG = 'empty-body';
/** Max bad cases from any one repo (selection rule). */
export const MAX_BAD_PER_REPO = 6;
/** Fast-path token target per case (the hard cap is `fastPathThreshold`). */
export const TARGET_CASE_TOKENS = 25_000;

/**
 * Parses and checks the manifest. Beyond the schema: unique ids, unique
 * (repo, pr) pairs, a cause label on every bad case and none on healthy ones
 * (enforced by the schema), at most MAX_BAD_PER_REPO bad cases per repo, the
 * empty-body tag matching bodyChars, and a revert/fix merged after P.
 */
export function validateManifest(raw: unknown): HistoryManifest {
  const manifest = historyManifestSchema.parse(raw);
  const problems: string[] = [];
  const ids = new Set<string>();
  const prs = new Set<string>();
  const badPerRepo = new Map<string, number>();

  for (const c of manifest.cases) {
    if (ids.has(c.id)) problems.push(`duplicate id "${c.id}"`);
    ids.add(c.id);
    const key = `${c.repo}#${c.pr}`;
    if (prs.has(key)) problems.push(`duplicate PR ${key}`);
    prs.add(key);

    const emptyBody = c.description.bodyChars === 0;
    if (emptyBody !== c.tags.includes(EMPTY_BODY_TAG)) {
      problems.push(`${c.id}: the "${EMPTY_BODY_TAG}" tag must be set exactly when bodyChars is 0`);
    }
    if (c.baseSha === c.headSha) problems.push(`${c.id}: baseSha equals headSha`);

    if (c.kind === 'bad') {
      badPerRepo.set(c.repo, (badPerRepo.get(c.repo) ?? 0) + 1);
      if (c.evidence.mergedAt <= c.mergedAt) {
        problems.push(`${c.id}: evidence must be merged after the PR`);
      }
      if (!c.cause.evidence.includes(c.evidence.url)) {
        problems.push(`${c.id}: cause.evidence must cite the evidence url`);
      }
      if (c.evidence.pr === c.pr) problems.push(`${c.id}: evidence PR is the PR itself`);
    }
  }
  for (const [repo, n] of badPerRepo) {
    if (n > MAX_BAD_PER_REPO) problems.push(`${repo}: ${n} bad cases (max ${MAX_BAD_PER_REPO})`);
  }
  if (problems.length > 0) {
    throw new Error(`Invalid history manifest:\n  - ${problems.join('\n  - ')}`);
  }
  return manifest;
}

export function readManifest(path: string = HISTORY_MANIFEST_PATH): HistoryManifest {
  return validateManifest(JSON.parse(readFileSync(path, 'utf8')));
}

/** The cause label as the matcher's `ExpectedIssue`. */
export function causeOf(c: HistoryCase): ExpectedIssue[] {
  return c.kind === 'bad' ? [c.cause as ExpectedIssue] : [];
}

export function ownerAndName(repo: string): { owner: string; name: string } {
  const [owner, name] = repo.split('/');
  return { owner, name };
}

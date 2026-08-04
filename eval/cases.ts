import type { PullRequestContext } from '../src/types/review.js';
import { estimateTokens } from '../src/utils/tokens.js';
import {
  ISSUE_CATEGORIES,
  SEVERITY_ORDER,
  type BenchmarkCase,
  type ExpectedIssue,
  type IssueCategory,
  type IssueSeverity,
  type LineRange,
} from './quality.js';

/**
 * Deterministic gold benchmark suite for the local fast-path eval.
 *
 * 10 synthetic PRs, each small enough to stay on the fast path
 * (`DEFAULT_CONFIG.pipeline.fastPathThreshold`), with 20 independently
 * identifiable gold issues across 8 defective cases and 2 closed-world clean
 * cases. No network, no filesystem, no real secrets.
 *
 * Manifest types (BenchmarkCase, ExpectedIssue, IssueSeverity, IssueCategory,
 * LineRange) are the canonical contract exported by `eval/quality.ts`
 * (the matcher lane). They are re-exported here, so this file holds only
 * fixture data and never duplicates type declarations. The matcher accepts
 * these cases directly (canonical `id`/`label`/`context`/`minSeverity`/
 * `maxSeverity`/`startLine` fields).
 */

export type { BenchmarkCase, ExpectedIssue, IssueCategory, IssueSeverity, LineRange } from './quality.js';

/** Severity constants — canonical order from the matcher lane. */
export const ISSUE_SEVERITIES: readonly IssueSeverity[] = SEVERITY_ORDER;

export { ISSUE_CATEGORIES } from './quality.js';

export const SUITE_ID = 'fiscalcr-local-fast-path';
export const SUITE_VERSION = 1;
/** Per-case manifest version (bump when a case's gold issues change). */
export const CASE_VERSION = 1;

/** The 3 smoke cases: one clean, one local correctness, one security. */
export const SMOKE_CASE_IDS: string[] = ['clean-01', 'local-01', 'security-01'];

// ---------------------------------------------------------------------------
// Issue authoring helpers

/**
 * Derives `expectedSeverity` for issues whose severity bounds collapse
 * (minSeverity === maxSeverity), matching the matcher's 'exact' grade.
 */
function normalizeIssues(issues: ExpectedIssue[]): ExpectedIssue[] {
  return issues.map((issue) => ({
    ...issue,
    ...(issue.minSeverity === issue.maxSeverity && issue.expectedSeverity === undefined
      ? { expectedSeverity: issue.minSeverity }
      : {}),
  }));
}

/** True when the case is expected to have zero gold issues (closed world). */
export function isCleanCase(c: BenchmarkCase): boolean {
  return c.expectedIssues.length === 0;
}

// ---------------------------------------------------------------------------
// Fixture builders

interface FixtureFile {
  filename: string;
  status: 'added' | 'modified';
  additions: number;
  deletions: number;
  content: string;
  patch: string;
}

/** New file: every line is an addition, so all new lines are commentable. */
function addedFile(filename: string, content: string): FixtureFile {
  const lines = content.replace(/\n$/, '').split('\n');
  return {
    filename,
    status: 'added',
    additions: lines.length,
    deletions: 0,
    content,
    patch: `@@ -0,0 +1,${lines.length} @@\n${lines.map((l) => `+${l}`).join('\n')}\n`,
  };
}

/** Modified file: handcrafted hunk; only hunk context/addition lines are commentable. */
function modifiedFile(
  filename: string,
  content: string,
  patch: string,
  additions: number,
  deletions: number,
): FixtureFile {
  return { filename, status: 'modified', additions, deletions, content, patch };
}

function makeContext(caseId: string, files: FixtureFile[], title: string, body: string): PullRequestContext {
  const pullNumber = ([...caseId].reduce((sum, ch) => sum + ch.charCodeAt(0), 0) % 900) + 100;
  return {
    owner: 'fiscal-cr',
    repo: 'eval-suite',
    pullNumber,
    baseSha: 'a'.repeat(40),
    headSha: 'b'.repeat(40),
    title,
    body,
    diff: files.map((f) => f.patch).join('\n'),
    changedFiles: files.map((f) => ({
      filename: f.filename,
      status: f.status,
      additions: f.additions,
      deletions: f.deletions,
      patch: f.patch,
    })),
    fileContents: new Map(files.map((f) => [f.filename, f.content])),
  };
}

interface CaseOptions {
  title: string;
  body: string;
  tags: string[];
  distractorNotes?: string;
}

function buildCase(
  caseId: string,
  opts: CaseOptions,
  files: FixtureFile[],
  expectedIssues: ExpectedIssue[],
): BenchmarkCase {
  return {
    id: caseId,
    version: CASE_VERSION,
    label: opts.title,
    tags: [...opts.tags],
    context: makeContext(caseId, files, opts.title, opts.body),
    expectedIssues: normalizeIssues(expectedIssues),
    ...(opts.distractorNotes ? { knownDistractors: [opts.distractorNotes] } : {}),
  };
}

// ---------------------------------------------------------------------------
// Case clean-01: ordinary, correct single-file change (closed world).

const FORMAT_TIME_FILE = `export function formatTime(totalSeconds: number): string {
  const whole = Math.max(0, Math.floor(totalSeconds));
  const minutes = Math.floor(whole / 60);
  const seconds = whole % 60;
  return \`\${String(minutes).padStart(2, '0')}:\${String(seconds).padStart(2, '0')}\`;
}
`;

const CLEAN_01 = buildCase(
  'clean-01',
  {
    title: 'Add timestamp formatting helper',
    body: 'Adds a small formatting helper used by the dashboard timers.',
    tags: ['clean', 'local', 'single-file'],
  },
  [addedFile('src/utils/format-time.ts', FORMAT_TIME_FILE)],
  [],
);

// ---------------------------------------------------------------------------
// Case clean-02: suspicious-looking but demonstrably safe dynamic-key writes.

const KEY_MAP_FILE = `/** Null-prototype map: immune to __proto__/constructor pollution. */
export function createKeyMap(): Record<string, string> {
  return Object.create(null);
}

export function put(map: Record<string, string>, key: string, value: string): void {
  map[\`cfg:\${key}\`] = value;
}
`;

const READ_KEY_FILE = `import { createKeyMap, put } from './key-map.js';

const store = createKeyMap();

export function save(key: string, value: string): void {
  put(store, key, value);
}

export function load(key: string): string | null {
  const namespaced = \`cfg:\${key}\`;
  return Object.prototype.hasOwnProperty.call(store, namespaced) ? store[namespaced] : null;
}
`;

const CLEAN_02 = buildCase(
  'clean-02',
  {
    title: 'Add settings store helpers',
    body: 'Introduces helpers for reading and writing user settings.',
    tags: ['clean', 'local', 'distractor'],
    distractorNotes:
      'Dynamic property writes with user-controlled keys look risky, but are provably safe: ' +
      'the map has a null prototype and every key is namespaced with a fixed prefix, so ' +
      'prototype pollution and key injection are impossible.',
  },
  [
    addedFile('src/store/key-map.ts', KEY_MAP_FILE),
    addedFile('src/store/read-key.ts', READ_KEY_FILE),
  ],
  [],
);

// ---------------------------------------------------------------------------
// Case local-01: local correctness — null deref + off-by-one bounds.

const INVOICE_TOTALS_FILE = `interface LineItem {
  qty: number;
  price: number;
}

/** Sum of all item totals. */
export function grandTotal(items: LineItem[]): number {
  return items.reduce((sum, item) => sum + item.qty * item.price, 0);
}

/** First item's price; throws when the list is empty. */
export function firstPrice(items: LineItem[]): number {
  const first = items[0];
  return first.price;
}

/** First \`n\` items; pushes \`undefined\` once n reaches the array length. */
export function takeN(items: LineItem[], n: number): LineItem[] {
  const out: LineItem[] = [];
  for (let i = 0; i <= n; i++) {
    out.push(items[i]);
  }
  return out;
}
`;

const LOCAL_01 = buildCase(
  'local-01',
  {
    title: 'Add invoice totals helpers',
    body: 'Adds invoice total helpers used by the billing screen.',
    tags: ['local-correctness', 'bug'],
  },
  [addedFile('src/invoice/totals.ts', INVOICE_TOTALS_FILE)],
  [
    {
      issueId: 'local-01-01',
      acceptedPaths: ['src/invoice/totals.ts'],
      acceptedLineRanges: [{ startLine: 14, endLine: 14 }],
      acceptedCategories: ['bug'],
      minSeverity: 'warning',
      maxSeverity: 'warning',
      rationale:
        'items[0] is undefined for an empty array and `first.price` then throws TypeError; ' +
        'no length guard precedes the deref (direct static reasoning).',
    },
    {
      issueId: 'local-01-02',
      acceptedPaths: ['src/invoice/totals.ts'],
      acceptedLineRanges: [{ startLine: 20, endLine: 20 }],
      acceptedCategories: ['bug'],
      minSeverity: 'suggestion',
      maxSeverity: 'suggestion',
      rationale:
        '`i <= n` reads items[n]; when n >= items.length the loop pushes undefined entries ' +
        '(off-by-one bounds; should clamp n to the array length).',
    },
  ],
);

// ---------------------------------------------------------------------------
// Case local-02: local correctness — switch fall-through + undefined arithmetic.

const COOLDOWN_FILE = `/** Cooldown delay (ms) for a given retry attempt. */
export function cooldownMs(attempt: number): number {
  let delay = 0;
  switch (attempt) {
    case 1:
      delay = 1_000;
      break;
    case 2:
      delay = 5_000;
    case 3:
      delay = 10_000;
      break;
    default:
      delay = 30_000;
  }
  return delay;
}
`;

const HEARTBEAT_FILE = `/** Milliseconds since the last recorded heartbeat. */
export function lastHeartbeatDelta(beats: number[]): number {
  const last = beats[beats.length - 1];
  return Date.now() - last;
}
`;

const LOCAL_02 = buildCase(
  'local-02',
  {
    title: 'Add session helpers',
    body: 'Adds session and cooldown helpers for the auth service.',
    tags: ['local-correctness', 'control-flow'],
  },
  [
    addedFile('src/session/cooldown.ts', COOLDOWN_FILE),
    addedFile('src/session/heartbeat.ts', HEARTBEAT_FILE),
  ],
  [
    {
      issueId: 'local-02-01',
      acceptedPaths: ['src/session/cooldown.ts'],
      acceptedLineRanges: [{ startLine: 9, endLine: 10 }],
      acceptedCategories: ['bug'],
      minSeverity: 'warning',
      maxSeverity: 'warning',
      rationale:
        'Missing `break` after case 2 lets attempt 2 fall through into case 3, so the second ' +
        'retry waits 10s instead of the intended 5s (switch control flow).',
    },
    {
      issueId: 'local-02-02',
      acceptedPaths: ['src/session/heartbeat.ts'],
      acceptedLineRanges: [{ startLine: 4, endLine: 4 }],
      acceptedCategories: ['bug'],
      minSeverity: 'warning',
      maxSeverity: 'warning',
      rationale:
        '`beats[beats.length - 1]` is undefined when beats is empty; `Date.now() - undefined` ' +
        'produces NaN with no guard (direct static reasoning).',
    },
  ],
);

// ---------------------------------------------------------------------------
// Case cross-01: cross-file caller/callee contract mismatches.

const PLANS_FILE = `/** Billing fields exposed to consumers. */
export function planDetails(planId: string): { id: string; priceUsd: number } {
  return { id: planId, priceUsd: planId === 'pro' ? 20 : 50 };
}

/** Finds a plan summary, or null when unknown. */
export function findPlan(planId: string): { planId: string; monthlyPrice: number } | null {
  if (planId === 'pro') return { planId, monthlyPrice: 20 };
  if (planId === 'team') return { planId, monthlyPrice: 50 };
  return null;
}
`;

const RECEIPT_FILE = `import { planDetails } from './plans.js';

/** Builds a receipt line for an invoice. */
export function receiptLine(planId: string): string {
  const details = planDetails(planId);
  // Reads a field the callee never returns.
  return \`\${details.id}: \$\${details.monthlyPrice.toFixed(2)}\`;
}
`;

const RECEIPT_PATCH = `@@ -4,3 +4,5 @@
 export function receiptLine(planId: string): string {
   const details = planDetails(planId);
+  // Reads a field the callee never returns.
+  return \`\${details.id}: \$\${details.monthlyPrice.toFixed(2)}\`;
 }
`;

const USAGE_REPORT_FILE = `import { findPlan } from './plans.js';

/** Formats a plan label for reports. */
export function planLabel(planId: string): string {
  const plan = findPlan(planId);
  return \`Plan \${plan.planId}\`;
}
`;

const CROSS_01 = buildCase(
  'cross-01',
  {
    title: 'Add billing plan helpers',
    body: 'Adds billing plan helpers shared by receipts and reports.',
    tags: ['cross-file', 'contract'],
  },
  [
    addedFile('src/billing/plans.ts', PLANS_FILE),
    modifiedFile('src/billing/receipt.ts', RECEIPT_FILE, RECEIPT_PATCH, 2, 0),
    addedFile('src/billing/usage-report.ts', USAGE_REPORT_FILE),
  ],
  [
    {
      issueId: 'cross-01-01',
      acceptedPaths: ['src/billing/receipt.ts'],
      acceptedLineRanges: [{ startLine: 7, endLine: 7 }],
      acceptedCategories: ['bug'],
      minSeverity: 'warning',
      maxSeverity: 'warning',
      rationale:
        'Callee returns { id, priceUsd }; caller reads details.monthlyPrice (undefined) and ' +
        'calls .toFixed — TypeError at runtime, compile error under strict TS (caller/callee mismatch).',
    },
    {
      issueId: 'cross-01-02',
      acceptedPaths: ['src/billing/usage-report.ts'],
      acceptedLineRanges: [{ startLine: 6, endLine: 6 }],
      acceptedCategories: ['bug'],
      minSeverity: 'warning',
      maxSeverity: 'warning',
      rationale:
        'findPlan is declared to return null for unknown plans; planLabel dereferences ' +
        'plan.planId without a null check, so an unknown plan throws TypeError.',
    },
  ],
);

// ---------------------------------------------------------------------------
// Case cross-02: cross-file serialization/schema mismatch.

const SERIALIZE_FILE = `export interface StoredEvent {
  version: number;
  eventType: string;
  payload: Record<string, unknown>;
}

/** Serializes an event to its wire form. */
export function serializeEvent(event: StoredEvent): string {
  return JSON.stringify({
    version: event.version,
    type: event.eventType,
    data: event.payload,
  });
}
`;

const DESERIALIZE_FILE = `export interface ParsedEvent {
  version: number;
  eventType: string;
  payload: Record<string, unknown>;
}

/** Parses a stored event back into a typed record. */
export function parseEvent(raw: string): ParsedEvent {
  const obj = JSON.parse(raw) as Record<string, unknown>;
  return {
    version: typeof obj.version === 'number' ? obj.version : 0,
    eventType: String(obj.eventType ?? ''),
    payload: (obj.payload ?? {}) as Record<string, unknown>,
  };
}
`;

const CROSS_02 = buildCase(
  'cross-02',
  {
    title: 'Add event serialization helpers',
    body: 'Adds event serialization helpers for the audit stream.',
    tags: ['cross-file', 'schema'],
  },
  [
    addedFile('src/events/serialize.ts', SERIALIZE_FILE),
    addedFile('src/events/deserialize.ts', DESERIALIZE_FILE),
  ],
  [
    {
      issueId: 'cross-02-01',
      acceptedPaths: ['src/events/deserialize.ts'],
      acceptedLineRanges: [{ startLine: 12, endLine: 13 }],
      acceptedCategories: ['bug'],
      minSeverity: 'warning',
      maxSeverity: 'warning',
      rationale:
        'Producer serializes { type, data }; consumer reads eventType and payload. The keys ' +
        'never match, so both fields always fall back to empty values (compare both files).',
    },
    {
      issueId: 'cross-02-02',
      acceptedPaths: ['src/events/deserialize.ts'],
      acceptedLineRanges: [{ startLine: 9, endLine: 9 }],
      acceptedCategories: ['bug'],
      minSeverity: 'warning',
      maxSeverity: 'warning',
      rationale:
        'JSON.parse on external/corrupt input throws uncaught and crashes the consumer; no ' +
        'try/catch and no schema validation around the parse.',
    },
  ],
);

// ---------------------------------------------------------------------------
// Case security-01: SQL injection + weak credential hashing.

const POOL_FILE = `/** Minimal query pool used by handlers. */
export const pool = {
  async query(sql: string): Promise<unknown[]> {
    return [];
  },
};
`;

const SEARCH_FILE = `import { pool } from '../db/pool.js';

/** Searches users by name fragment. */
export async function searchUsers(nameFragment: string): Promise<unknown[]> {
  const sql = \`SELECT id, name FROM users WHERE name LIKE '%\${nameFragment}%'\`;
  return pool.query(sql);
}
`;

const TOKEN_FILE = `import { createHash } from 'node:crypto';

/** Hashes an API key before storage. */
export function hashKey(apiKey: string): string {
  return createHash('md5').update(apiKey).digest('hex');
}
`;

const SECURITY_01 = buildCase(
  'security-01',
  {
    title: 'Add user search endpoint',
    body: 'Adds a user search endpoint and key hashing for the API.',
    tags: ['security', 'injection', 'crypto'],
  },
  [
    addedFile('src/db/pool.ts', POOL_FILE),
    addedFile('src/api/search.ts', SEARCH_FILE),
    addedFile('src/auth/token.ts', TOKEN_FILE),
  ],
  [
    {
      issueId: 'security-01-01',
      acceptedPaths: ['src/api/search.ts'],
      acceptedLineRanges: [{ startLine: 5, endLine: 5 }],
      acceptedCategories: ['security'],
      minSeverity: 'critical',
      maxSeverity: 'critical',
      rationale:
        'Raw user input is interpolated into a SQL string; a fragment like \' OR \'1\'=\'1 ' +
        'changes query semantics — classic SQL injection. Should use parameterized queries.',
    },
    {
      issueId: 'security-01-02',
      acceptedPaths: ['src/auth/token.ts'],
      acceptedLineRanges: [{ startLine: 5, endLine: 5 }],
      acceptedCategories: ['security'],
      minSeverity: 'warning',
      maxSeverity: 'warning',
      rationale:
        'MD5 is a fast, collision-prone hash unsuitable for credential storage; use a keyed, ' +
        'slow hash (scrypt/bcrypt/argon2). Weak algorithm for the stated use case.',
    },
  ],
);

// ---------------------------------------------------------------------------
// Case conc-01: concurrency race + poisoned cache + unbounded registry.

const RESULT_CACHE_FILE = `/** In-memory single-flight cache for async lookups. */
export class ResultCache {
  private store = new Map<string, Promise<string>>();

  async getOrFetch(key: string, fetch: () => Promise<string>): Promise<string> {
    const cached = this.store.get(key);
    if (cached) return cached;
    const value = await fetch();
    this.store.set(key, Promise.resolve(value));
    return value;
  }

  size(): number {
    return this.store.size;
  }
}
`;

const REGISTRY_FILE = `/** Registry of active job ids; entries are never removed. */
const activeJobs = new Set<string>();

export function registerJob(jobId: string): void {
  activeJobs.add(jobId);
}

export function activeJobCount(): number {
  return activeJobs.size;
}
`;

const CONC_01 = buildCase(
  'conc-01',
  {
    title: 'Add shared result cache',
    body: 'Adds a shared cache for expensive lookups.',
    tags: ['concurrency', 'resource'],
  },
  [
    addedFile('src/cache/result-cache.ts', RESULT_CACHE_FILE),
    addedFile('src/cache/registry.ts', REGISTRY_FILE),
  ],
  [
    {
      issueId: 'conc-01-01',
      acceptedPaths: ['src/cache/result-cache.ts'],
      acceptedLineRanges: [{ startLine: 8, endLine: 8 }],
      acceptedCategories: ['bug'],
      minSeverity: 'warning',
      maxSeverity: 'warning',
      rationale:
        'Check-then-act race: the await on fetch() yields between the cache check and the set, ' +
        'so two concurrent callers both miss and both fetch (duplicate side effects, non-idempotent).',
    },
    {
      issueId: 'conc-01-02',
      acceptedPaths: ['src/cache/result-cache.ts'],
      acceptedLineRanges: [{ startLine: 9, endLine: 9 }],
      acceptedCategories: ['bug'],
      minSeverity: 'warning',
      maxSeverity: 'warning',
      rationale:
        'A rejected fetch promise is stored and never deleted, so every later caller receives ' +
        'the same rejected promise — a permanently poisoned cache entry.',
    },
    {
      issueId: 'conc-01-03',
      acceptedPaths: ['src/cache/registry.ts'],
      acceptedLineRanges: [{ startLine: 5, endLine: 5 }],
      acceptedCategories: ['bug'],
      minSeverity: 'suggestion',
      maxSeverity: 'suggestion',
      rationale:
        'registerJob adds ids but nothing ever removes them; the Set grows without bound for ' +
        'the process lifetime (resource leak).',
    },
  ],
);

// ---------------------------------------------------------------------------
// Case perf-01: N+1 query + per-iteration regex recompile + quadratic concat.

const USERS_FILE = `/** Fetches one user row by id. */
export async function fetchUser(id: number): Promise<{ id: number; name: string }> {
  return { id, name: \`user-\${id}\` };
}
`;

const GENERATE_FILE = `import { fetchUser } from './users.js';

/** Builds one report line. */
function formatLine(user: { id: number; name: string }, label: string): string {
  return \`\${label}: \${user.name}\`;
}

/** Builds a CSV report for many user ids. */
export async function buildReport(userIds: number[]): Promise<string> {
  const lines: string[] = [];
  for (const id of userIds) {
    const user = await fetchUser(id);
    const label = /^\\d+$/.test(String(id)) ? 'num' : 'id';
    lines.push(formatLine(user, label));
  }
  let all = '';
  for (const line of lines) {
    all += line + '\\n';
  }
  return all;
}
`;

const GENERATE_PATCH = `@@ -4,3 +4,18 @@
 function formatLine(user: { id: number; name: string }, label: string): string {
   return \`\${label}: \${user.name}\`;
 }
+
+ /** Builds a CSV report for many user ids. */
+ export async function buildReport(userIds: number[]): Promise<string> {
+   const lines: string[] = [];
+   for (const id of userIds) {
+     const user = await fetchUser(id);
+     const label = /^\\d+$/.test(String(id)) ? 'num' : 'id';
+     lines.push(formatLine(user, label));
+   }
+   let all = '';
+   for (const line of lines) {
+     all += line + '\\n';
+   }
+   return all;
+ }
`;

const PERF_01 = buildCase(
  'perf-01',
  {
    title: 'Add report generation',
    body: 'Adds bulk report generation for the admin panel.',
    tags: ['performance', 'n-plus-one'],
  },
  [
    addedFile('src/reports/users.ts', USERS_FILE),
    modifiedFile('src/reports/generate.ts', GENERATE_FILE, GENERATE_PATCH, 15, 0),
  ],
  [
    {
      issueId: 'perf-01-01',
      acceptedPaths: ['src/reports/generate.ts'],
      acceptedLineRanges: [{ startLine: 12, endLine: 12 }],
      acceptedCategories: ['performance'],
      minSeverity: 'warning',
      maxSeverity: 'warning',
      rationale:
        'N+1: one await fetchUser(id) per id inside the loop — n round trips instead of a ' +
        'single batched query (unbounded repeated I/O).',
    },
    {
      issueId: 'perf-01-02',
      acceptedPaths: ['src/reports/generate.ts'],
      acceptedLineRanges: [{ startLine: 13, endLine: 13 }],
      acceptedCategories: ['performance'],
      minSeverity: 'suggestion',
      maxSeverity: 'suggestion',
      rationale:
        'The regex literal /^\\d+$/ is recompiled on every loop iteration; hoist it out of the loop.',
    },
    {
      issueId: 'perf-01-03',
      acceptedPaths: ['src/reports/generate.ts'],
      acceptedLineRanges: [{ startLine: 18, endLine: 18 }],
      acceptedCategories: ['performance'],
      minSeverity: 'suggestion',
      maxSeverity: 'suggestion',
      rationale:
        '`all += line` inside a loop is quadratic string concatenation; collect lines into an ' +
        'array and join once.',
    },
  ],
);

// ---------------------------------------------------------------------------
// Case mixed-01: three severities + distractor + tests.

const AUTH_FILE = `/** Throws unless the user is an admin. */
export function assertAdmin(user: { role: string } | null): void {
  if (user && user.role !== 'admin') {
    throw new Error('forbidden');
  }
}
`;

const NOTIFICATIONS_FILE = `export interface Notification {
  id: number;
  message: string;
}

/** Latest notification; undefined when none. */
export function latest(notifications: Notification[]): Notification | undefined {
  return notifications[notifications.length - 1];
}

/** Formats the latest notification for the dashboard. */
export function renderLatest(notifications: Notification[]): string {
  const last = latest(notifications);
  return \`Latest: \${last.message}\`;
}
`;

const NOTIFICATIONS_PATCH = `@@ -7,3 +7,9 @@
 export function latest(notifications: Notification[]): Notification | undefined {
   return notifications[notifications.length - 1];
 }
+
+ /** Formats the latest notification for the dashboard. */
+ export function renderLatest(notifications: Notification[]): string {
+   const last = latest(notifications);
+   return \`Latest: \${last.message}\`;
+ }
`;

const METRICS_FILE = `/** Builds a CSV blob from metrics rows. */
export function toCsv(rows: Array<{ label: string; value: number }>): string {
  let csv = 'label,value\\n';
  for (const row of rows) {
    csv += \`\${row.label},\${row.value}\\n\`;
  }
  return csv;
}
`;

const NOTIFICATIONS_TEST_FILE = `import { renderLatest } from './notifications.js';

test('renders the latest notification', () => {
  expect(renderLatest([{ id: 1, message: 'hello' }])).toBe('Latest: hello');
});
`;

const FORMAT_FILE = `/** Compares a readiness flag; loose == is safe here. */
export function isReady(status: string | null): boolean {
  return status == 'ready';
}
`;

const MIXED_01 = buildCase(
  'mixed-01',
  {
    title: 'Add admin notifications dashboard',
    body: 'Adds an admin notifications dashboard.',
    tags: ['mixed', 'security', 'bug', 'performance', 'testing', 'distractor'],
    distractorNotes:
      'isReady uses loose == but is provably safe (string-or-null left operand compared to a ' +
      'string literal) — do not report it. Real defects: the auth bypass in assertAdmin, the ' +
      'undefined deref in renderLatest, the quadratic CSV concatenation, and the missing ' +
      'empty-input test in notifications.test.ts.',
  },
  [
    addedFile('src/admin/auth.ts', AUTH_FILE),
    modifiedFile('src/admin/notifications.ts', NOTIFICATIONS_FILE, NOTIFICATIONS_PATCH, 6, 0),
    addedFile('src/admin/metrics.ts', METRICS_FILE),
    addedFile('src/admin/notifications.test.ts', NOTIFICATIONS_TEST_FILE),
    addedFile('src/admin/format.ts', FORMAT_FILE),
  ],
  [
    {
      issueId: 'mixed-01-01',
      acceptedPaths: ['src/admin/auth.ts'],
      acceptedLineRanges: [{ startLine: 3, endLine: 3 }],
      acceptedCategories: ['security'],
      minSeverity: 'critical',
      maxSeverity: 'critical',
      rationale:
        'assertAdmin(null) does not throw: `user && ...` short-circuits for a null ' +
        '(unauthenticated) user, so admin-only actions become public — auth bypass.',
    },
    {
      issueId: 'mixed-01-02',
      acceptedPaths: ['src/admin/notifications.ts'],
      acceptedLineRanges: [{ startLine: 14, endLine: 14 }],
      acceptedCategories: ['bug'],
      minSeverity: 'warning',
      maxSeverity: 'warning',
      rationale:
        'latest() returns undefined for an empty list; `last.message` dereferences it and ' +
        'throws TypeError with no guard.',
    },
    {
      issueId: 'mixed-01-03',
      acceptedPaths: ['src/admin/metrics.ts'],
      acceptedLineRanges: [{ startLine: 5, endLine: 5 }],
      acceptedCategories: ['performance'],
      minSeverity: 'suggestion',
      maxSeverity: 'suggestion',
      rationale:
        '`csv +=` inside a loop is quadratic string building; build an array and join once.',
    },
    {
      issueId: 'mixed-01-04',
      acceptedPaths: ['src/admin/notifications.test.ts'],
      acceptedLineRanges: [{ startLine: 4, endLine: 4 }],
      acceptedCategories: ['testing'],
      minSeverity: 'suggestion',
      maxSeverity: 'suggestion',
      rationale:
        'The only test covers the non-empty path; the empty-list crash in renderLatest is ' +
        'untested (coverage gap for a real defect).',
    },
  ],
);

// ---------------------------------------------------------------------------
// Suite exports

export const EVAL_CASES: BenchmarkCase[] = [
  CLEAN_01,
  CLEAN_02,
  LOCAL_01,
  LOCAL_02,
  CROSS_01,
  CROSS_02,
  SECURITY_01,
  CONC_01,
  PERF_01,
  MIXED_01,
];

/** Exactly the 3 smoke cases (subset of EVAL_CASES). */
export function getSmokeCaseIds(): string[] {
  return [...SMOKE_CASE_IDS];
}

/** All 10 case ids. */
export function getFullCaseIds(): string[] {
  return EVAL_CASES.map((c) => c.id);
}

export function getCaseById(caseId: string): BenchmarkCase {
  const found = EVAL_CASES.find((c) => c.id === caseId);
  if (!found) {
    throw new Error(
      `Unknown eval case id "${caseId}". Known ids: ${getFullCaseIds().join(', ')}`,
    );
  }
  return found;
}

export function getCases(ids: string[]): BenchmarkCase[] {
  return ids.map((id) => getCaseById(id));
}

/** Resolves an exact comma-separated selection, e.g. "clean-01, local-01". */
export function getCaseIds(csv: string): string[] {
  const ids = csv
    .split(',')
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
  if (ids.length === 0) {
    throw new Error('No eval case ids provided (expected comma-separated ids).');
  }
  const known = new Set(getFullCaseIds());
  const unknown = ids.filter((id) => !known.has(id));
  if (unknown.length > 0) {
    throw new Error(
      `Unknown eval case id(s): ${unknown.join(', ')}. Known ids: ${getFullCaseIds().join(', ')}`,
    );
  }
  return ids;
}

/**
 * Mirrors ReviewOrchestrator's fast-path token accounting
 * (sum of patch tokens + file content tokens).
 */
export function estimateContextTokens(ctx: PullRequestContext): number {
  const patches = ctx.changedFiles.reduce(
    (sum, f) => sum + (f.patch ? estimateTokens(f.patch) : 0),
    0,
  );
  const contents = [...ctx.fileContents.values()].reduce(
    (sum, content) => sum + estimateTokens(content),
    0,
  );
  return patches + contents;
}

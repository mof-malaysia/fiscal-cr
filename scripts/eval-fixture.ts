import type { PullRequestContext } from '../src/types/review.js';

/**
 * Deterministic synthetic PR for the local LLM eval harness.
 *
 * No GitHub API, no network, no real secrets. The unified diff hunks carry
 * exact line numbers so the model can cite them and code-side post-validation
 * (validateAndRankFindings) has genuine added/modified lines to check against.
 * The retry change deliberately references an undefined `sleep` helper so a
 * real model has a concrete bug to find.
 */

const RETRY_FILE = `/**
 * Retries an async function with exponential backoff.
 * Keeps the last error if all attempts fail.
 */
export function retry<T>(fn: () => Promise<T>, attempts = 3): Promise<T> {
  let lastError: unknown;
  for (let i = 0; i < attempts; i++) {
    try {
      return await fn();
    } catch (err) {
      lastError = err;
      if (i < attempts - 1) {
        await sleep(100 * 2 ** i);
      }
    }
  }
  throw lastError;
}
`;

// Modified file: three lines inserted at new lines 12-14 (hunk -6,9 +6,12).
const RETRY_PATCH = `@@ -6,9 +6,12 @@
  let lastError: unknown;
  for (let i = 0; i < attempts; i++) {
    try {
      return await fn();
    } catch (err) {
      lastError = err;
+      if (i < attempts - 1) {
+        await sleep(100 * 2 ** i);
+      }
    }
  }
  throw lastError;
`;

const CACHE_LINES = [
  "import { createClient } from 'redis';",
  '',
  "const REDIS_URL = process.env.REDIS_URL ?? 'redis://127.0.0.1:6379';",
  '',
  'export class ReviewCache {',
  '  private client = createClient({ url: REDIS_URL });',
  '',
  '  async get(key: string): Promise<string | null> {',
  '    await this.client.connect();',
  '    const value = await this.client.get(`fiscalcr:${key}`);',
  '    await this.client.disconnect();',
  '    return value;',
  '  }',
  '',
  '  async set(key: string, value: string, ttlSeconds = 300): Promise<void> {',
  '    await this.client.connect();',
  '    await this.client.set(`fiscalcr:${key}`, value, { EX: ttlSeconds });',
  '    await this.client.disconnect();',
  '  }',
  '}',
];

const CACHE_FILE = `${CACHE_LINES.join('\n')}\n`;
// New file: every line added (hunk -0,0 +1,20).
const CACHE_PATCH = `@@ -0,0 +1,${CACHE_LINES.length} @@
${CACHE_LINES.map((line) => `+${line}`).join('\n')}
`;

export function buildSyntheticContext(): PullRequestContext {
  return {
    owner: 'fiscal-cr',
    repo: 'synthetic-eval',
    pullNumber: 42,
    baseSha: 'a'.repeat(40),
    headSha: 'b'.repeat(40),
    title: 'Add Redis-backed review cache and retry backoff',
    body: 'Caches review results in Redis to avoid repeated LLM calls, and adds ' +
      'exponential backoff to the retry helper so transient failures do not ' +
      'hammer the API.',
    diff: `${RETRY_PATCH}\n${CACHE_PATCH}`,
    changedFiles: [
      {
        filename: 'src/utils/retry.ts',
        status: 'modified',
        additions: 3,
        deletions: 0,
        patch: RETRY_PATCH,
      },
      {
        filename: 'src/utils/cache.ts',
        status: 'added',
        additions: CACHE_LINES.length,
        deletions: 0,
        patch: CACHE_PATCH,
      },
    ],
    fileContents: new Map([
      ['src/utils/retry.ts', RETRY_FILE],
      ['src/utils/cache.ts', CACHE_FILE],
    ]),
  };
}

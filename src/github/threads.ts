import type { FiscalcrOctokit } from './client.js';
import type { ReviewedRange, Severity } from '../types/review.js';
import { extractFingerprint } from './fingerprint.js';
import { logger } from '../utils/logger.js';

export interface FiscalcrThread {
  id: string;
  isResolved: boolean;
  path: string;
  line?: number | null;
  originalLine?: number | null;
  fingerprint: string;
  severity: Severity | null;
}

interface ThreadsQueryResponse {
  repository: {
    pullRequest: {
      reviewThreads: {
        pageInfo: {
          hasNextPage: boolean;
          endCursor: string | null;
        };
        nodes: Array<{
          id: string;
          isResolved: boolean;
          isOutdated?: boolean;
          path: string | null;
          line?: number | null;
          originalLine?: number | null;
          comments: {
            nodes: Array<{ body: string | null }>;
          };
        }>;
      };
    };
  };
}

const THREADS_QUERY = `
query($owner: String!, $repo: String!, $number: Int!, $cursor: String) {
  repository(owner: $owner, name: $repo) {
    pullRequest(number: $number) {
      reviewThreads(first: 100, after: $cursor) {
        pageInfo { hasNextPage endCursor }
        nodes {
          id
          isResolved
          isOutdated
          path
          line
          originalLine
          comments(first: 1) { nodes { body } }
        }
      }
    }
  }
}`;

/** Return whether the host supplied the optional GraphQL capability. */
export function hasGraphql(
  octokit: FiscalcrOctokit,
): octokit is FiscalcrOctokit & { graphql: NonNullable<FiscalcrOctokit['graphql']> } {
  return typeof octokit.graphql === 'function';
}

const SEVERITY_RE = /\*\*\[(critical|warning|suggestion|nitpick)\]\*\*/;

/**
 * List review threads on the PR that FiscalCR created, identified by the
 * hidden fingerprint marker in the thread's first comment.
 */
export async function listFiscalcrThreads(
  octokit: FiscalcrOctokit,
  params: { owner: string; repo: string; pullNumber: number },
  options: { includeOutdated?: boolean } = {},
): Promise<FiscalcrThread[]> {
  if (!hasGraphql(octokit)) {
    logger.warn('GraphQL unavailable — skipping FiscalCR thread lifecycle operations');
    return [];
  }
  const graphql = octokit.graphql;
  const includeOutdated = options.includeOutdated ?? false;
  const threads: FiscalcrThread[] = [];
  let cursor: string | null = null;

  do {
    const response: ThreadsQueryResponse = await graphql(THREADS_QUERY, {
      owner: params.owner,
      repo: params.repo,
      number: params.pullNumber,
      cursor,
    });
    const page = response.repository.pullRequest.reviewThreads;
    for (const node of page.nodes) {
      if (node.isOutdated && !includeOutdated) continue;
      const body = node.comments.nodes[0]?.body ?? '';
      const fingerprint = extractFingerprint(body);
      if (!fingerprint) continue;
      threads.push({
        id: node.id,
        isResolved: node.isResolved,
        path: node.path ?? '',
        line: node.line ?? null,
        originalLine: node.originalLine ?? null,
        fingerprint,
        severity: (body.match(SEVERITY_RE)?.[1] as Severity | undefined) ?? null,
      });
    }
    cursor = page.pageInfo.hasNextPage ? page.pageInfo.endCursor : null;
  } while (cursor);

  return threads;
}

/**
 * Resolve unresolved FiscalCR threads whose file changed in this run but whose
 * finding did not recur. This path intentionally includes outdated threads;
 * manual webhook handling uses the default current-thread view. Returns the
 * threads actually resolved so the caller can mark them fixed. All failures
 * (403 on default tokens, merged PRs, …) degrade to logging — never fail the
 * review over cleanup.
 */
export async function resolveOutdatedThreads(
  octokit: FiscalcrOctokit,
  params: {
    owner: string;
    repo: string;
    pullNumber: number;
    /** Paths reviewed in this run — only their threads can be judged outdated. */
    changedPaths: Set<string>;
    /** Delta line manifest, when paths alone are too broad. */
    reviewedRanges?: ReviewedRange[];
    /** Fingerprints of findings that still exist after this run. */
    currentFingerprints: Set<string>;
    headSha: string;
  },
): Promise<FiscalcrThread[]> {
  let threads: FiscalcrThread[];
  try {
    threads = await listFiscalcrThreads(octokit, params, { includeOutdated: true });
  } catch (err) {
    logger.warn({ err }, 'Could not list review threads — skipping thread resolution');
    return [];
  }
  if (!hasGraphql(octokit)) return [];
  const graphql = octokit.graphql;
  const outdated = threads.filter((t) => {
    const lineCovered =
      !params.reviewedRanges?.length ||
      [t.line, t.originalLine].some(
        (line) =>
          line != null &&
          params.reviewedRanges!.some(
            (range) =>
              range.path === t.path &&
              range.startLine <= line &&
              line <= range.endLine,
          ),
      );
    return (
      !t.isResolved &&
      params.changedPaths.has(t.path) &&
      lineCovered &&
      !params.currentFingerprints.has(t.fingerprint)
    );
  });

  const resolved: FiscalcrThread[] = [];
  for (const thread of outdated) {
    try {
      await graphql(
        `mutation($threadId: ID!, $body: String!) {
          addPullRequestReviewThreadReply(input: { pullRequestReviewThreadId: $threadId, body: $body }) {
            comment { id }
          }
          resolveReviewThread(input: { threadId: $threadId }) {
            thread { id }
          }
        }`,
        {
          threadId: thread.id,
          body: `✅ Resolved automatically — code changed in \`${params.headSha.slice(0, 7)}\`.`,
        },
      );
      resolved.push(thread);
    } catch (err) {
      logger.warn({ err, threadId: thread.id }, 'Could not resolve review thread — skipping');
    }
  }
  const failed = outdated.length - resolved.length;
  if (failed > 0) {
    logger.warn(
      { failed, attempted: outdated.length },
      `${failed} outdated inline thread${failed === 1 ? '' : 's'} could not be resolved`,
    );
  }
  if (resolved.length > 0) {
    logger.info({ resolved: resolved.length }, 'Outdated review threads resolved');
  }
  return resolved;
}

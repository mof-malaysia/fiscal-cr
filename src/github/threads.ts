import type { Octokit } from '@octokit/rest';
import type { Severity } from '../types/review.js';
import { extractFingerprint } from './fingerprint.js';
import { logger } from '../utils/logger.js';

export interface FiscalcrThread {
  id: string;
  isResolved: boolean;
  path: string;
  fingerprint: string;
  severity: Severity | null;
}

interface ThreadsQueryResponse {
  repository: {
    pullRequest: {
      reviewThreads: {
        pageInfo: { hasNextPage: boolean; endCursor: string | null };
        nodes: Array<{
          id: string;
          isResolved: boolean;
          path: string | null;
          comments: { nodes: Array<{ body: string | null }> };
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
          path
          comments(first: 1) { nodes { body } }
        }
      }
    }
  }
}`;

const SEVERITY_RE = /\*\*\[(critical|warning|suggestion|nitpick)\]\*\*/;

/**
 * List review threads on the PR that FiscalCR created, identified by the
 * hidden fingerprint marker in the thread's first comment.
 */
export async function listFiscalcrThreads(
  octokit: Octokit,
  params: { owner: string; repo: string; pullNumber: number },
): Promise<FiscalcrThread[]> {
  const threads: FiscalcrThread[] = [];
  let cursor: string | null = null;

  do {
    const response: ThreadsQueryResponse = await octokit.graphql(THREADS_QUERY, {
      owner: params.owner,
      repo: params.repo,
      number: params.pullNumber,
      cursor,
    });
    const page = response.repository.pullRequest.reviewThreads;
    for (const node of page.nodes) {
      const body = node.comments.nodes[0]?.body ?? '';
      const fingerprint = extractFingerprint(body);
      if (!fingerprint) continue;
      threads.push({
        id: node.id,
        isResolved: node.isResolved,
        path: node.path ?? '',
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
 * finding did not recur. Returns the threads actually resolved so the caller
 * can adjust its open-finding counts. All failures (403 on default tokens,
 * merged PRs, …) degrade to logging — never fail the review over cleanup.
 */
export async function resolveOutdatedThreads(
  octokit: Octokit,
  params: {
    owner: string;
    repo: string;
    pullNumber: number;
    /** Paths reviewed in this run — only their threads can be judged outdated. */
    changedPaths: Set<string>;
    /** Fingerprints of findings that still exist after this run. */
    currentFingerprints: Set<string>;
    headSha: string;
  },
): Promise<FiscalcrThread[]> {
  let threads: FiscalcrThread[];
  try {
    threads = await listFiscalcrThreads(octokit, params);
  } catch (err) {
    logger.warn({ err }, 'Could not list review threads — skipping thread resolution');
    return [];
  }

  const outdated = threads.filter(
    (t) =>
      !t.isResolved &&
      params.changedPaths.has(t.path) &&
      !params.currentFingerprints.has(t.fingerprint),
  );

  const resolved: FiscalcrThread[] = [];
  for (const thread of outdated) {
    try {
      await octokit.graphql(
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

  if (resolved.length > 0) {
    logger.info({ resolved: resolved.length }, 'Outdated review threads resolved');
  }
  return resolved;
}

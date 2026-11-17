// Candidate collector for the history suite. A maintainer tool: it is never
// run by tests, the dry run, or CI, and makes read-only GitHub API calls only
// (no provider calls). Output goes to stdout; nothing here writes the
// manifest. A human reads each candidate's evidence and writes the cause label.
//
//   tsx eval/history/collect.ts bad <owner/repo> [--since YYYY-MM-DD]
//       Merged PRs titled like a revert, resolved to the PR they revert, plus
//       merged fix PRs (labelled bug/regression/hotfix) that link an earlier PR
//       merged within 30 days.
//   tsx eval/history/collect.ts healthy <owner/repo> [--since YYYY-MM-DD] [--until YYYY-MM-DD] [--limit N]
//       Merged, non-bot, non-docs PRs whose changed files saw no fix- or
//       revert-type commit within 90 days after the merge.
//   tsx eval/history/collect.ts draft <owner/repo> <pr> [--revert|--fix <evidence-url>]
//       A manifest entry with pinned SHAs, licence, size and description
//       lengths measured from the materialised context. The cause label is
//       left as a TODO for a human.
import type { Octokit } from '@octokit/rest';
import type { ChangedFile } from '../../src/types/review.js';

// Silence the pino logger the src modules use before they load.
process.env.LOG_LEVEL = 'fatal';
const { DEFAULT_CONFIG } = await import('../../src/config/defaults.js');
const { filterFiles } = await import('../../src/review/file-filter.js');
const { EMPTY_BODY_TAG, PERMISSIVE_LICENCES, TARGET_CASE_TOKENS, ownerAndName } = await import('./manifest.js');
const { toContext } = await import('./loader.js');
const { ISSUE_CATEGORIES } = await import('../quality.js');
const { createOctokit, fetchHistoryCase, measure } = await import('./materialize.js');

const REVERT_WINDOW_DAYS = 30;
const HEALTHY_WINDOW_DAYS = 90;
const FIX_LABELS = /\b(bug|regression|hotfix)\b/i;
const FIX_MESSAGE = /^(revert\b|fix(\(|:|!|\b))|\bhotfix\b|\bregression\b/i;
/** Conventional-commit types and release titles that are not code changes. */
const NOT_CODE_TITLE = /^(revert|chore|ci|build|docs|test|style|release|\[ci\]|version packages)\b/i;
const NOT_SOURCE = /(^|\/)(tests?|__tests__|fixtures?|snapshots?|benchmarks?|scripts|\.github)\/|\.(test|spec)\.|_test\.|\.snap$/i;
const DOCS_ONLY = /(\.mdx?$|^docs?\/|\/docs?\/|\.txt$|^\.changeset\/|CHANGELOG)/i;

const DAY_MS = 86_400_000;

function arg(argv: string[], flag: string): string | undefined {
  const i = argv.indexOf(flag);
  return i >= 0 ? argv[i + 1] : undefined;
}

function defaultSince(): string {
  return new Date(Date.now() - 365 * DAY_MS).toISOString().slice(0, 10);
}

async function licenceOf(octokit: Octokit, owner: string, repo: string): Promise<string> {
  const { data } = await octokit.repos.get({ owner, repo });
  return data.license?.spdx_id ?? 'NOASSERTION';
}

async function searchMergedPrs(octokit: Octokit, q: string, max = 100) {
  const { data } = await octokit.search.issuesAndPullRequests({ q, per_page: Math.min(max, 100), sort: 'created', order: 'desc' });
  return data.items;
}

/** The PR number a revert PR points at, from its title, body or reverted commit. */
async function revertedPr(octokit: Octokit, owner: string, repo: string, title: string, body: string): Promise<number | null> {
  const ref = new RegExp(`Reverts ${owner}/${repo}#(\\d+)`, 'i').exec(body) ?? /\(#(\d+)\)"?\s*$/.exec(title) ?? /#(\d+)/.exec(title);
  if (ref) return Number(ref[1]);
  const commit = /This reverts commit ([0-9a-f]{7,40})/i.exec(body);
  if (commit) {
    const { data } = await octokit.repos.listPullRequestsAssociatedWithCommit({ owner, repo, commit_sha: commit[1] });
    const merged = data.find((p) => p.merged_at);
    if (merged) return merged.number;
  }
  return null;
}

type PrFile = { filename: string; status: string; additions: number; deletions: number; patch?: string };

interface PrFacts {
  number: number;
  mergedAt: string | null;
  bot: boolean;
  docsOnly: boolean;
  files: number;
  additions: number;
  deletions: number;
  bodyChars: number;
}

/** Days from `from` to `to`, to one decimal. */
function gapDays(from: string, to: string): number {
  return Math.round(((Date.parse(to) - Date.parse(from)) / DAY_MS) * 10) / 10;
}

async function prFacts(octokit: Octokit, owner: string, repo: string, n: number): Promise<{ facts: PrFacts; files: PrFile[] }> {
  const { data: pr } = await octokit.pulls.get({ owner, repo, pull_number: n });
  const files = await octokit.paginate(octokit.pulls.listFiles, { owner, repo, pull_number: n, per_page: 100 });
  const facts: PrFacts = {
    number: n,
    mergedAt: pr.merged_at,
    bot: pr.user?.type === 'Bot' || /\[bot\]$|^(renovate|dependabot)/i.test(pr.user?.login ?? ''),
    docsOnly: files.length > 0 && files.every((f) => DOCS_ONLY.test(f.filename)),
    files: files.length,
    additions: pr.additions,
    deletions: pr.deletions,
    bodyChars: (pr.body ?? '').length,
  };
  return { facts, files };
}

async function collectBad(octokit: Octokit, fullRepo: string, since: string): Promise<void> {
  const { owner, name } = ownerAndName(fullRepo);
  const reverts = await searchMergedPrs(octokit, `repo:${fullRepo} is:pr is:merged merged:>=${since} revert in:title`);
  for (const r of reverts) {
    if (/revert "revert/i.test(r.title)) continue; // revert-of-revert
    const { data: rp } = await octokit.pulls.get({ owner, repo: name, pull_number: r.number });
    const target = await revertedPr(octokit, owner, name, r.title, rp.body ?? '');
    if (target === null) {
      console.log(JSON.stringify({ kind: 'revert', evidence: r.html_url, target: null, title: r.title }));
      continue;
    }
    const { facts: p } = await prFacts(octokit, owner, name, target);
    const gap = p.mergedAt && rp.merged_at ? gapDays(p.mergedAt, rp.merged_at) : null;
    console.log(
      JSON.stringify({
        kind: 'revert',
        evidence: r.html_url,
        target,
        gapDays: gap,
        withinWindow: gap !== null && gap >= 0 && gap <= REVERT_WINDOW_DAYS,
        ...p,
        title: r.title,
      }),
    );
  }

  const fixes = await searchMergedPrs(octokit, `repo:${fullRepo} is:pr is:merged merged:>=${since} label:bug,regression,hotfix`);
  for (const f of fixes) {
    if (!f.labels.some((l) => FIX_LABELS.test(typeof l === 'string' ? l : (l.name ?? '')))) continue;
    const refs = [...(f.body ?? '').matchAll(/(?:^|[\s(])#(\d+)\b/g)].map((m) => Number(m[1]));
    for (const n of new Set(refs)) {
      try {
        const { facts: p } = await prFacts(octokit, owner, name, n);
        if (!p.mergedAt || !f.pull_request?.merged_at) continue;
        const gap = gapDays(p.mergedAt, f.pull_request.merged_at);
        if (gap < 0 || gap > REVERT_WINDOW_DAYS) continue;
        console.log(JSON.stringify({ kind: 'fix', evidence: f.html_url, target: n, gapDays: gap, ...p, title: f.title }));
      } catch {
        // #n is an issue, not a PR
      }
    }
  }
}

async function collectHealthy(octokit: Octokit, fullRepo: string, since: string, limit: number, untilArg?: string): Promise<void> {
  const { owner, name } = ownerAndName(fullRepo);
  const latest = new Date(Date.now() - HEALTHY_WINDOW_DAYS * DAY_MS).toISOString().slice(0, 10);
  const until = untilArg && untilArg < latest ? untilArg : latest;
  const items = await searchMergedPrs(octokit, `repo:${fullRepo} is:pr is:merged merged:${since}..${until} -label:dependencies`, 100);
  let found = 0;
  for (const item of items) {
    if (found >= limit) break;
    const { facts: p, files } = await prFacts(octokit, owner, name, item.number);
    if (p.bot || p.docsOnly || !p.mergedAt || NOT_CODE_TITLE.test(item.title)) continue;
    const reviewable = filterFiles(
      files.map((f) => ({ filename: f.filename, status: f.status as ChangedFile['status'], additions: f.additions, deletions: f.deletions, patch: f.patch })),
      DEFAULT_CONFIG,
    );
    // Needs at least one reviewable source file: not docs, tests, CI or lockfiles.
    if (reviewable.every((f) => DOCS_ONLY.test(f.filename) || NOT_SOURCE.test(f.filename))) continue;
    const end = new Date(Date.parse(p.mergedAt) + HEALTHY_WINDOW_DAYS * DAY_MS).toISOString();
    // Conservative: any fix-type commit on a changed file within 90 days excludes the PR.
    let followUp = false;
    for (const file of files.filter((x) => x.status !== 'removed').slice(0, 15)) {
      const commits = await octokit.repos.listCommits({ owner, repo: name, path: file.filename, since: p.mergedAt, until: end, per_page: 100 });
      followUp = commits.data.some((c) => FIX_MESSAGE.test(c.commit.message.split('\n')[0]));
      if (followUp) break;
    }
    if (followUp) continue;
    found += 1;
    console.log(JSON.stringify({ kind: 'healthy', ...p, title: item.title, url: item.html_url }));
  }
}

async function draft(octokit: Octokit, fullRepo: string, n: number, evidence: { kind: 'revert' | 'fix'; url: string } | null): Promise<void> {
  const { owner, name } = ownerAndName(fullRepo);
  const licence = await licenceOf(octokit, owner, name);
  if (!(PERMISSIVE_LICENCES as readonly string[]).includes(licence)) {
    throw new Error(`${fullRepo} is licensed ${licence}, not an accepted permissive licence`);
  }
  const { data: pr } = await octokit.pulls.get({ owner, repo: name, pull_number: n });
  if (!pr.merged_at || !pr.merge_commit_sha) throw new Error(`${fullRepo}#${n} is not merged`);
  const ctx = toContext(
    await fetchHistoryCase(octokit, {
      id: 'draft',
      repo: fullRepo,
      pr: n,
      baseSha: pr.base.sha,
      headSha: pr.head.sha,
      mergeSha: pr.merge_commit_sha,
    }),
  );
  const size = measure(ctx);
  const edited = await octokit.graphql<{ repository: { pullRequest: { lastEditedAt: string | null } } }>(
    'query($o:String!,$r:String!,$n:Int!){repository(owner:$o,name:$r){pullRequest(number:$n){lastEditedAt}}}',
    { o: owner, r: name, n },
  );
  const lastEditedAt = edited.repository.pullRequest.lastEditedAt;
  const tags: string[] = [];
  if (ctx.body.length === 0) tags.push(EMPTY_BODY_TAG);
  if (lastEditedAt && lastEditedAt > pr.merged_at) tags.push('body-edited-after-merge');
  if (size.estimatedTokens > TARGET_CASE_TOKENS) tags.push('over-target-size');
  if (size.estimatedTokens >= DEFAULT_CONFIG.pipeline.fastPathThreshold) tags.push('off-fast-path');

  let evidenceEntry: Record<string, unknown> | undefined;
  if (evidence) {
    const m = /\/pull\/(\d+)$/.exec(evidence.url);
    let mergedAt: string | null = null;
    if (m) {
      const { data: e } = await octokit.pulls.get({ owner, repo: name, pull_number: Number(m[1]) });
      mergedAt = e.merged_at;
    }
    evidenceEntry = { kind: evidence.kind, url: evidence.url, ...(m ? { pr: Number(m[1]) } : {}), mergedAt };
  }

  const entry = {
    id: `${name.toLowerCase().replace(/[^a-z0-9]+/g, '-')}-${n}`,
    kind: evidence ? 'bad' : 'healthy',
    repo: fullRepo,
    licence,
    pr: n,
    mergedAt: pr.merged_at,
    baseSha: pr.base.sha,
    headSha: pr.head.sha,
    mergeSha: pr.merge_commit_sha,
    language: 'TODO',
    size,
    description: { titleChars: ctx.title.length, bodyChars: ctx.body.length },
    tags,
    ...(evidenceEntry
      ? {
          evidence: evidenceEntry,
          cause: {
            issueId: 'cause',
            acceptedPaths: ['TODO'],
            acceptedLineRanges: [{ startLine: 1, endLine: 1 }],
            acceptedCategories: [...ISSUE_CATEGORIES],
            minSeverity: 'nitpick',
            maxSeverity: 'critical',
            rationale: 'TODO: one sentence',
            evidence: `${evidence!.url} TODO`,
          },
        }
      : {}),
  };
  console.log(JSON.stringify(entry, null, 2));
}

async function main(argv: string[]): Promise<void> {
  const [command, repo, third] = argv;
  if (!command || !repo) throw new Error('usage: collect.ts bad|healthy|draft <owner/repo> …');
  const octokit = createOctokit();
  const since = arg(argv, '--since') ?? defaultSince();
  if (command === 'bad') return collectBad(octokit, repo, since);
  if (command === 'healthy') {
    return collectHealthy(octokit, repo, since, Number(arg(argv, '--limit') ?? 10), arg(argv, '--until'));
  }
  if (command === 'draft') {
    const revert = arg(argv, '--revert');
    const fix = arg(argv, '--fix');
    const evidence = revert ? { kind: 'revert' as const, url: revert } : fix ? { kind: 'fix' as const, url: fix } : null;
    return draft(octokit, repo, Number(third), evidence);
  }
  throw new Error(`unknown command "${command}"`);
}

main(process.argv.slice(2)).catch((err: unknown) => {
  console.error(`collect failed: ${err instanceof Error ? err.message : String(err)}`);
  process.exitCode = 1;
});
export {};

import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { checkArtifactSafety, fixtureManifestOf } from '../benchmark.js';
import { ISSUE_CATEGORIES } from '../quality.js';
import { commentableLines } from '../../src/review/diff-analyzer.js';
import {
  CACHE_FORMAT,
  cachePath,
  findPostMergeLeak,
  loadHistoryCases,
  toBenchmarkCase,
  toContext,
  type CachedContext,
} from '../history/loader.js';
import {
  HISTORY_MANIFEST_PATH,
  MAX_BAD_PER_REPO,
  PERMISSIVE_LICENCES,
  readManifest,
  validateManifest,
  type BadHistoryCase,
  type HistoryCase,
  type HistoryManifest,
} from '../history/manifest.js';

const RAW = JSON.parse(readFileSync(HISTORY_MANIFEST_PATH, 'utf8')) as HistoryManifest;

function clone<T>(v: T): T {
  return JSON.parse(JSON.stringify(v)) as T;
}

const firstBad = (): BadHistoryCase => {
  const c = RAW.cases.find((x) => x.kind === 'bad');
  if (!c || c.kind !== 'bad') throw new Error('manifest has no bad case');
  return clone(c);
};
const firstHealthy = (): HistoryCase => clone(RAW.cases.find((x) => x.kind === 'healthy')!);

function withCases(cases: HistoryCase[]): unknown {
  return { ...clone(RAW), cases };
}

// ---------------------------------------------------------------------------

describe('committed history manifest', () => {
  const manifest = readManifest();
  const bad = manifest.cases.filter((c) => c.kind === 'bad');
  const healthy = manifest.cases.filter((c) => c.kind === 'healthy');

  it('validates and holds at least 10 bad and 10 healthy cases', () => {
    expect(bad.length).toBeGreaterThanOrEqual(10);
    expect(healthy.length).toBeGreaterThanOrEqual(10);
  });

  it('has unique ids', () => {
    const ids = manifest.cases.map((c) => c.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('gives every bad case a cause label that accepts every category and severity', () => {
    for (const c of bad) {
      if (c.kind !== 'bad') continue;
      expect(c.cause.acceptedPaths.length).toBeGreaterThan(0);
      expect(c.cause.acceptedLineRanges.length).toBeGreaterThan(0);
      expect([...c.cause.acceptedCategories].sort()).toEqual([...ISSUE_CATEGORIES].sort());
      expect(c.cause.minSeverity).toBe('nitpick');
      expect(c.cause.maxSeverity).toBe('critical');
      expect(c.cause.evidence).toContain(c.evidence.url);
    }
  });

  it('records a permissive licence for every case', () => {
    for (const c of manifest.cases) expect(PERMISSIVE_LICENCES).toContain(c.licence);
  });

  it('keeps at most 6 bad cases per repo and 10 repos in all', () => {
    const perRepo = new Map<string, number>();
    for (const c of bad) perRepo.set(c.repo, (perRepo.get(c.repo) ?? 0) + 1);
    for (const n of perRepo.values()) expect(n).toBeLessThanOrEqual(MAX_BAD_PER_REPO);
    expect(new Set(manifest.cases.map((c) => c.repo)).size).toBeLessThanOrEqual(10);
  });

  it('commits no code, PR text or author identities', () => {
    const text = readFileSync(HISTORY_MANIFEST_PATH, 'utf8');
    const keys = new Set<string>();
    const walk = (node: unknown): void => {
      if (Array.isArray(node)) node.forEach(walk);
      else if (node && typeof node === 'object') {
        for (const [k, v] of Object.entries(node)) {
          keys.add(k.toLowerCase());
          walk(v);
        }
      }
    };
    walk(JSON.parse(text));
    for (const forbidden of ['author', 'login', 'user', 'email', 'avatar', 'title', 'body', 'patch', 'diff', 'content', 'filecontents']) {
      expect(keys.has(forbidden), `key "${forbidden}"`).toBe(false);
    }
    expect(text).not.toMatch(/@[a-z0-9-]+\.[a-z]{2,}/i); // no email addresses
    expect(text).not.toMatch(/avatars\.githubusercontent/);
  });

  it('produces fixture manifests that pass the artifact safety check', () => {
    for (const c of manifest.cases) {
      const fixture = fixtureManifestOf(toBenchmarkCase(c, emptyContext(c)));
      expect(checkArtifactSafety(fixture).violations).toEqual([]);
    }
  });
});

describe('validateManifest', () => {
  it('rejects duplicate ids', () => {
    const a = firstHealthy();
    const b = { ...firstBad(), id: a.id };
    expect(() => validateManifest(withCases([a, b]))).toThrow(/duplicate id/);
  });

  it('rejects a bad case without a cause label', () => {
    const c = firstBad() as Record<string, unknown>;
    delete c.cause;
    expect(() => validateManifest(withCases([c as HistoryCase]))).toThrow();
  });

  it('rejects a healthy case with a cause label or evidence', () => {
    const c = { ...firstHealthy(), cause: firstBad().cause };
    expect(() => validateManifest(withCases([c as HistoryCase]))).toThrow();
  });

  it('rejects a missing or non-permissive licence', () => {
    const missing = firstHealthy() as Record<string, unknown>;
    delete missing.licence;
    expect(() => validateManifest(withCases([missing as HistoryCase]))).toThrow();
    const gpl = { ...firstHealthy(), licence: 'GPL-3.0' };
    expect(() => validateManifest(withCases([gpl as unknown as HistoryCase]))).toThrow();
  });

  it('rejects an empty-body tag that does not match bodyChars', () => {
    const c = firstHealthy();
    c.description.bodyChars = 0;
    c.tags = c.tags.filter((t) => t !== 'empty-body');
    expect(() => validateManifest(withCases([c]))).toThrow(/empty-body/);
  });

  it('rejects evidence merged before the PR', () => {
    const c = firstBad();
    c.evidence.mergedAt = '2000-01-01T00:00:00Z';
    expect(() => validateManifest(withCases([c]))).toThrow(/merged after/);
  });

  it('rejects more than 6 bad cases from one repo', () => {
    const cases = Array.from({ length: MAX_BAD_PER_REPO + 1 }, (_, i) => ({ ...firstBad(), id: `x-${i}`, pr: 1000 + i }));
    expect(() => validateManifest(withCases(cases))).toThrow(/max 6/);
  });

  it('rejects short SHAs and unknown fields', () => {
    expect(() => validateManifest(withCases([{ ...firstHealthy(), headSha: 'abc123' }]))).toThrow();
    expect(() => validateManifest(withCases([{ ...firstHealthy(), author: 'someone' } as HistoryCase]))).toThrow();
  });
});

// ---------------------------------------------------------------------------
// Leak check and loader (synthetic cache; never the network)

function emptyContext(c: HistoryCase) {
  const [owner, repo] = c.repo.split('/');
  return {
    owner,
    repo,
    pullNumber: c.pr,
    baseSha: c.baseSha,
    headSha: c.headSha,
    title: 'feat: a change',
    body: '',
    diff: '',
    changedFiles: [],
    fileContents: new Map<string, string>(),
  };
}

function cachedFor(c: HistoryCase, body = 'Adds a thing.'): CachedContext {
  // One added file per cause path, long enough for every cause range, so the
  // loader's cause check passes; healthy cases get a one-line file.
  const paths = c.kind === 'bad' ? c.cause.acceptedPaths : ['a.ts'];
  const lines = c.kind === 'bad' ? Math.max(...c.cause.acceptedLineRanges.map((r) => r.endLine)) : 1;
  const content = `${Array.from({ length: lines }, (_, i) => `line ${i + 1}`).join('\n')}\n`;
  const patch = `@@ -0,0 +1,${lines} @@\n${content.trimEnd().split('\n').map((l) => `+${l}`).join('\n')}`;
  return {
    cacheFormat: CACHE_FORMAT,
    id: c.id,
    baseSha: c.baseSha,
    headSha: c.headSha,
    context: {
      owner: c.repo.split('/')[0],
      repo: c.repo.split('/')[1],
      pullNumber: c.pr,
      baseSha: c.baseSha,
      headSha: c.headSha,
      title: 'feat: a change',
      body,
      diff: patch,
      changedFiles: paths.map((filename) => ({ filename, status: 'added' as const, additions: lines, deletions: 0, patch })),
      fileContents: Object.fromEntries(paths.map((p) => [p, content])),
    },
  };
}

describe('findPostMergeLeak', () => {
  const bad = firstBad();
  const n = bad.evidence.pr!;

  it('flags the evidence URL, #number, owner/repo#number and pull link', () => {
    expect(findPostMergeLeak(bad, { title: 't', body: `see ${bad.evidence.url}` })).toMatch(/mentions/);
    expect(findPostMergeLeak(bad, { title: 't', body: `superseded by #${n}.` })).toMatch(/references/);
    expect(findPostMergeLeak(bad, { title: 't', body: `${bad.repo}#${n}` })).toMatch(/references/);
    expect(findPostMergeLeak(bad, { title: 't', body: `https://github.com/${bad.repo}/pull/${n}/files` })).toMatch(/pull/);
  });

  it('ignores other numbers and healthy cases', () => {
    expect(findPostMergeLeak(bad, { title: 't', body: `#${n}0 and #${n - 1} and issue ${n}` })).toBeNull();
    expect(findPostMergeLeak(firstHealthy(), { title: 't', body: 'anything #1' })).toBeNull();
  });
});

describe('loadHistoryCases', () => {
  let dir: string;
  const bad = firstBad();
  const healthy = firstHealthy();
  const manifest = { ...clone(RAW), cases: [bad, healthy] } as HistoryManifest;

  beforeEach(() => {
    dir = mkdtempSync(path.join(tmpdir(), 'fiscalcr-history-'));
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  const write = (cached: CachedContext) => writeFileSync(cachePath(cached.id, dir), JSON.stringify(cached));

  it('builds benchmark cases from the cache with the cause as the only gold issue', () => {
    write(cachedFor(bad));
    write(cachedFor(healthy));
    const cases = loadHistoryCases(undefined, { manifest, cacheDir: dir });
    expect(cases.map((c) => c.id)).toEqual([bad.id, healthy.id]);
    expect(cases[0].expectedIssues).toEqual([bad.cause]);
    expect(cases[1].expectedIssues).toEqual([]);
    expect(cases[0].tags).toEqual(expect.arrayContaining(['history', 'bad', bad.language]));
    expect(cases[0].context.fileContents.has(bad.cause.acceptedPaths[0])).toBe(true);
    expect(cases[0].context.headSha).toBe(bad.headSha);
  });

  it('names the fetch command when a case is missing', () => {
    write(cachedFor(bad));
    expect(() => loadHistoryCases(undefined, { manifest, cacheDir: dir })).toThrow(/make eval-history-fetch/);
  });

  it('treats an entry with different pinned SHAs as missing', () => {
    write({ ...cachedFor(bad), headSha: 'f'.repeat(40) });
    expect(() => loadHistoryCases([bad.id], { manifest, cacheDir: dir })).toThrow(/not in/);
  });

  it('refuses a context whose body names the revert or fix', () => {
    write(cachedFor(bad, `Follow-up in ${bad.evidence.url}`));
    expect(() => loadHistoryCases([bad.id], { manifest, cacheDir: dir })).toThrow(/leaks post-merge data/);
  });

  it('refuses a cause label whose lines are not in the diff', () => {
    const cached = cachedFor(bad);
    const file = cached.context.changedFiles[0];
    file.patch = '@@ -1,1 +1,1 @@\n-old\n+line 1';
    write(cached);
    expect(() => loadHistoryCases([bad.id], { manifest, cacheDir: dir })).toThrow(/cannot hit/);
  });

  it('rejects unknown ids', () => {
    expect(() => loadHistoryCases(['nope'], { manifest, cacheDir: dir })).toThrow(/Unknown history case/);
  });

  it('round-trips file contents through the cache shape', () => {
    const ctx = toContext(cachedFor(healthy));
    expect(ctx.fileContents).toBeInstanceOf(Map);
    expect([...ctx.fileContents.keys()]).toEqual(['a.ts']);
  });
});


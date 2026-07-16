import { describe, expect, it, vi } from 'vitest';
import { decideScope } from '../../src/review/delta.js';
import { EMPTY_COUNTS, type ReviewState } from '../../src/github/review-state.js';
import { DEFAULT_CONFIG } from '../../src/config/defaults.js';
import type { ReviewConfig } from '../../src/config/schema.js';

const PATCH = '@@ -1 +1 @@\n+x';

function state(overrides: Partial<ReviewState> = {}): ReviewState {
  return {
    v: 1,
    lastReviewedSha: 'old-sha',
    baseSha: 'base-sha',
    blockingReviewId: null,
    postedFingerprints: [],
    openCounts: { ...EMPTY_COUNTS },
    runs: [],
    ...overrides,
  };
}

function compareOctokit(
  response: { status?: string; files?: Array<Record<string, unknown>> } | Error,
) {
  return {
    repos: {
      compareCommitsWithBasehead: vi.fn(async () => {
        if (response instanceof Error) throw response;
        return { data: { status: response.status ?? 'ahead', files: response.files ?? [] } };
      }),
    },
  } as never;
}

function cmpFile(filename: string, status = 'modified'): Record<string, unknown> {
  return { filename, status, additions: 1, deletions: 0, patch: PATCH };
}

const base = {
  owner: 'o',
  repo: 'r',
  headSha: 'new-sha',
  baseSha: 'base-sha',
  config: DEFAULT_CONFIG,
};

describe('decideScope', () => {
  it('full when incremental reviews are disabled', async () => {
    const config: ReviewConfig = {
      ...DEFAULT_CONFIG,
      review: {
        ...DEFAULT_CONFIG.review,
        incremental: { ...DEFAULT_CONFIG.review.incremental, enabled: false },
      },
    };
    const scope = await decideScope(compareOctokit({}), { ...base, config, state: state() });
    expect(scope.mode).toBe('full');
  });

  it('full when forced, even with valid state', async () => {
    const scope = await decideScope(compareOctokit({}), { ...base, state: state(), forceFull: true });
    expect(scope).toMatchObject({ mode: 'full', reason: 'full review forced' });
  });

  it('full when there is no previous state', async () => {
    const scope = await decideScope(compareOctokit({}), { ...base, state: null });
    expect(scope.mode).toBe('full');
  });

  it('skip when the head was already reviewed', async () => {
    const scope = await decideScope(compareOctokit({}), {
      ...base,
      state: state({ lastReviewedSha: 'new-sha' }),
    });
    expect(scope.mode).toBe('skip');
  });

  it('full when the PR base changed', async () => {
    const scope = await decideScope(compareOctokit({}), {
      ...base,
      state: state({ baseSha: 'other-base' }),
    });
    expect(scope).toMatchObject({ mode: 'full', reason: expect.stringContaining('base changed') });
  });

  it('full when the compare call fails (force-push)', async () => {
    const scope = await decideScope(compareOctokit(new Error('404')), { ...base, state: state() });
    expect(scope).toMatchObject({ mode: 'full', reason: expect.stringContaining('unreachable') });
  });

  it('full when history diverged or went behind', async () => {
    for (const status of ['diverged', 'behind']) {
      const scope = await decideScope(compareOctokit({ status }), { ...base, state: state() });
      expect(scope.mode).toBe('full');
    }
  });

  it('skip when the compare is identical', async () => {
    const scope = await decideScope(compareOctokit({ status: 'identical' }), {
      ...base,
      state: state(),
    });
    expect(scope.mode).toBe('skip');
  });

  it('full when the delta exceeds maxDeltaFiles or the compare cap', async () => {
    const many = Array.from({ length: 151 }, (_, i) => cmpFile(`src/f${i}.ts`));
    const scope = await decideScope(compareOctokit({ files: many }), { ...base, state: state() });
    expect(scope).toMatchObject({ mode: 'full', reason: expect.stringContaining('151') });

    const capped = Array.from({ length: 300 }, (_, i) => cmpFile(`src/f${i}.ts`));
    const scope2 = await decideScope(compareOctokit({ files: capped }), { ...base, state: state() });
    expect(scope2).toMatchObject({ mode: 'full', reason: expect.stringContaining('cap') });
  });

  it('skip when no reviewable files changed (excluded/removed/binary only)', async () => {
    const scope = await decideScope(
      compareOctokit({
        files: [
          cmpFile('pnpm-lock.yaml'),
          cmpFile('src/gone.ts', 'removed'),
          { filename: 'img.png', status: 'modified', additions: 0, deletions: 0 }, // no patch
        ],
      }),
      { ...base, state: state() },
    );
    expect(scope.mode).toBe('skip');
  });

  it('delta with the reviewable changed paths otherwise', async () => {
    const scope = await decideScope(
      compareOctokit({ files: [cmpFile('src/a.ts'), cmpFile('pnpm-lock.yaml')] }),
      { ...base, state: state() },
    );
    expect(scope).toMatchObject({ mode: 'delta', paths: ['src/a.ts'], sinceSha: 'old-sha' });
  });
});

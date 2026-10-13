import { describe, expect, it, vi } from 'vitest';
import { extractPullRequestContext } from '../../src/github/pulls.js';
import { DEFAULT_CONFIG } from '../../src/config/defaults.js';
import type { FileContentSource } from '../../src/review/file-source.js';

function octokitWithFiles(files: Array<Record<string, unknown>>) {
  return {
    pulls: {
      get: vi.fn(async (params: { mediaType?: unknown }) =>
        params.mediaType
          ? { data: 'the-diff' }
          : { data: { title: 't', body: null, base: { sha: 'b' }, head: { sha: 'h' } } },
      ),
      listFiles: vi.fn(async () => ({ data: files })),
    },
  };
}

function recordingSource(): FileContentSource & { requested: string[] } {
  const requested: string[] = [];
  return {
    requested,
    isLocal: false,
    getContents: async (paths) => {
      requested.push(...paths);
      return new Map(paths.map((p) => [p, 'content']));
    },
  };
}

describe('extractPullRequestContext', () => {
  it('loads contents only for files whose diff can carry findings', async () => {
    const octokit = octokitWithFiles([
      { filename: 'src/edited.ts', status: 'modified', additions: 1, deletions: 0, patch: '@@ -1 +1 @@\n-a\n+b' },
      { filename: 'src/renamed.ts', status: 'renamed', additions: 0, deletions: 0 }, // pure rename: no patch
      { filename: 'src/huge.ts', status: 'modified', additions: 9000, deletions: 0 }, // diff omitted by GitHub
      { filename: 'src/gone.ts', status: 'removed', additions: 0, deletions: 3, patch: '@@ -1,3 +0,0 @@' },
    ]);
    const source = recordingSource();

    const ctx = await extractPullRequestContext(octokit as never, 'o', 'r', 1, DEFAULT_CONFIG, {
      fileSource: source,
    });

    expect(source.requested).toEqual(['src/edited.ts']);
    expect([...ctx.fileContents.keys()]).toEqual(['src/edited.ts']);
    // Patchless files stay in the changed-file list.
    expect(ctx.changedFiles.map((f) => f.filename)).toEqual([
      'src/edited.ts',
      'src/renamed.ts',
      'src/huge.ts',
      'src/gone.ts',
    ]);
  });
});

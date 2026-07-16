import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ApiFileSource, LocalFileSource } from '../../src/review/file-source.js';

describe('LocalFileSource', () => {
  let root: string;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'fiscalcr-test-'));
    await mkdir(join(root, 'src'), { recursive: true });
    await writeFile(join(root, 'src/a.ts'), 'export const a = 1;\n');
    await writeFile(join(root, 'src/big.ts'), 'x'.repeat(500));
    await writeFile(join(root, 'src/bin.dat'), Buffer.from([0x41, 0x00, 0x42]));
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it('reads files from the workspace', async () => {
    const source = new LocalFileSource(root);
    const contents = await source.getContents(['src/a.ts'], 100_000);
    expect(contents.get('src/a.ts')).toBe('export const a = 1;\n');
    expect(source.isLocal).toBe(true);
  });

  it('omits oversized and binary files', async () => {
    const source = new LocalFileSource(root);
    const contents = await source.getContents(['src/big.ts', 'src/bin.dat'], 100);
    expect(contents.size).toBe(0);
  });

  it('rejects absolute and traversal paths', async () => {
    const source = new LocalFileSource(root);
    const contents = await source.getContents(
      [join(root, 'src/a.ts'), '../outside.ts'],
      100_000,
    );
    expect(contents.size).toBe(0);
  });

  it('falls back to the API source for unreadable paths', async () => {
    const fallback = {
      isLocal: false as const,
      getContents: vi.fn(async () => new Map([['src/missing.ts', 'from api']])),
    };
    const source = new LocalFileSource(root, fallback);
    const contents = await source.getContents(['src/a.ts', 'src/missing.ts'], 100_000);

    expect(contents.get('src/a.ts')).toBe('export const a = 1;\n');
    expect(contents.get('src/missing.ts')).toBe('from api');
    expect(fallback.getContents).toHaveBeenCalledWith(['src/missing.ts'], 100_000);
  });
});

describe('ApiFileSource', () => {
  function octokitReturning(files: Record<string, string>) {
    return {
      repos: {
        getContent: vi.fn(async ({ path }: { path: string }) => {
          const content = files[path];
          if (content === undefined) throw new Error('404');
          return {
            data: { content: Buffer.from(content).toString('base64'), encoding: 'base64' },
          };
        }),
      },
    };
  }

  it('fetches contents in parallel and skips failures', async () => {
    const octokit = octokitReturning({ 'a.ts': 'aaa', 'b.ts': 'bbb' });
    const source = new ApiFileSource(octokit as never, 'o', 'r', 'sha');
    const contents = await source.getContents(['a.ts', 'b.ts', 'missing.ts'], 100_000);

    expect(contents.get('a.ts')).toBe('aaa');
    expect(contents.get('b.ts')).toBe('bbb');
    expect(contents.has('missing.ts')).toBe(false);
    expect(source.isLocal).toBe(false);
  });

  it('enforces the size limit', async () => {
    const octokit = octokitReturning({ 'a.ts': 'x'.repeat(200) });
    const source = new ApiFileSource(octokit as never, 'o', 'r', 'sha');
    const contents = await source.getContents(['a.ts'], 100);
    expect(contents.size).toBe(0);
  });
});

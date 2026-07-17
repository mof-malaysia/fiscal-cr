import { describe, it, expect } from 'vitest';
import { filterFiles } from '../../src/review/file-filter.js';
import type { ChangedFile } from '../../src/types/review.js';
import { DEFAULT_CONFIG } from '../../src/config/defaults.js';

function makeFile(filename: string, overrides?: Partial<ChangedFile>): ChangedFile {
  return {
    filename,
    status: 'modified',
    additions: 10,
    deletions: 5,
    patch: '@@ -1,3 +1,3 @@\n context\n-old\n+new',
    ...overrides,
  };
}

describe('filterFiles', () => {
  it('should exclude node_modules', () => {
    const files = [
      makeFile('src/index.ts'),
      makeFile('node_modules/foo/index.js'),
    ];
    const filtered = filterFiles(files, DEFAULT_CONFIG);
    expect(filtered).toHaveLength(1);
    expect(filtered[0].filename).toBe('src/index.ts');
  });

  it('should exclude lock files across ecosystems', () => {
    const files = [
      makeFile('src/app.ts'),
      makeFile('package-lock.json'),
      makeFile('npm-shrinkwrap.json'),
      makeFile('yarn.lock'),
      makeFile('pnpm-lock.yaml'),
      makeFile('bun.lockb'),
      makeFile('Cargo.lock'),
      makeFile('composer.lock'),
      makeFile('Gemfile.lock'),
      makeFile('poetry.lock'),
      makeFile('go.sum'),
      makeFile('nested/dir/go.sum'),
      makeFile('packages.lock.json'),
    ];
    const filtered = filterFiles(files, DEFAULT_CONFIG);
    expect(filtered.map((f) => f.filename)).toEqual(['src/app.ts']);
  });

  it('should exclude removed files', () => {
    const files = [
      makeFile('src/old.ts', { status: 'removed' }),
      makeFile('src/new.ts', { status: 'added' }),
    ];
    const filtered = filterFiles(files, DEFAULT_CONFIG);
    expect(filtered).toHaveLength(1);
    expect(filtered[0].filename).toBe('src/new.ts');
  });

  it('should exclude files without patches (binary)', () => {
    const files = [
      makeFile('src/index.ts'),
      makeFile('assets/image.png', { patch: undefined }),
    ];
    const filtered = filterFiles(files, DEFAULT_CONFIG);
    expect(filtered).toHaveLength(1);
  });
});

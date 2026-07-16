import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { collectRelatedContext, extractImportSpecs } from '../../src/pipeline/related-context.js';
import type { FileGroup } from '../../src/pipeline/grouper.js';
import type { ChangedFile } from '../../src/types/review.js';
import { DEFAULT_CONFIG } from '../../src/config/defaults.js';
import type { ReviewConfig } from '../../src/config/schema.js';

const WORKSPACE = join(dirname(fileURLToPath(import.meta.url)), '..', 'fixtures', 'fake-repo');

function file(filename: string): ChangedFile {
  return { filename, status: 'modified', additions: 10, deletions: 2, patch: '@@ -1 +1 @@\n+x' };
}

function group(filenames: string[], diffOnly = false): FileGroup {
  return { label: 'g', files: filenames.map(file), diffOnly };
}

function cfg(overrides: Partial<ReviewConfig['pipeline']> = {}): ReviewConfig {
  return { ...DEFAULT_CONFIG, pipeline: { ...DEFAULT_CONFIG.pipeline, ...overrides } };
}

describe('extractImportSpecs', () => {
  it('extracts relative specs from import, require, and dynamic import', () => {
    const source = [
      `import { a } from './a.js';`,
      `import type { B } from '../b';`,
      `export { c } from './c.js';`,
      `const d = require('./d');`,
      `const e = await import('./e.js');`,
    ].join('\n');
    expect(extractImportSpecs(source)).toEqual(['./a.js', '../b', './c.js', './d', './e.js']);
  });

  it('ignores bare and absolute specifiers', () => {
    const source = [
      `import { z } from 'zod';`,
      `import fs from 'node:fs';`,
      `import x from '/abs/path.js';`,
    ].join('\n');
    expect(extractImportSpecs(source)).toEqual([]);
  });
});

describe('collectRelatedContext', () => {
  it('resolves .js imports to .ts files and directory imports to index files', async () => {
    const contents = new Map([
      ['src/app.ts', `import { helper } from './utils/helper.js';\nimport * as u from './utils';`],
    ]);
    const related = await collectRelatedContext(
      group(['src/app.ts']),
      contents,
      WORKSPACE,
      cfg(),
      new Set(['src/app.ts']),
    );
    expect([...related.keys()].sort()).toEqual(['src/utils/helper.ts', 'src/utils/index.ts']);
    expect(related.get('src/utils/helper.ts')).toContain('export function helper');
  });

  it('skips files that are part of the PR', async () => {
    const contents = new Map([['src/app.ts', `import { helper } from './utils/helper.js';`]]);
    const related = await collectRelatedContext(
      group(['src/app.ts']),
      contents,
      WORKSPACE,
      cfg(),
      new Set(['src/app.ts', 'src/utils/helper.ts']),
    );
    expect(related.size).toBe(0);
  });

  it('skips excluded globs and binary files', async () => {
    const contents = new Map([
      ['src/app.ts', `import { GENERATED } from './dist/generated.js';\nimport bin from './binary.dat';`],
    ]);
    const related = await collectRelatedContext(
      group(['src/app.ts']),
      contents,
      WORKSPACE,
      cfg(),
      new Set(['src/app.ts']),
    );
    expect(related.size).toBe(0);
  });

  it('ignores unresolvable and workspace-escaping imports', async () => {
    const contents = new Map([
      ['src/app.ts', `import { m } from './missing.js';\nimport { o } from '../../outside.js';`],
    ]);
    const related = await collectRelatedContext(
      group(['src/app.ts']),
      contents,
      WORKSPACE,
      cfg(),
      new Set(['src/app.ts']),
    );
    expect(related.size).toBe(0);
  });

  it('truncates long related files to 200 lines with a marker', async () => {
    const contents = new Map([['src/app.ts', `import { line1 } from './big.js';`]]);
    const related = await collectRelatedContext(
      group(['src/app.ts']),
      contents,
      WORKSPACE,
      cfg(),
      new Set(['src/app.ts']),
    );
    const big = related.get('src/big.ts');
    expect(big).toBeDefined();
    expect(big).toContain('[truncated related file — context only]');
    expect(big).toContain('line200');
    expect(big).not.toContain('line201');
  });

  it('respects the per-group token budget', async () => {
    const contents = new Map([['src/app.ts', `import { line1 } from './big.js';`]]);
    // big.ts truncated is still ~1.5K tokens; a 10-token budget excludes it
    const related = await collectRelatedContext(
      group(['src/app.ts']),
      contents,
      WORKSPACE,
      cfg({ relatedContextBudget: 10 }),
      new Set(['src/app.ts']),
    );
    expect(related.size).toBe(0);
  });

  it('ranks shared imports above single-referenced ones', async () => {
    const contents = new Map([
      ['src/app.ts', `import { helper } from './utils/helper.js';\nimport { line1 } from './big.js';`],
      ['src/other.ts', `import { helper } from './utils/helper.js';`],
    ]);
    const related = await collectRelatedContext(
      group(['src/app.ts', 'src/other.ts']),
      contents,
      WORKSPACE,
      // Budget fits helper.ts but not big.ts — only the top-ranked file lands
      cfg({ relatedContextBudget: 100 }),
      new Set(['src/app.ts', 'src/other.ts']),
    );
    expect([...related.keys()]).toEqual(['src/utils/helper.ts']);
  });

  it('returns nothing for diff-only groups or a zero budget', async () => {
    const contents = new Map([['src/app.ts', `import { helper } from './utils/helper.js';`]]);
    const diffOnly = await collectRelatedContext(
      group(['src/app.ts'], true),
      contents,
      WORKSPACE,
      cfg(),
      new Set(['src/app.ts']),
    );
    expect(diffOnly.size).toBe(0);

    const zeroBudget = await collectRelatedContext(
      group(['src/app.ts']),
      contents,
      WORKSPACE,
      cfg({ relatedContextBudget: 0 }),
      new Set(['src/app.ts']),
    );
    expect(zeroBudget.size).toBe(0);
  });
});

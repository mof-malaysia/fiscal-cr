import { describe, expect, it } from 'vitest';
import { groupFiles } from '../../src/pipeline/grouper.js';
import type { ChangedFile } from '../../src/types/review.js';
import type { IntentResult } from '../../src/pipeline/schemas.js';
import { DEFAULT_CONFIG } from '../../src/config/defaults.js';
import type { ReviewConfig } from '../../src/config/schema.js';

function file(filename: string, size = 100): ChangedFile {
  return { filename, status: 'modified', additions: 10, deletions: 2, patch: '@@ -1 +1 @@\n+x' };
}

function contents(files: ChangedFile[], charsEach = 400): Map<string, string> {
  return new Map(files.map((f) => [f.filename, 'x'.repeat(charsEach)]));
}

function cfg(overrides: Partial<ReviewConfig['pipeline']> = {}): ReviewConfig {
  return { ...DEFAULT_CONFIG, pipeline: { ...DEFAULT_CONFIG.pipeline, ...overrides } };
}

const NO_HINTS: IntentResult | null = null;

describe('groupFiles', () => {
  it('groups small same-directory files together', () => {
    const files = [file('src/a/x.ts'), file('src/a/y.ts'), file('src/b/z.ts')];
    const groups = groupFiles(files, contents(files), NO_HINTS, cfg());
    // All tiny → merged into one group
    expect(groups).toHaveLength(1);
    expect(groups[0].files.map((f) => f.filename).sort()).toEqual([
      'src/a/x.ts', 'src/a/y.ts', 'src/b/z.ts',
    ]);
  });

  it('seeds clusters from intent hints and ignores unknown paths', () => {
    const files = [file('src/auth/login.ts'), file('src/auth/token.ts'), file('docs/readme.md')];
    const hints: IntentResult = {
      intent: 'x',
      walkthrough: [],
      groups: [
        { label: 'auth', files: ['src/auth/login.ts', 'src/auth/token.ts', 'src/ghost.ts'] },
      ],
      riskHotspots: [],
    };
    // Force groups apart with a large budget-exceeding content per cluster
    const big = new Map([
      ['src/auth/login.ts', 'x'.repeat(80_000)],
      ['src/auth/token.ts', 'x'.repeat(80_000)],
      ['docs/readme.md', 'x'.repeat(80_000)],
    ]);
    const groups = groupFiles(files, big, hints, cfg({ groupTokenBudget: 30_000 }));
    const allFiles = groups.flatMap((g) => g.files.map((f) => f.filename));
    expect(allFiles.sort()).toEqual(['docs/readme.md', 'src/auth/login.ts', 'src/auth/token.ts']);
    expect(allFiles).not.toContain('src/ghost.ts');
  });

  it('splits oversized clusters across groups (FFD)', () => {
    const files = [file('src/m/a.ts'), file('src/m/b.ts'), file('src/m/c.ts')];
    // each ~20K tokens (80K chars), budget 30K → no two fit together
    const groups = groupFiles(files, contents(files, 80_000), NO_HINTS, cfg({ groupTokenBudget: 30_000 }));
    expect(groups).toHaveLength(3);
  });

  it('moves test files into their subject cluster', () => {
    const files = [
      file('src/core/parser.ts'),
      file('test/unit/parser.test.ts'),
      file('src/other/misc.ts'),
    ];
    const big = new Map([
      ['src/core/parser.ts', 'x'.repeat(60_000)],
      ['test/unit/parser.test.ts', 'x'.repeat(1_000)],
      ['src/other/misc.ts', 'x'.repeat(60_000)],
    ]);
    const groups = groupFiles(files, big, NO_HINTS, cfg({ groupTokenBudget: 20_000 }));
    const parserGroup = groups.find((g) =>
      g.files.some((f) => f.filename === 'src/core/parser.ts'),
    );
    // FFD may split, but the test file must live in a parser-labelled group,
    // not with misc.ts
    const testGroup = groups.find((g) =>
      g.files.some((f) => f.filename === 'test/unit/parser.test.ts'),
    );
    expect(testGroup).toBeDefined();
    expect(
      testGroup!.files.some((f) => f.filename === 'src/other/misc.ts'),
    ).toBe(false);
    expect(parserGroup).toBeDefined();
  });

  it('caps group count with a diff-only overflow group', () => {
    const files = Array.from({ length: 12 }, (_, i) => file(`src/mod${i}/f.ts`));
    const groups = groupFiles(
      files,
      contents(files, 60_000),
      NO_HINTS,
      cfg({ groupTokenBudget: 20_000, maxGroups: 4 }),
    );
    expect(groups.length).toBeLessThanOrEqual(4);
    const overflow = groups.filter((g) => g.diffOnly);
    expect(overflow).toHaveLength(1);
    expect(groups.flatMap((g) => g.files)).toHaveLength(12);
  });

  it('is deterministic across shuffled input', () => {
    const files = [file('src/b.ts'), file('src/a.ts'), file('lib/c.ts')];
    const shuffled = [files[2], files[0], files[1]];
    const a = groupFiles(files, contents(files), NO_HINTS, cfg());
    const b = groupFiles(shuffled, contents(shuffled), NO_HINTS, cfg());
    expect(a.map((g) => g.files.map((f) => f.filename))).toEqual(
      b.map((g) => g.files.map((f) => f.filename)),
    );
  });
});

import { describe, it, expect } from 'vitest';
import { parsePatch, lineToDiffPosition, commentableRanges } from '../../src/review/diff-analyzer.js';

const SAMPLE_PATCH = `@@ -1,5 +1,7 @@
 const a = 1;
-const b = 2;
+const b = 3;
+const c = 4;
 const d = 5;
 const e = 6;
+const f = 7;`;

describe('parsePatch', () => {
  it('should parse hunks correctly', () => {
    const hunks = parsePatch(SAMPLE_PATCH);
    expect(hunks).toHaveLength(1);
    expect(hunks[0].oldStart).toBe(1);
    expect(hunks[0].newStart).toBe(1);
  });

  it('should identify additions and deletions', () => {
    const hunks = parsePatch(SAMPLE_PATCH);
    const additions = hunks[0].lines.filter((l) => l.type === 'addition');
    const deletions = hunks[0].lines.filter((l) => l.type === 'deletion');
    expect(additions).toHaveLength(3); // b=3, c=4, f=7
    expect(deletions).toHaveLength(1); // b=2
  });
});

describe('commentableRanges', () => {
  it('coalesces adjacent reviewable lines', () => {
    expect(commentableRanges('src/a.ts', SAMPLE_PATCH)).toEqual([
      { path: 'src/a.ts', startLine: 1, endLine: 6 },
    ]);
  });

  it('preserves original lines for a deletion-only hunk', () => {
    const patch = '@@ -3,2 +3,1 @@\n context\n-old';
    expect(commentableRanges('src/a.ts', patch)).toEqual([
      { path: 'src/a.ts', startLine: 3, endLine: 3 },
      { path: 'src/a.ts', startLine: 3, endLine: 3, originalStartLine: 4, originalEndLine: 4 },
    ]);
  });
});

describe('lineToDiffPosition', () => {
  it('should find position of added line', () => {
    // Line 3 in new file = "const c = 4;" (addition)
    const result = lineToDiffPosition(SAMPLE_PATCH, 3);
    expect(result.found).toBe(true);
    expect(result.position).toBeGreaterThan(0);
  });

  it('should find position of context line', () => {
    // Line 1 in new file = "const a = 1;" (context)
    const result = lineToDiffPosition(SAMPLE_PATCH, 1);
    expect(result.found).toBe(true);
  });

  it('should return not found for lines outside diff', () => {
    const result = lineToDiffPosition(SAMPLE_PATCH, 100);
    expect(result.found).toBe(false);
  });
});

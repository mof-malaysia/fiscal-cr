/**
 * Parses unified diff format and maps source line numbers to GitHub diff positions.
 *
 * GitHub's PR Review Comment API requires a "position" in the diff, not a source line number.
 * The position is the line number in the diff (starting from 1), counting only lines
 * that are visible in the diff view (hunk headers, context lines, additions, deletions).
 */

interface DiffHunk {
  oldStart: number;
  oldCount: number;
  newStart: number;
  newCount: number;
  lines: DiffLine[];
}

interface DiffLine {
  type: 'context' | 'addition' | 'deletion' | 'hunk-header';
  content: string;
  oldLine?: number;
  newLine?: number;
  position: number; // 1-indexed position in the diff
}

export interface DiffPosition {
  position: number;
  found: boolean;
}

/**
 * Parse a file's patch (unified diff) into structured hunks.
 */
export function parsePatch(patch: string): DiffHunk[] {
  const lines = patch.split('\n');
  const hunks: DiffHunk[] = [];
  let currentHunk: DiffHunk | null = null;
  let position = 0;
  let oldLine = 0;
  let newLine = 0;

  for (const line of lines) {
    // Hunk header: @@ -oldStart,oldCount +newStart,newCount @@
    const hunkMatch = line.match(/^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/);
    if (hunkMatch) {
      position++;
      const hunk: DiffHunk = {
        oldStart: parseInt(hunkMatch[1], 10),
        oldCount: parseInt(hunkMatch[2] ?? '1', 10),
        newStart: parseInt(hunkMatch[3], 10),
        newCount: parseInt(hunkMatch[4] ?? '1', 10),
        lines: [],
      };
      oldLine = hunk.oldStart;
      newLine = hunk.newStart;
      hunk.lines.push({
        type: 'hunk-header',
        content: line,
        position,
      });
      hunks.push(hunk);
      currentHunk = hunk;
      continue;
    }

    if (!currentHunk) continue;

    position++;

    if (line.startsWith('+')) {
      currentHunk.lines.push({
        type: 'addition',
        content: line.slice(1),
        newLine,
        position,
      });
      newLine++;
    } else if (line.startsWith('-')) {
      currentHunk.lines.push({
        type: 'deletion',
        content: line.slice(1),
        oldLine,
        position,
      });
      oldLine++;
    } else if (line.startsWith(' ') || line === '') {
      currentHunk.lines.push({
        type: 'context',
        content: line.slice(1),
        oldLine,
        newLine,
        position,
      });
      oldLine++;
      newLine++;
    }
  }

  return hunks;
}

/**
 * Convert a source file line number (1-indexed) to a GitHub diff position.
 * Returns the position for the RIGHT side (new file) of the diff.
 */
/**
 * All NEW-side line numbers in a patch that can host a PR review comment
 * (additions and context lines — the RIGHT side of the diff view).
 */
export function commentableLines(patch: string): Set<number> {
  const lines = new Set<number>();
  for (const hunk of parsePatch(patch)) {
    for (const line of hunk.lines) {
      if ((line.type === 'addition' || line.type === 'context') && line.newLine !== undefined) {
        lines.add(line.newLine);
      }
    }
  }
  return lines;
}

export function lineToDiffPosition(
  patch: string,
  targetLine: number,
): DiffPosition {
  const hunks = parsePatch(patch);

  for (const hunk of hunks) {
    for (const line of hunk.lines) {
      if (line.type === 'hunk-header') continue;
      if (
        (line.type === 'addition' || line.type === 'context') &&
        line.newLine === targetLine
      ) {
        return { position: line.position, found: true };
      }
    }
  }

  return { position: 0, found: false };
}

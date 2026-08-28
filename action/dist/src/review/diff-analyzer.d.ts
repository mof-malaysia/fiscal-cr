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
    position: number;
}
export interface DiffPosition {
    position: number;
    found: boolean;
}
/**
 * Parse a file's patch (unified diff) into structured hunks.
 */
export declare function parsePatch(patch: string): DiffHunk[];
/**
 * Convert a source file line number (1-indexed) to a GitHub diff position.
 * Returns the position for the RIGHT side (new file) of the diff.
 */
/**
 * All NEW-side line numbers in a patch that can host a PR review comment
 * (additions and context lines — the RIGHT side of the diff view).
 */
export declare function commentableLines(patch: string): Set<number>;
export declare function lineToDiffPosition(patch: string, targetLine: number): DiffPosition;
export {};
//# sourceMappingURL=diff-analyzer.d.ts.map
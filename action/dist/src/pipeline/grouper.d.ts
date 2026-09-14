import type { ChangedFile } from '../types/review.js';
import type { ReviewConfig } from '../config/schema.js';
import type { IntentResult } from './schemas.js';
export interface FileGroup {
    label: string;
    files: ChangedFile[];
    /** True when the group ships diffs only (no full file contents) to fit budget. */
    diffOnly: boolean;
}
/**
 * Deterministically split changed files into review groups:
 * Pass 1 hints seed the clusters, directory structure covers the rest, test
 * files join their subject, and clusters are bin-packed to the token budget.
 */
export declare function groupFiles(files: ChangedFile[], contents: Map<string, string>, hints: IntentResult | null, config: ReviewConfig): FileGroup[];
//# sourceMappingURL=grouper.d.ts.map
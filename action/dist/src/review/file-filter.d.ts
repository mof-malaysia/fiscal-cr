import type { ChangedFile } from '../types/review.js';
import type { ReviewConfig } from '../config/schema.js';
/**
 * Filter changed files based on include/exclude glob patterns from config.
 */
export declare function filterFiles(files: ChangedFile[], config: ReviewConfig): ChangedFile[];
//# sourceMappingURL=file-filter.d.ts.map
import type { ReviewAnnotation } from '../types/review.js';
/**
 * Stable identity for a finding across review runs. Deliberately excludes
 * line numbers and body text — both shift between pushes while the underlying
 * issue stays the same.
 */
export declare function fingerprintAnnotation(a: ReviewAnnotation): string;
/** Hidden marker appended to every inline comment we post. */
export declare function fingerprintMarker(fingerprint: string): string;
/** Extract the fingerprint from a previously posted comment body, if any. */
export declare function extractFingerprint(commentBody: string): string | null;
//# sourceMappingURL=fingerprint.d.ts.map
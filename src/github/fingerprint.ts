import { createHash } from 'node:crypto';
import type { ReviewAnnotation } from '../types/review.js';

const FP_MARKER_RE = /<!-- fiscalcr:fp:v1:([0-9a-f]{16}) -->/;

/**
 * Normalize a finding title so the fingerprint survives cosmetic drift between
 * runs: casing, whitespace, backticks, and shifting numbers (line references,
 * counts) must not produce a "new" finding.
 */
function normalizeTitle(title: string): string {
  return title
    .toLowerCase()
    .replace(/`/g, '')
    .replace(/\d+/g, '#')
    .replace(/[^a-z#À-￿]+/gu, ' ')
    .trim();
}

/**
 * Stable identity for a finding across review runs. Deliberately excludes
 * line numbers and body text — both shift between pushes while the underlying
 * issue stays the same.
 */
export function fingerprintAnnotation(a: ReviewAnnotation): string {
  return createHash('sha256')
    .update(`${a.path}\0${a.category}\0${normalizeTitle(a.title)}`)
    .digest('hex')
    .slice(0, 16);
}

/** Hidden marker appended to every inline comment we post. */
export function fingerprintMarker(fingerprint: string): string {
  return `<!-- fiscalcr:fp:v1:${fingerprint} -->`;
}

/** Extract the fingerprint from a previously posted comment body, if any. */
export function extractFingerprint(commentBody: string): string | null {
  return commentBody.match(FP_MARKER_RE)?.[1] ?? null;
}

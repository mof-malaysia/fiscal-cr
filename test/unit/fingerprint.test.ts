import { describe, expect, it } from 'vitest';
import {
  extractFingerprint,
  fingerprintAnnotation,
  fingerprintMarker,
} from '../../src/github/fingerprint.js';
import type { ReviewAnnotation } from '../../src/types/review.js';

function annotation(overrides: Partial<ReviewAnnotation> = {}): ReviewAnnotation {
  return {
    path: 'src/auth.ts',
    startLine: 10,
    endLine: 12,
    severity: 'critical',
    category: 'security',
    title: 'SQL injection in login handler',
    body: 'User input flows into the query unsanitized.',
    ...overrides,
  };
}

describe('fingerprintAnnotation', () => {
  it('is a 16-char hex string', () => {
    expect(fingerprintAnnotation(annotation())).toMatch(/^[0-9a-f]{16}$/);
  });

  it('is stable when lines and body shift between runs', () => {
    const a = fingerprintAnnotation(annotation({ startLine: 10, endLine: 12, body: 'v1' }));
    const b = fingerprintAnnotation(annotation({ startLine: 45, endLine: 48, body: 'reworded' }));
    expect(a).toBe(b);
  });

  it('is stable across cosmetic title drift (case, backticks, numbers)', () => {
    const a = fingerprintAnnotation(annotation({ title: 'SQL injection in `login` handler on line 10' }));
    const b = fingerprintAnnotation(annotation({ title: 'sql Injection in login handler on line 45' }));
    expect(a).toBe(b);
  });

  it('differs by path, category, and title', () => {
    const base = fingerprintAnnotation(annotation());
    expect(fingerprintAnnotation(annotation({ path: 'src/other.ts' }))).not.toBe(base);
    expect(fingerprintAnnotation(annotation({ category: 'bug' }))).not.toBe(base);
    expect(fingerprintAnnotation(annotation({ title: 'A different problem' }))).not.toBe(base);
  });
});

describe('fingerprint markers', () => {
  it('roundtrips through a comment body', () => {
    const fp = fingerprintAnnotation(annotation());
    const body = `🔴 **[critical]** Bad news\n\ndetails\n\n${fingerprintMarker(fp)}`;
    expect(extractFingerprint(body)).toBe(fp);
  });

  it('returns null when no marker is present', () => {
    expect(extractFingerprint('just a human comment')).toBeNull();
  });
});

import { describe, expect, it } from 'vitest';
import {
  DEFAULT_CONFIDENCE,
  parseFastPathResponse,
  parseGroupResponse,
  parseIntentResponse,
  parseSynthesisResponse,
} from '../../src/pipeline/schemas.js';

describe('parseIntentResponse', () => {
  it('parses a full intent object', () => {
    const result = parseIntentResponse(
      JSON.stringify({
        intent: 'Adds retry logic',
        walkthrough: [{ path: 'src/a.ts', summary: 'adds retries' }],
        groups: [{ label: 'core', files: ['src/a.ts'] }],
        riskHotspots: [{ path: 'src/a.ts', reason: 'touches auth' }],
      }),
    );
    expect(result).not.toBeNull();
    expect(result!.intent).toBe('Adds retry logic');
    expect(result!.groups[0].files).toEqual(['src/a.ts']);
  });

  it('tolerates missing optional sections and markdown fences', () => {
    const result = parseIntentResponse('```json\n{"intent":"x"}\n```');
    expect(result).toEqual({ intent: 'x', walkthrough: [], groups: [], riskHotspots: [] });
  });

  it('returns null for non-JSON', () => {
    expect(parseIntentResponse('I cannot review this.')).toBeNull();
  });
});

describe('parseGroupResponse', () => {
  it('parses findings with confidence and snake_case fields', () => {
    const result = parseGroupResponse(
      JSON.stringify({
        group_summary: 'Refactors auth',
        findings: [
          {
            path: 'src/a.ts',
            start_line: 5,
            end_line: 7,
            severity: 'critical',
            category: 'security',
            title: 'Token leak',
            message: 'The token is logged',
            suggested_fix: 'redact(token)',
            confidence: 0.9,
          },
        ],
      }),
    );
    expect(result).not.toBeNull();
    expect(result!.groupSummary).toBe('Refactors auth');
    expect(result!.findings[0]).toMatchObject({
      path: 'src/a.ts',
      startLine: 5,
      endLine: 7,
      body: 'The token is logged',
      suggestedFix: 'redact(token)',
      confidence: 0.9,
    });
  });

  it('defaults confidence when omitted and accepts "annotations" alias', () => {
    const result = parseGroupResponse(
      JSON.stringify({
        summary: 's',
        annotations: [
          { path: 'a.ts', line: 3, severity: 'warning', category: 'bug', title: 't' },
        ],
      }),
    );
    expect(result!.findings[0].confidence).toBe(DEFAULT_CONFIDENCE);
    expect(result!.findings[0].startLine).toBe(3);
  });

  it('skips malformed findings but keeps valid ones', () => {
    const result = parseGroupResponse(
      JSON.stringify({
        groupSummary: 's',
        findings: [
          { severity: 'nope' },
          { path: 'a.ts', line: 1, severity: 'nitpick', category: 'style', title: 'ok' },
        ],
      }),
    );
    expect(result!.findings).toHaveLength(1);
  });

  it('clamps endLine below startLine', () => {
    const result = parseGroupResponse(
      JSON.stringify({
        findings: [
          { path: 'a.ts', startLine: 10, endLine: 4, severity: 'warning', category: 'bug', title: 't' },
        ],
      }),
    );
    expect(result!.findings[0].endLine).toBe(10);
  });
});

describe('parseSynthesisResponse', () => {
  it('parses pruning decisions in either case style', () => {
    const result = parseSynthesisResponse(
      JSON.stringify({
        summary: 'Good PR',
        score: 85,
        walkthrough: [],
        near_duplicates: [['f1', 'f2']],
        likely_false_positives: ['f3'],
      }),
    );
    expect(result!.nearDuplicates).toEqual([['f1', 'f2']]);
    expect(result!.likelyFalsePositives).toEqual(['f3']);
    expect(result!.score).toBe(85);
  });

  it('treats a missing score as null (deterministic fallback)', () => {
    const result = parseSynthesisResponse(JSON.stringify({ summary: 's' }));
    expect(result!.score).toBeNull();
  });
});

describe('parseFastPathResponse', () => {
  it('parses the combined shape', () => {
    const result = parseFastPathResponse(
      JSON.stringify({
        intent: 'Fixes a bug',
        summary: 'LGTM with notes',
        score: 90,
        walkthrough: [{ path: 'a.ts', summary: 'fix' }],
        findings: [
          { path: 'a.ts', line: 2, severity: 'suggestion', category: 'best-practice', title: 't' },
        ],
      }),
    );
    expect(result!.intent).toBe('Fixes a bug');
    expect(result!.findings).toHaveLength(1);
  });

  it('returns null for unparseable output', () => {
    expect(parseFastPathResponse('nope')).toBeNull();
  });
});

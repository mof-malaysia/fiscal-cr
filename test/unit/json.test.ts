import { describe, it, expect } from 'vitest';
import { extractJson, repairTruncatedJson } from '../../src/utils/json.js';

describe('extractJson', () => {
  it('parses valid JSON directly', () => {
    const raw = JSON.stringify({ summary: 'Looks good', score: 90 });
    expect(extractJson(raw)).toEqual({ summary: 'Looks good', score: 90 });
  });

  it('extracts JSON from a markdown code block', () => {
    const raw = `Here is my review:

\`\`\`json
{ "summary": "Code looks clean", "score": 85 }
\`\`\``;
    expect(extractJson(raw)).toEqual({ summary: 'Code looks clean', score: 85 });
  });

  it('extracts a JSON object embedded in surrounding text', () => {
    const raw = `Let me analyze this PR carefully.

{"summary":"Simple config addition","score":95}

That concludes my review.`;
    expect(extractJson(raw)).toEqual({ summary: 'Simple config addition', score: 95 });
  });

  it('handles braces inside strings without truncating early', () => {
    const raw = '{"summary":"use a { literal } here","score":70}';
    expect(extractJson(raw)).toEqual({ summary: 'use a { literal } here', score: 70 });
  });

  it('returns null for completely unparseable text', () => {
    expect(extractJson('I cannot provide a review for this PR.')).toBeNull();
  });

  it('salvages a response truncated mid-array (via strategy 4)', () => {
    const raw = '{"summary":"ok","findings":[{"path":"a.ts","title":"one"},{"pa';
    expect(extractJson(raw)).toEqual({
      summary: 'ok',
      findings: [{ path: 'a.ts', title: 'one' }],
    });
  });
  it('rejects truncated JSON when repairTruncated is false (caller owns repair policy)', () => {
    const raw = '{"summary":"ok","findings":[{"path":"a.ts","title":"one"},{"pa';
    expect(extractJson(raw, { repairTruncated: false })).toBeNull();
    // Default behavior is unchanged: truncated input is still repaired.
    expect(extractJson(raw)).not.toBeNull();
  });
  it('rejects a valid object smuggled inside a truncated outer array when repair is off', () => {
    const graph = JSON.stringify({
      outcome: 'diagram',
      nodes: [{ id: 'a', label: 'Validation', change: 'modified', evidence: [] }],
      edges: [],
    });
    const raw = '[' + graph + ',';
    expect(extractJson(raw, { repairTruncated: false })).toBeNull();
  });
  it('rejects a fenced block whose JSON body is malformed when repair is off', () => {
    const raw = '```json\n{"outcome":"diagram"},\n```';
    expect(extractJson(raw, { repairTruncated: false })).toBeNull();
  });
  it('still accepts a complete fenced JSON object when repair is off', () => {
    const graph = { outcome: 'diagram', nodes: [], edges: [] };
    const raw = '```json\n' + JSON.stringify(graph) + '\n```';
    expect(extractJson(raw, { repairTruncated: false })).toEqual(graph);
  });
});

describe('repairTruncatedJson', () => {
  it('keeps complete array elements and drops the partial trailing one', () => {
    const raw = '{"findings":[{"a":1},{"a":2},{"a":';
    expect(repairTruncatedJson(raw)).toEqual({ findings: [{ a: 1 }, { a: 2 }] });
  });

  it('closes an object truncated after a complete member', () => {
    const raw = '{"summary":"done","score":90,"walkthrough":[{"path":"x"}],"extra":"cut off';
    expect(repairTruncatedJson(raw)).toEqual({
      summary: 'done',
      score: 90,
      walkthrough: [{ path: 'x' }],
    });
  });

  it('does not mistake commas or braces inside strings for boundaries', () => {
    const raw = '{"summary":"a, b, {c}","findings":[{"title":"x"},{"title":"incomp';
    expect(repairTruncatedJson(raw)).toEqual({
      summary: 'a, b, {c}',
      findings: [{ title: 'x' }],
    });
  });

  it('returns null when nothing complete precedes the truncation', () => {
    expect(repairTruncatedJson('{"summary":"')).toBeNull();
    expect(repairTruncatedJson('no json here')).toBeNull();
  });
});

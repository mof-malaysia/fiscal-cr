import { describe, it, expect } from 'vitest';
import { extractJson } from '../../src/utils/json.js';

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
});

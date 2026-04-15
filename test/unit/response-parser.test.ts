import { describe, it, expect } from 'vitest';
import { parseAIResponse } from '../../src/kimi/response-parser.js';

const usage = { input: 1000, output: 500, cached: 0 };

describe('parseAIResponse', () => {
  it('parses valid JSON directly', () => {
    const raw = JSON.stringify({
      summary: 'Looks good',
      score: 90,
      annotations: [],
    });
    const result = parseAIResponse(raw, usage);
    expect(result.summary).toBe('Looks good');
    expect(result.score).toBe(90);
    expect(result.annotations).toHaveLength(0);
  });

  it('parses JSON from markdown code block', () => {
    const raw = `Here is my review:

\`\`\`json
{
  "summary": "Code looks clean",
  "score": 85,
  "annotations": [
    {
      "path": "src/index.ts",
      "startLine": 10,
      "endLine": 10,
      "severity": "suggestion",
      "category": "style",
      "title": "Consider using const",
      "body": "This variable is never reassigned"
    }
  ]
}
\`\`\``;
  const result = parseAIResponse(raw, usage);
    expect(result.summary).toBe('Code looks clean');
    expect(result.score).toBe(85);
    expect(result.annotations).toHaveLength(1);
    expect(result.annotations[0].title).toBe('Consider using const');
  });

  it('extracts JSON embedded in thinking/text', () => {
    const raw = `Let me analyze this PR carefully.

The changes look straightforward — adding a YAML config file.

{"summary":"Simple config addition","score":95,"annotations":[{"path":".kimi-review.yml","startLine":1,"endLine":14,"severity":"suggestion","category":"style","title":"Consider adding comments","body":"Adding inline comments would help users understand each option"}]}

That concludes my review.`;
  const result = parseAIResponse(raw, usage);
    expect(result.summary).toBe('Simple config addition');
    expect(result.score).toBe(95);
    expect(result.annotations).toHaveLength(1);
    expect(result.stats.suggestion).toBe(1);
  });

  it('handles snake_case field names', () => {
    const raw = JSON.stringify({
      summary: 'Review done',
      score: 80,
      annotations: [
        {
          path: 'src/app.ts',
          start_line: 5,
          end_line: 8,
          severity: 'warning',
          category: 'performance',
          title: 'Slow loop',
          body: 'Use map instead',
          suggested_fix: 'arr.map(x => x * 2)',
        },
      ],
    });
    const result = parseAIResponse(raw, usage);
    expect(result.annotations).toHaveLength(1);
    expect(result.annotations[0].startLine).toBe(5);
    expect(result.annotations[0].endLine).toBe(8);
    expect(result.annotations[0].suggestedFix).toBe('arr.map(x => x * 2)');
    expect(result.stats.warning).toBe(1);
  });

  it('handles single "line" field instead of startLine/endLine', () => {
    const raw = JSON.stringify({
      summary: 'Found issue',
      score: 60,
      annotations: [
        {
          path: 'src/main.ts',
          line: 42,
          severity: 'critical',
          category: 'bug',
          title: 'Null dereference',
          body: 'x might be null here',
        },
      ],
    });
    const result = parseAIResponse(raw, usage);
    expect(result.annotations[0].startLine).toBe(42);
    expect(result.annotations[0].endLine).toBe(42);
    expect(result.stats.critical).toBe(1);
  });

  it('salvages valid annotations when some are invalid', () => {
    const raw = JSON.stringify({
      summary: 'Mixed results',
      score: 70,
      annotations: [
        {
          path: 'a.ts',
          startLine: 1,
          endLine: 1,
          severity: 'warning',
          category: 'bug',
          title: 'Good one',
          body: 'Valid',
        },
        {
          // missing required fields
          severity: 'invalid_value',
        },
        {
          path: 'b.ts',
          startLine: 5,
          endLine: 5,
          severity: 'suggestion',
          category: 'style',
          title: 'Another good one',
          body: 'Also valid',
        },
      ],
    });
    const result = parseAIResponse(raw, usage);
    // Schema-level parse will fail because of the bad annotation,
    // but salvage should recover the 2 valid ones
    expect(result.annotations.length).toBeGreaterThanOrEqual(2);
    expect(result.summary).toBe('Mixed results');
  });

  it('parses common JSON-like output with unquoted keys and trailing commas', () => {
    const raw = `Here is the review:
    {
      summary: 'Mostly good overall',
      score: 84,
      annotations: [],
    }`;

    const result = parseAIResponse(raw, usage);
    expect(result.summary).toBe('Mostly good overall');
    expect(result.score).toBe(84);
    expect(result.annotations).toHaveLength(0);
  });

  it('uses the model text as a summary when no JSON can be extracted', () => {
    const raw = 'The PR looks mostly fine. I would suggest adding more validation around user input and improving error handling.';
    const result = parseAIResponse(raw, usage);
    expect(result.summary).toContain('The PR looks mostly fine');
    expect(result.summary).not.toContain('Failed to parse AI response as JSON');
    expect(result.score).toBe(50);
    expect(result.annotations).toHaveLength(0);
    expect(result.tokensUsed).toEqual(usage);
  });
});

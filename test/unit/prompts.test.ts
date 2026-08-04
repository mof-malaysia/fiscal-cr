import { describe, expect, it } from 'vitest';
import { DEFAULT_CONFIG } from '../../src/config/defaults.js';
import { buildFastPathSystemPrompt } from '../../src/pipeline/prompts.js';

describe('fast-path prompt', () => {
  it('preserves the stable prompt by default', () => {
    const prompt = buildFastPathSystemPrompt(DEFAULT_CONFIG);

    expect(DEFAULT_CONFIG.experimental).toBe(false);
    expect(prompt).not.toContain('## Concision Rules');
    expect(prompt).not.toContain('Keep intent to at most 40 words.');
    expect(prompt).not.toContain('\n\n\n## Line Number Rules');
  });

  it('requires concise output when experimental features are enabled', () => {
    const prompt = buildFastPathSystemPrompt({
      ...DEFAULT_CONFIG,
      experimental: true,
    });

    expect(prompt).toContain('## Concision Rules');
    expect(prompt).toContain('Keep intent to at most 40 words.');
    expect(prompt).toContain('Keep summary to at most 80 words.');
    expect(prompt).toContain('Keep each walkthrough summary to at most 20 words.');
    expect(prompt).toContain('Keep each finding body to at most 80 words');
    expect(prompt).toContain('Do not narrate the schema');
    expect(prompt).toContain('Preserve JSON keys, code, symbols, paths, line numbers, and suggested fixes exactly.');
  });
});

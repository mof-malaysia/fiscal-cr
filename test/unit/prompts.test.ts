import { describe, expect, it } from 'vitest';
import { DEFAULT_CONFIG } from '../../src/config/defaults.js';
import { buildFastPathSystemPrompt, buildSynthesisSystemPrompt } from '../../src/pipeline/prompts.js';

describe('fast-path prompt', () => {
  it('preserves the stable prompt by default', () => {
    const prompt = buildFastPathSystemPrompt(DEFAULT_CONFIG);

    expect(DEFAULT_CONFIG.experimental).toBe(false);
    expect(prompt).not.toContain('## Concision Rules');
    expect(prompt).not.toContain('Keep intent to at most 40 words.');
    expect(prompt).not.toContain('\n\n\n## Line Number Rules');
  });

  it('applies concise finding style rules by default', () => {
    const prompt = buildFastPathSystemPrompt(DEFAULT_CONFIG);

    expect(prompt).toContain('## Finding Style');
    expect(prompt).toContain('Keep the body to 2-4 sentences and 60 words or fewer.');
    expect(prompt).toContain('Do not add a "Suggested fix:" heading.');
  });

  it('requires concise output when experimental features are enabled', () => {
    const prompt = buildFastPathSystemPrompt({
      ...DEFAULT_CONFIG,
      experimental: true,
    });

    expect(prompt).toContain('Keep summary to at most 80 words.');
    expect(prompt).toContain('Put each summary sentence on its own Markdown bullet line.');
    expect(prompt).toContain('Keep each finding body to at most 60 words');
    expect(prompt).toContain('Do not narrate the schema');
    expect(prompt).toContain('Preserve JSON keys, code, symbols, paths, line numbers, and suggested fixes exactly.');
  });
});

describe('synthesis prompt', () => {
  it('keeps the style experiment disabled by default', () => {
    const prompt = buildSynthesisSystemPrompt(DEFAULT_CONFIG);

    expect(prompt).not.toContain('## Writing Style');
    expect(prompt).not.toContain('State each fact once.');
  });

  it('adds the adapted style rules in experimental mode', () => {
    const prompt = buildSynthesisSystemPrompt({ ...DEFAULT_CONFIG, experimental: true });

    expect(prompt).toContain('## Writing Style');
    expect(prompt).toContain('State each fact once.');
    expect(prompt).toContain('Prefer a short bulleted list over long prose');
    expect(prompt).toContain('preserve technical terms such as "throws" and "catches"');
  });
});

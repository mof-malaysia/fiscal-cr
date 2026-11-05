import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { reviewConfigSchema } from '../../src/config/schema.js';
import { LLMS_PATH, readAction, renderLlmsTxt, versionOf } from '../../scripts/generate-llms.js';

const committed = readFileSync(LLMS_PATH, 'utf8');

describe('llms.txt', () => {
  it('is in sync with its sources (run `pnpm llms:sync`)', () => {
    // CI checkouts are shallow, without tags, so render for the committed version.
    const version = versionOf(committed);
    expect(version).toMatch(/^v\d+\.\d+\.\d+$/);
    expect(renderLlmsTxt(version!)).toBe(committed);
  });

  it('names every Action input and output', () => {
    const action = readAction();
    for (const name of [...Object.keys(action.inputs), ...Object.keys(action.outputs)]) {
      expect(committed, `llms.txt is missing ${name}`).toContain(`\`${name}\``);
    }
  });

  it('covers every top-level config key', () => {
    for (const key of Object.keys(reviewConfigSchema.shape)) {
      expect(committed, `llms.txt is missing config key ${key}`).toMatch(new RegExp(`(^|\\n|\`)${key}[:\`.]`));
    }
  });
});

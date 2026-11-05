import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { reviewConfigSchema } from '../../src/config/schema.js';
import { LLMS_PATH, readAction, renderLlmsTxt, versionOf } from '../../scripts/generate-llms.js';
import { README_PATH } from '../../scripts/sync-provider-models.js';

const committed = readFileSync(LLMS_PATH, 'utf8');
const action = readAction();
// CI checkouts are shallow, without tags, so the committed guide's version stands in for the latest tag.
const version = versionOf(committed);

describe('llms.txt', () => {
  it('is in sync with its sources (run `pnpm llms:sync`)', () => {
    expect(version).toMatch(/^v\d+\.\d+\.\d+$/);
    expect(renderLlmsTxt(version!, action)).toBe(committed);
  });

  it('names every Action input and output', () => {
    for (const name of [...Object.keys(action.inputs), ...Object.keys(action.outputs)]) {
      expect(committed, `llms.txt is missing ${name}`).toContain(`\`${name}\``);
    }
  });

  it('covers every top-level config key', () => {
    for (const key of Object.keys(reviewConfigSchema.shape)) {
      expect(committed, `llms.txt is missing config key ${key}`).toMatch(new RegExp(`(^|\\n|\`)${key}[:\`.]`));
    }
  });

  it('pins the README examples to the same release', () => {
    const pins = readFileSync(README_PATH, 'utf8').match(/mof-malaysia\/fiscal-cr@v[\w.-]+/g) ?? [];
    expect(pins.length).toBeGreaterThan(0);
    expect(new Set(pins)).toEqual(new Set([`mof-malaysia/fiscal-cr@${version}`]));
  });
});

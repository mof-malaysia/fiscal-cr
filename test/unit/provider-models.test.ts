import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { PROVIDER_DEFAULT_MODELS } from '../../src/config/provider-models.js';
import { resolvePricing } from '../../src/utils/pricing.js';
import { README_PATH, syncReadme } from '../../scripts/sync-provider-models.js';

// Release defaults that knowingly lack a pricing entry (cost uses the fallback
// estimate). Remove an entry once its price is added to src/utils/pricing.ts.
const UNPRICED_DEFAULTS = new Set(['kimi/k3', 'kimi/k3-256k']);

describe('release-pinned provider models', () => {
  it('keeps the README model table in sync (run `pnpm models:sync`)', () => {
    const readme = readFileSync(README_PATH, 'utf8');
    expect(syncReadme(readme)).toBe(readme);
  });

  it('has pricing for every default model', () => {
    const unpriced = Object.entries(PROVIDER_DEFAULT_MODELS)
      .flatMap(([provider, stages]) => Object.values(stages).map((model) => `${provider}/${model}`))
      .filter((key, i, all) => all.indexOf(key) === i)
      .filter((key) => {
        const [provider, model] = key.split('/');
        return resolvePricing({ provider, model }).source === 'fallback';
      });
    expect(new Set(unpriced)).toEqual(UNPRICED_DEFAULTS);
  });
});

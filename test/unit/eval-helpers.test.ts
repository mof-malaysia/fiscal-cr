import { describe, expect, it } from 'vitest';
import {
  buildPromptReport,
  evalReviewConfig,
  formatDelta,
  requireApiKey,
  resolveEvalEnv,
  type RunStats,
} from '../../scripts/eval-helpers.js';
import { buildSyntheticContext } from '../../scripts/eval-fixture.js';
import { DEFAULT_CONFIG } from '../../src/config/defaults.js';

const emptyEnv: NodeJS.ProcessEnv = {};

describe('resolveEvalEnv', () => {
  it('falls back to DEFAULT_CONFIG provider and model', () => {
    const cfg = resolveEvalEnv(emptyEnv);
    expect(cfg.provider).toBe(DEFAULT_CONFIG.provider);
    expect(cfg.model).toBe(DEFAULT_CONFIG.model);
    expect(cfg.apiKey).toBeUndefined();
    expect(cfg.baseUrl).toBeUndefined();
  });

  it('resolves API_KEY with FISCALCR_API_KEY / KIMI_API_KEY fallbacks', () => {
    expect(resolveEvalEnv({ API_KEY: 'a' }).apiKey).toBe('a');
    expect(resolveEvalEnv({ API_KEY: 'a', FISCALCR_API_KEY: 'f' }).apiKey).toBe('a');
    expect(resolveEvalEnv({ FISCALCR_API_KEY: 'f', KIMI_API_KEY: 'k' }).apiKey).toBe('f');
    expect(resolveEvalEnv({ KIMI_API_KEY: 'k' }).apiKey).toBe('k');
  });

  it('resolves MODEL with KIMI_MODEL fallback before the default', () => {
    expect(resolveEvalEnv({ MODEL: 'm1', KIMI_MODEL: 'm2' }).model).toBe('m1');
    expect(resolveEvalEnv({ KIMI_MODEL: 'm2' }).model).toBe('m2');
    // Empty MODEL falls through to KIMI_MODEL, then to DEFAULT_CONFIG.model.
    expect(resolveEvalEnv({ MODEL: '', KIMI_MODEL: 'm2' }).model).toBe('m2');
    expect(resolveEvalEnv({ KIMI_MODEL: '' }).model).toBe(DEFAULT_CONFIG.model);
  });

  it('treats empty-string env values as unset', () => {
    const cfg = resolveEvalEnv({ API_KEY: '', MODEL: '', BASE_URL: '' });
    expect(cfg.apiKey).toBeUndefined();
    expect(cfg.model).toBe(DEFAULT_CONFIG.model);
    expect(cfg.baseUrl).toBeUndefined();
  });

  it('validates MODEL_PROVIDER cleanly', () => {
    expect(resolveEvalEnv({ MODEL_PROVIDER: 'openai-compatible' }).provider).toBe(
      'openai-compatible',
    );
    expect(() => resolveEvalEnv({ MODEL_PROVIDER: 'anthropic' })).toThrow(
      /Invalid MODEL_PROVIDER "anthropic"/,
    );
  });

  it('resolves BASE_URL with FISCALCR_BASE_URL fallback and LLM_USER_AGENT', () => {
    expect(
      resolveEvalEnv({ BASE_URL: 'https://a.example/v1', FISCALCR_BASE_URL: 'https://b.example/v1' }).baseUrl,
    ).toBe('https://a.example/v1');
    expect(resolveEvalEnv({ FISCALCR_BASE_URL: 'https://b.example/v1' }).baseUrl).toBe(
      'https://b.example/v1',
    );
    expect(resolveEvalEnv({ LLM_USER_AGENT: 'agent/1' }).userAgent).toBe('agent/1');
  });
});

describe('requireApiKey', () => {
  it('throws a clear error when the key is missing', () => {
    expect(() => requireApiKey({ provider: 'kimi', model: 'm' })).toThrow(/API key/);
  });

  it('returns the key when present', () => {
    expect(requireApiKey({ provider: 'kimi', model: 'm', apiKey: 'sk-test' })).toBe('sk-test');
  });
});

describe('evalReviewConfig', () => {
  const cfg = { provider: 'openai-compatible', model: 'gpt-4.1-mini', baseUrl: 'https://x/v1' };

  it('toggles experimental and overrides provider/model/baseUrl', () => {
    const off = evalReviewConfig(cfg, false);
    expect(off.experimental).toBe(false);
    expect(off.provider).toBe('openai-compatible');
    expect(off.model).toBe('gpt-4.1-mini');
    expect(off.baseUrl).toBe('https://x/v1');

    const on = evalReviewConfig(cfg, true);
    expect(on.experimental).toBe(true);
  });

  it('omits baseUrl when unset', () => {
    const off = evalReviewConfig({ provider: 'kimi', model: 'm' }, false);
    expect(off.baseUrl).toBeUndefined();
  });
});

describe('buildPromptReport', () => {
  const ctx = buildSyntheticContext();

  it('is keyless, measures real prompts, and flags Concision Rules by experimental', () => {
    const baseline = buildPromptReport(evalReviewConfig({ provider: 'kimi', model: 'm' }, false), ctx);
    expect(baseline.hasConcisionRules).toBe(false);
    expect(baseline.systemChars).toBeGreaterThan(0);
    expect(baseline.estimatedTokens).toBeGreaterThan(0);
    expect(baseline.totalChars).toBe(baseline.systemChars + baseline.userChars);

    const experimental = buildPromptReport(
      evalReviewConfig({ provider: 'kimi', model: 'm' }, true),
      ctx,
    );
    expect(experimental.hasConcisionRules).toBe(true);
    expect(experimental.systemChars).toBeGreaterThan(baseline.systemChars);
  });
});

describe('buildSyntheticContext fixture', () => {
  it('has valid unified diff hunks and matching contents', () => {
    const ctx = buildSyntheticContext();
    expect(ctx.changedFiles).toHaveLength(2);

    const retry = ctx.changedFiles.find((f) => f.filename === 'src/utils/retry.ts')!;
    expect(retry.patch).toMatch(/^@@ -6,9 \+6,12 @@/);
    expect(retry.additions).toBe(3);
    expect(ctx.fileContents.get('src/utils/retry.ts')).toContain('await sleep(100 * 2 ** i);');

    const cache = ctx.changedFiles.find((f) => f.filename === 'src/utils/cache.ts')!;
    expect(cache.patch).toMatch(/^@@ -0,0 \+1,20 @@/);
    expect(cache.additions).toBe(20);
    expect(ctx.fileContents.get('src/utils/cache.ts')).toContain('class ReviewCache');
    // No real credentials in the fixture.
    expect(ctx.diff).not.toMatch(/sk-(live|real)-[A-Za-z0-9]{20,}/);
  });
});

describe('formatDelta', () => {
  const base: RunStats = {
    experimental: false,
    durationMs: 8000,
    input: 1000,
    output: 500,
    cached: 0,
    calls: 1,
    score: 70,
    findings: 3,
  };
  const exp: RunStats = { ...base, durationMs: 9200, input: 1100, output: 455, findings: 2 };

  it('reports signed token/duration/finding deltas', () => {
    const delta = formatDelta(base, exp);
    expect(delta).toContain('duration   +1.20s');
    expect(delta).toContain('input      +100 tokens');
    expect(delta).toContain('output     -45 tokens');
    expect(delta).toContain('findings   -1');
  });
});

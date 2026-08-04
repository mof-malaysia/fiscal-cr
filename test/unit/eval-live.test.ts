import { readdirSync } from 'node:fs';
import { afterEach, describe, expect, it, vi } from 'vitest';

// Prove dry mode never creates a live provider: the factory is replaced with a
// spy that throws when called. Dry main must never call it. SUPPORTED_PROVIDERS
// stays real so env resolution works.
vi.mock('../../src/providers/factory.js', async (importOriginal) => {
  const actual =
    await importOriginal<typeof import('../../src/providers/factory.js')>();
  return {
    ...actual,
    createLLMProvider: vi.fn(() => {
      throw new Error('createLLMProvider must not be called during a dry run');
    }),
  };
});

import { main } from '../../scripts/eval-live.js';
import { createLLMProvider } from '../../src/providers/factory.js';

const RESULT_DIR = '.eval-results';

function resultFileCount(): number {
  try {
    return readdirSync(RESULT_DIR).length;
  } catch {
    return 0;
  }
}

const mockedCreate = vi.mocked(createLLMProvider);

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  mockedCreate.mockClear();
});

describe('eval-live main (dry run)', () => {
  it('prints the smoke plan (3 cases, 6 calls, seed, rounds) with zero provider/artifact side effects', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    const before = resultFileCount();

    await main(['--dry-run']); // no API key needed

    const output = log.mock.calls.map((c) => c.join(' ')).join('\n');
    expect(output).toContain('clean-01, local-01, security-01');
    expect(output).toContain('fiscalcr-eval-v2'); // default seed
    expect(output).toContain('6 calls (3 cases × 1 × 2 variants)');
    expect(output).toContain('Budget: 6 planned calls');
    expect(output).toContain('Prompts (baseline)');
    expect(output).toContain('Prompts (experimental)');
    expect(output).toContain('no network calls, no artifact written');

    expect(mockedCreate).not.toHaveBeenCalled();
    expect(resultFileCount()).toBe(before);
    log.mockRestore();
  });

  it('shows the exceeded budget guard without failing (full 20 > guard 4)', async () => {
    vi.stubEnv('EVAL_SUITE', 'full');
    vi.stubEnv('EVAL_MAX_CALLS', '4');
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    const before = resultFileCount();

    await expect(main(['--dry-run'])).resolves.toBeUndefined();

    const output = log.mock.calls.map((c) => c.join(' ')).join('\n');
    expect(output).toContain('20 calls (10 cases × 1 × 2 variants)');
    expect(output).toContain('EXCEEDS EVAL_MAX_CALLS=4');
    expect(mockedCreate).not.toHaveBeenCalled();
    expect(resultFileCount()).toBe(before);
    log.mockRestore();
  });

  it('rejects an invalid suite as a config failure (nonzero path, not silent)', async () => {
    vi.stubEnv('EVAL_SUITE', 'bogus');
    await expect(main(['--dry-run'])).rejects.toThrow(/Invalid EVAL_SUITE/);
    expect(mockedCreate).not.toHaveBeenCalled();
  });
});

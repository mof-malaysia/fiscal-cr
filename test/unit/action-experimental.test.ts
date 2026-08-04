import { describe, expect, it, vi } from 'vitest';
import { experimentalFromActionInput } from '../../action/experimental.js';

function actionCore(raw: string, enabled: boolean) {
  return {
    getInput: vi.fn(() => raw),
    getBooleanInput: vi.fn(() => enabled),
  };
}

describe('Action experimental input', () => {
  it('preserves repo config when the input is absent', () => {
    const core = actionCore('', false);

    expect(experimentalFromActionInput(core)).toBeUndefined();
    expect(core.getInput).toHaveBeenCalledWith('experimental');
    expect(core.getBooleanInput).not.toHaveBeenCalled();
  });

  it.each([
    ['true', true],
    ['false', false],
  ])('returns %s when explicitly provided', (raw, enabled) => {
    const core = actionCore(raw, enabled);

    expect(experimentalFromActionInput(core)).toBe(enabled);
    expect(core.getInput).toHaveBeenCalledWith('experimental');
    expect(core.getBooleanInput).toHaveBeenCalledWith('experimental');
  });
});

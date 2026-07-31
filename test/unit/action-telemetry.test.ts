import { describe, expect, it, vi } from 'vitest';
import { telemetryFromActionInput } from '../../action/telemetry.js';

function actionCore(enabled: boolean) {
  return {
    getBooleanInput: vi.fn(() => enabled),
    info: vi.fn(),
  };
}

describe('Action telemetry input', () => {
  it.each([
    ['absent', false],
    ['false', false],
  ])('disables telemetry when input is %s', (_label: string, enabled: boolean) => {
    const core = actionCore(enabled);

    expect(telemetryFromActionInput(core)).toBeUndefined();
    expect(core.getBooleanInput).toHaveBeenCalledWith('telemetry');
    expect(core.info).not.toHaveBeenCalled();
  });

  it('creates a prefixed JSON log sink when enabled', () => {
    const core = actionCore(true);
    const telemetry = telemetryFromActionInput(core);

    telemetry?.({
      type: 'review_completed',
      calls: 2,
      inputTokens: 100,
      outputTokens: 20,
      cachedTokens: 5,
      annotations: 1,
    });

    expect(core.getBooleanInput).toHaveBeenCalledWith('telemetry');
    expect(core.info).toHaveBeenCalledWith(
      '[fiscalcr-telemetry] {"type":"review_completed","calls":2,"inputTokens":100,"outputTokens":20,"cachedTokens":5,"annotations":1}',
    );
  });

  it('swallows logging failures', () => {
    const core = actionCore(true);
    core.info.mockImplementation(() => {
      throw new Error('logging unavailable');
    });
    const telemetry = telemetryFromActionInput(core);

    expect(() =>
      telemetry?.({ type: 'stage_result', stage: 'intent', status: 'failed' }),
    ).not.toThrow();
  });
});

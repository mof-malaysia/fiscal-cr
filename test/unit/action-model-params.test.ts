import { describe, expect, it, vi } from 'vitest';
import { modelParamsFromActionInput } from '../../action/model-params.js';
import { ConfigError } from '../../src/utils/errors.js';

function actionCore(raw: string) {
  return { getInput: vi.fn(() => raw) };
}

describe('Action model_params input', () => {
  it('returns undefined when the input is absent (preserves repo config)', () => {
    expect(modelParamsFromActionInput(actionCore(''))).toBeUndefined();
    expect(modelParamsFromActionInput(actionCore('   '))).toBeUndefined();
  });

  it('parses a JSON object', () => {
    const result = modelParamsFromActionInput(
      actionCore('{"reasoning_effort":"high","top_p":0.9}'),
    );
    expect(result).toEqual({ reasoning_effort: 'high', top_p: 0.9 });
  });

  it('throws ConfigError on invalid JSON', () => {
    expect(() => modelParamsFromActionInput(actionCore('{not json}'))).toThrowError(
      ConfigError,
    );
  });

  it('throws ConfigError when the JSON is not an object', () => {
    expect(() => modelParamsFromActionInput(actionCore('"high"'))).toThrowError(ConfigError);
    expect(() => modelParamsFromActionInput(actionCore('[1,2,3]'))).toThrowError(ConfigError);
    expect(() => modelParamsFromActionInput(actionCore('42'))).toThrowError(ConfigError);
  });
});

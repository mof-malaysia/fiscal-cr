import { ConfigError } from "../src/utils/errors.js";

interface ActionModelParamsCore {
  getInput(name: string): string;
}

/**
 * Parse the `model_params` Action input — a JSON object of extra OpenAI request
 * fields (e.g. `{"reasoning_effort":"high"}`) merged into every model call.
 * Returns `undefined` when the input is empty (so it won't override repo config),
 * and throws a ConfigError on invalid JSON or a non-object result.
 */
export function modelParamsFromActionInput(
  core: ActionModelParamsCore,
): Record<string, unknown> | undefined {
  const raw = core.getInput("model_params").trim();
  if (!raw) return undefined;

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new ConfigError(
      `Invalid model_params input: expected a JSON object, failed to parse (${
        (err as Error).message
      })`,
    );
  }

  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new ConfigError(
      `Invalid model_params input: expected a JSON object, got ${
        Array.isArray(parsed) ? "an array" : typeof parsed
      }`,
    );
  }

  return parsed as Record<string, unknown>;
}

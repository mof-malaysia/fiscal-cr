interface ActionModelParamsCore {
    getInput(name: string): string;
}
/**
 * Parse the `model_params` Action input — a JSON object of extra OpenAI request
 * fields (e.g. `{"reasoning_effort":"high"}`) merged into every model call.
 * Returns `undefined` when the input is empty (so it won't override repo config),
 * and throws a ConfigError on invalid JSON or a non-object result.
 */
export declare function modelParamsFromActionInput(core: ActionModelParamsCore): Record<string, unknown> | undefined;
export {};
//# sourceMappingURL=model-params.d.ts.map
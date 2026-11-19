import type { FiscalcrOctokit } from '../src/github/client.js';
type ActionsOctokit = {
    rest: object;
    graphql: unknown;
};
/** Adapt @actions/github's namespaced client to FiscalCR's shared API shape. */
export declare function createActionOctokit(octokit: ActionsOctokit): FiscalcrOctokit;
export {};
//# sourceMappingURL=github-client.d.ts.map
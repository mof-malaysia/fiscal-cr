import type { FiscalcrOctokit } from '../src/github/client.js';

type ActionsOctokit = {
  rest: object;
  graphql: unknown;
};

/** Adapt @actions/github's namespaced client to FiscalCR's shared API shape. */
export function createActionOctokit(octokit: ActionsOctokit): FiscalcrOctokit {
  return {
    ...(octokit.rest as Omit<FiscalcrOctokit, 'graphql'>),
    ...(typeof octokit.graphql === 'function'
      ? { graphql: octokit.graphql as FiscalcrOctokit['graphql'] }
      : {}),
  };
}

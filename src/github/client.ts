import type { Octokit } from '@octokit/rest';

/**
 * GitHub APIs used by FiscalCR. Action mode adapts @actions/github's REST
 * namespace to this same shape and explicitly preserves GraphQL access.
 */
export interface FiscalcrOctokit {
  checks: Octokit['checks'];
  issues: Octokit['issues'];
  pulls: Octokit['pulls'];
  repos: Octokit['repos'];
  graphql?: Octokit['graphql'];
}

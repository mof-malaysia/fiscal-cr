import type { Octokit } from '@octokit/rest';
import { type ReviewConfig } from './schema.js';
export declare function loadConfig(octokit: Octokit, owner: string, repo: string, configPath?: string): Promise<ReviewConfig>;
//# sourceMappingURL=loader.d.ts.map
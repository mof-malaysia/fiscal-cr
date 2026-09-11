import type { FiscalcrOctokit } from '../github/client.js';
import { type ReviewConfig } from './schema.js';
export declare function loadConfig(octokit: FiscalcrOctokit, owner: string, repo: string, configPath?: string, ref?: string): Promise<ReviewConfig>;
//# sourceMappingURL=loader.d.ts.map
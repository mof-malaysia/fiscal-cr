import type { ReviewConfig } from '../config/schema.js';
import type { FileGroup } from './grouper.js';
/** Extract relative import specifiers (./x, ../y) from JS/TS source. */
export declare function extractImportSpecs(content: string): string[];
/**
 * For a review group, collect unchanged files imported by the group's changed
 * files (Action mode only — requires a local checkout). Related files are
 * ranked by how many changed files reference them.
 */
export declare function collectRelatedContext(group: FileGroup, fileContents: Map<string, string>, workspaceRoot: string, config: ReviewConfig, changedPaths: Set<string>): Promise<Map<string, string>>;
//# sourceMappingURL=related-context.d.ts.map
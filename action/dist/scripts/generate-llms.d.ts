export declare const LLMS_PATH: string;
/** The version a rendered guide was written for, from its title line. */
export declare function versionOf(guide: string): string | undefined;
interface ActionField {
    description?: string;
    required?: boolean;
    default?: string;
}
interface ActionMetadata {
    inputs: Record<string, ActionField>;
    outputs: Record<string, ActionField>;
}
export declare function readAction(): ActionMetadata;
export declare function renderLlmsTxt(version: string, action?: ActionMetadata): string;
export {};
//# sourceMappingURL=generate-llms.d.ts.map
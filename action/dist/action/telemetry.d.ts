import type { TelemetrySink } from "../src/pipeline/usage.js";
interface ActionTelemetryCore {
    getBooleanInput(name: string): boolean;
    info(message: string): void;
}
export declare function telemetryFromActionInput(core: ActionTelemetryCore): TelemetrySink | undefined;
export {};
//# sourceMappingURL=telemetry.d.ts.map
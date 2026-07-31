import type { TelemetrySink } from "../src/pipeline/usage.js";

interface ActionTelemetryCore {
  getBooleanInput(name: string): boolean;
  info(message: string): void;
}

export function telemetryFromActionInput(
  core: ActionTelemetryCore,
): TelemetrySink | undefined {
  if (!core.getBooleanInput("telemetry")) return undefined;

  return (event) => {
    try {
      core.info(`[fiscalcr-telemetry] ${JSON.stringify(event)}`);
    } catch {
      // Telemetry must never affect review behavior.
    }
  };
}

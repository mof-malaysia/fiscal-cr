interface ActionExperimentalCore {
  getInput(name: string): string;
  getBooleanInput(name: string): boolean;
}

export function experimentalFromActionInput(
  core: ActionExperimentalCore,
): boolean | undefined {
  if (!core.getInput("experimental")) return undefined;
  return core.getBooleanInput("experimental");
}

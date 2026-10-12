import type { AnthropicFederationConfig } from "../src/providers/anthropic-auth.js";
import { ConfigError } from "../src/utils/errors.js";

interface ActionFederationCore {
  getInput(name: string): string;
  getIDToken(audience?: string): Promise<string>;
}

const DEFAULT_OIDC_AUDIENCE = "https://api.anthropic.com";

const REQUIRED_INPUTS = [
  "anthropic_federation_rule_id",
  "anthropic_organization_id",
  "anthropic_service_account_id",
] as const;

/**
 * Parse the Anthropic workload identity federation inputs. Returns `undefined`
 * when none are set (API-key mode) and throws a ConfigError when only some of
 * the required inputs are present. The identity token is minted from the
 * GitHub Actions OIDC endpoint on every exchange, since GitHub tokens are
 * single-use (`jti`) and short-lived.
 */
export function federationFromActionInput(
  core: ActionFederationCore,
): AnthropicFederationConfig | undefined {
  const values = Object.fromEntries(
    REQUIRED_INPUTS.map((name) => [name, core.getInput(name).trim()]),
  ) as Record<(typeof REQUIRED_INPUTS)[number], string>;
  const workspaceId = core.getInput("anthropic_workspace_id").trim() || undefined;
  const audience = core.getInput("oidc_audience").trim() || DEFAULT_OIDC_AUDIENCE;

  const missing = REQUIRED_INPUTS.filter((name) => !values[name]);
  if (missing.length === REQUIRED_INPUTS.length) {
    if (workspaceId) {
      throw new ConfigError(
        `anthropic_workspace_id is set but federation is not configured; also set ${REQUIRED_INPUTS.join(", ")}`,
      );
    }
    return undefined;
  }
  if (missing.length > 0) {
    throw new ConfigError(
      `Incomplete Anthropic federation inputs: missing ${missing.join(", ")}`,
    );
  }

  return {
    federationRuleId: values.anthropic_federation_rule_id,
    organizationId: values.anthropic_organization_id,
    serviceAccountId: values.anthropic_service_account_id,
    workspaceId,
    getIdentityToken: async () => {
      try {
        return await core.getIDToken(audience);
      } catch (err) {
        throw new ConfigError(
          `Could not obtain a GitHub OIDC token (${(err as Error).message}). ` +
            "Add `permissions: id-token: write` to the workflow; pull requests from forks cannot use federation.",
        );
      }
    },
  };
}

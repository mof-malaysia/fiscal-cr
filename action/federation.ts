import type {
  FederationConfig,
  FederationExchangeConfig,
} from "../src/providers/federation.js";
import { ConfigError } from "../src/utils/errors.js";

interface ActionFederationCore {
  getInput(name: string): string;
  getIDToken(audience?: string): Promise<string>;
}

/** Per-provider input parsers: each returns its exchange when its inputs are set. */
const EXCHANGE_PARSERS: ReadonlyArray<
  (core: ActionFederationCore) => FederationExchangeConfig | undefined
> = [anthropicExchangeFromInput];

/**
 * Parse workload identity federation inputs. Returns `undefined` when none
 * are set (API-key mode). The identity token comes from the GitHub Actions
 * OIDC endpoint; the exchange is chosen by which provider's inputs are set.
 */
export function federationFromActionInput(
  core: ActionFederationCore,
): FederationConfig | undefined {
  const exchanges = EXCHANGE_PARSERS.map((parse) => parse(core)).filter(
    (exchange) => exchange !== undefined,
  );
  if (exchanges.length > 1) {
    throw new ConfigError(
      `Federation inputs set for more than one provider: ${exchanges.map((e) => e.type).join(", ")}`,
    );
  }
  const [exchange] = exchanges;
  if (!exchange) return undefined;

  return {
    exchange,
    audience: core.getInput("oidc_audience").trim() || undefined,
    getIdentityToken: githubOidcToken(core),
  };
}

/** Mints a fresh GitHub Actions OIDC token per call (they are single-use and short-lived). */
function githubOidcToken(core: ActionFederationCore) {
  return async (audience: string) => {
    try {
      return await core.getIDToken(audience);
    } catch (err) {
      throw new ConfigError(
        `Could not obtain a GitHub OIDC token (${(err as Error).message}). ` +
          "Add `permissions: id-token: write` to the workflow; pull requests from forks cannot use federation.",
      );
    }
  };
}

function anthropicExchangeFromInput(
  core: ActionFederationCore,
): FederationExchangeConfig | undefined {
  const input = (name: string) => core.getInput(name).trim();
  const required = {
    anthropic_federation_rule_id: input("anthropic_federation_rule_id"),
    anthropic_organization_id: input("anthropic_organization_id"),
    anthropic_service_account_id: input("anthropic_service_account_id"),
  };
  const workspaceId = input("anthropic_workspace_id") || undefined;

  const missing = Object.entries(required)
    .filter(([, value]) => !value)
    .map(([name]) => name);
  if (missing.length === Object.keys(required).length) {
    if (workspaceId) {
      throw new ConfigError(
        `anthropic_workspace_id is set but federation is not configured; also set ${missing.join(", ")}`,
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
    type: "anthropic",
    federationRuleId: required.anthropic_federation_rule_id,
    organizationId: required.anthropic_organization_id,
    serviceAccountId: required.anthropic_service_account_id,
    workspaceId,
  };
}

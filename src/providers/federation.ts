import type { ReviewConfig } from '../config/schema.js';
import { ConfigError, errorSnippet, LLMApiError } from '../utils/errors.js';
import { logger } from '../utils/logger.js';
import { federatedAuth, type RequestAuth, type TokenExchange } from './auth.js';
import { DEFAULT_USER_AGENT } from './interface.js';

/** Anthropic workload identity federation (RFC 7523 jwt-bearer at /v1/oauth/token). */
export interface AnthropicFederationExchange {
  type: 'anthropic';
  federationRuleId: string;
  organizationId: string;
  serviceAccountId: string;
  /** Required only when the federation rule spans multiple workspaces. */
  workspaceId?: string;
}

/**
 * Provider-specific token exchanges. To add one: extend this union, add a
 * FEDERATION_EXCHANGES entry, and a case in tokenExchangeFor().
 */
export type FederationExchangeConfig = AnthropicFederationExchange;

export interface FederationConfig {
  exchange: FederationExchangeConfig;
  /** Mints a fresh IdP identity token (JWT) for the given audience. */
  getIdentityToken: (audience: string) => Promise<string>;
  /** Identity token audience; defaults to the exchange's own. */
  audience?: string;
}

interface ExchangeContext {
  baseUrl: string;
  userAgent?: string;
}

const FEDERATION_EXCHANGES: Record<
  FederationExchangeConfig['type'],
  {
    /** Providers whose APIs accept tokens minted by this exchange. */
    providers: readonly ReviewConfig['provider'][];
    defaultAudience: string;
  }
> = {
  anthropic: { providers: ['anthropic'], defaultAudience: 'https://api.anthropic.com' },
};

function tokenExchangeFor(config: FederationExchangeConfig, context: ExchangeContext): TokenExchange {
  switch (config.type) {
    case 'anthropic':
      return anthropicTokenExchange(config, context);
  }
}

/** Builds request auth for `provider`, rejecting exchanges that provider cannot accept. */
export function createFederatedAuth(
  provider: ReviewConfig['provider'],
  federation: FederationConfig,
  context: ExchangeContext,
): RequestAuth {
  const definition = FEDERATION_EXCHANGES[federation.exchange.type];
  if (!definition.providers.includes(provider)) {
    throw new ConfigError(
      `"${federation.exchange.type}" federation requires provider ${definition.providers
        .map((p) => `"${p}"`)
        .join(' or ')} (got "${provider}").`,
    );
  }
  const audience = federation.audience ?? definition.defaultAudience;
  return federatedAuth(
    () => federation.getIdentityToken(audience),
    tokenExchangeFor(federation.exchange, context),
  );
}

interface OAuthTokenResponse {
  access_token?: string;
  expires_in?: number;
}

function anthropicTokenExchange(
  config: AnthropicFederationExchange,
  { baseUrl, userAgent }: ExchangeContext,
): TokenExchange {
  const tokenUrl = `${baseUrl.replace(/\/+$/, '')}/oauth/token`;

  return async (assertion) => {
    const res = await fetch(tokenUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'User-Agent': userAgent ?? DEFAULT_USER_AGENT,
      },
      body: JSON.stringify({
        grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
        assertion,
        federation_rule_id: config.federationRuleId,
        organization_id: config.organizationId,
        service_account_id: config.serviceAccountId,
        ...(config.workspaceId && { workspace_id: config.workspaceId }),
      }),
    });

    if (!res.ok) {
      const errorBody = await res.text().catch(() => '');
      const snippet = errorSnippet(errorBody);
      logger.warn(
        { status: res.status, federationRuleId: config.federationRuleId, body: snippet },
        'Anthropic federation token exchange rejected',
      );
      throw new LLMApiError(
        `Anthropic federation token exchange failed: ${res.status} ${res.statusText}` +
          `${snippet ? ` — ${snippet}` : ''}. ` +
          'The deny reason is listed in Claude Console → Settings → Workload identity → Authentication history.',
        res.status,
        errorBody,
      );
    }

    const data = (await res.json()) as OAuthTokenResponse;
    if (!data.access_token || typeof data.expires_in !== 'number') {
      throw new LLMApiError(
        'Anthropic federation token exchange returned no access_token/expires_in',
        502,
      );
    }
    logger.info(
      { federationRuleId: config.federationRuleId, expiresIn: data.expires_in },
      'Anthropic federation token exchanged',
    );
    return { accessToken: data.access_token, expiresInSeconds: data.expires_in };
  };
}

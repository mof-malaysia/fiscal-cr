import { errorSnippet, LLMApiError } from '../utils/errors.js';
import { logger } from '../utils/logger.js';

/** Supplies request auth headers for the Anthropic Messages API. */
export interface AnthropicAuth {
  headers(): Promise<Record<string, string>>;
  /**
   * Drop any cached credential so the next headers() call re-authenticates.
   * Present only for refreshable credentials; a 401 is retried once when set.
   */
  invalidate?(): void;
}

export function apiKeyAuth(apiKey: string): AnthropicAuth {
  return {
    headers: async () => ({ 'X-Api-Key': apiKey }),
  };
}

export interface AnthropicFederationConfig {
  federationRuleId: string;
  organizationId: string;
  serviceAccountId: string;
  /** Required only when the federation rule spans multiple workspaces. */
  workspaceId?: string;
  /**
   * Returns a fresh IdP-issued JWT. Called once per exchange: assertions with a
   * `jti` claim (e.g. GitHub Actions OIDC tokens) are single-use.
   */
  getIdentityToken: () => Promise<string>;
}

interface TokenResponse {
  access_token?: string;
  expires_in?: number;
}

/** Refresh this long before the minted token expires. */
const REFRESH_MARGIN_MS = 120_000;

/**
 * Workload Identity Federation: exchanges an IdP JWT at `{baseUrl}/oauth/token`
 * (RFC 7523 jwt-bearer) for a short-lived Anthropic access token, caches it,
 * and refreshes it before expiry. Concurrent callers share one exchange.
 */
export function federationAuth(
  config: AnthropicFederationConfig & { baseUrl: string; userAgent?: string },
): AnthropicAuth {
  const tokenUrl = `${config.baseUrl.replace(/\/+$/, '')}/oauth/token`;
  let cached: { token: string; expiresAt: number } | undefined;
  let inFlight: Promise<string> | undefined;

  async function exchange(): Promise<string> {
    const assertion = await config.getIdentityToken();
    const res = await fetch(tokenUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'User-Agent': config.userAgent ?? 'fiscalcr/1.0',
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

    const data = (await res.json()) as TokenResponse;
    if (!data.access_token || typeof data.expires_in !== 'number') {
      throw new LLMApiError(
        'Anthropic federation token exchange returned no access_token/expires_in',
        502,
      );
    }
    cached = { token: data.access_token, expiresAt: Date.now() + data.expires_in * 1_000 };
    logger.info(
      { federationRuleId: config.federationRuleId, expiresIn: data.expires_in },
      'Anthropic federation token exchanged',
    );
    return data.access_token;
  }

  async function token(): Promise<string> {
    if (cached && Date.now() < cached.expiresAt - REFRESH_MARGIN_MS) return cached.token;
    inFlight ??= exchange().finally(() => {
      inFlight = undefined;
    });
    return inFlight;
  }

  return {
    headers: async () => ({ Authorization: `Bearer ${await token()}` }),
    invalidate: () => {
      cached = undefined;
    },
  };
}

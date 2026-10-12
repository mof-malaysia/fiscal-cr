/** Supplies auth headers for LLM provider requests. */
export interface RequestAuth {
  headers(): Promise<Record<string, string>>;
  /**
   * Drop any cached credential so the next headers() call re-authenticates.
   * Present only for refreshable credentials; a 401 is retried once when set.
   */
  invalidate?(): void;
}

/** Fixed headers, e.g. a static API key. */
export function staticAuth(headers: Record<string, string>): RequestAuth {
  return { headers: async () => headers };
}

/** `Authorization: Bearer <token>`, the OpenAI-compatible API key scheme. */
export function bearerAuth(token: string): RequestAuth {
  return staticAuth({ Authorization: `Bearer ${token}` });
}

/**
 * Returns a fresh IdP-issued identity token (JWT). Called once per exchange:
 * assertions with a `jti` claim (e.g. GitHub Actions OIDC tokens) are single-use.
 */
export type IdentityTokenSource = () => Promise<string>;

/** Trades an identity token for a provider access token. */
export type TokenExchange = (
  identityToken: string,
) => Promise<{ accessToken: string; expiresInSeconds: number }>;

/** Refresh this long before the exchanged token expires. */
const REFRESH_MARGIN_MS = 120_000;

/**
 * Provider-agnostic workload identity federation: mints a fresh identity token,
 * exchanges it for a short-lived access token, caches it, and refreshes it
 * before expiry. Concurrent callers share one exchange.
 */
export function federatedAuth(
  getIdentityToken: IdentityTokenSource,
  exchange: TokenExchange,
): RequestAuth {
  let cached: { token: string; expiresAt: number } | undefined;
  let inFlight: Promise<string> | undefined;

  async function refresh(): Promise<string> {
    const { accessToken, expiresInSeconds } = await exchange(await getIdentityToken());
    cached = { token: accessToken, expiresAt: Date.now() + expiresInSeconds * 1_000 };
    return accessToken;
  }

  async function token(): Promise<string> {
    if (cached && Date.now() < cached.expiresAt - REFRESH_MARGIN_MS) return cached.token;
    inFlight ??= refresh().finally(() => {
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

/**
 * Sends a request with auth headers. A refreshable credential can be rejected
 * early (clock skew, revocation), so a 401 re-authenticates once before the
 * response is returned.
 */
export async function fetchWithAuth(
  auth: RequestAuth,
  send: (authHeaders: Record<string, string>) => Promise<Response>,
): Promise<Response> {
  const res = await send(await auth.headers());
  if (res.status !== 401 || !auth.invalidate) return res;
  await res.body?.cancel();
  auth.invalidate();
  return send(await auth.headers());
}

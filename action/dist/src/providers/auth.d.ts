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
export declare function staticAuth(headers: Record<string, string>): RequestAuth;
/** `Authorization: Bearer <token>`, the OpenAI-compatible API key scheme. */
export declare function bearerAuth(token: string): RequestAuth;
/**
 * Returns a fresh IdP-issued identity token (JWT). Called once per exchange:
 * assertions with a `jti` claim (e.g. GitHub Actions OIDC tokens) are single-use.
 */
export type IdentityTokenSource = () => Promise<string>;
/** Trades an identity token for a provider access token. */
export type TokenExchange = (identityToken: string) => Promise<{
    accessToken: string;
    expiresInSeconds: number;
}>;
/**
 * Provider-agnostic workload identity federation: mints a fresh identity token,
 * exchanges it for a short-lived access token, caches it, and refreshes it
 * before expiry. Concurrent callers share one exchange.
 */
export declare function federatedAuth(getIdentityToken: IdentityTokenSource, exchange: TokenExchange): RequestAuth;
/**
 * Sends a request with auth headers. A refreshable credential can be rejected
 * early (clock skew, revocation), so a 401 re-authenticates once before the
 * response is returned.
 */
export declare function fetchWithAuth(auth: RequestAuth, send: (authHeaders: Record<string, string>) => Promise<Response>): Promise<Response>;
//# sourceMappingURL=auth.d.ts.map
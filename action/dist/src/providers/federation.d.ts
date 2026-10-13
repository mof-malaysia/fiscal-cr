import type { ReviewConfig } from '../config/schema.js';
import { type RequestAuth } from './auth.js';
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
/** Builds request auth for `provider`, rejecting exchanges that provider cannot accept. */
export declare function createFederatedAuth(provider: ReviewConfig['provider'], federation: FederationConfig, context: ExchangeContext): RequestAuth;
export {};
//# sourceMappingURL=federation.d.ts.map
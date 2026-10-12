import type { FederationConfig } from "../src/providers/federation.js";
interface ActionFederationCore {
    getInput(name: string): string;
    getIDToken(audience?: string): Promise<string>;
}
/**
 * Parse workload identity federation inputs. Returns `undefined` when none
 * are set (API-key mode). The identity token comes from the GitHub Actions
 * OIDC endpoint; the exchange is chosen by which provider's inputs are set.
 */
export declare function federationFromActionInput(core: ActionFederationCore): FederationConfig | undefined;
export {};
//# sourceMappingURL=federation.d.ts.map
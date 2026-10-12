import type { Octokit } from '@octokit/rest';
import type { Webhooks } from '@octokit/webhooks';
interface AppContext {
    apiKey: string;
    provider?: string;
    model?: string;
    baseUrl?: string;
    userAgent?: string;
    getInstallationOctokit: (installationId: number) => Promise<Octokit>;
}
/** Register App-mode review, command, and review-thread lifecycle handlers. */
export declare function registerWebhooks(webhooks: Webhooks, appCtx: AppContext): void;
/** Apply one thread lifecycle delivery while serializing updates per pull request. */
export declare function handleFiscalcrThreadEvent(octokit: Octokit, input: {
    owner: string;
    repo: string;
    pullNumber: number;
    headSha: string;
    threadId?: string | number;
    action: 'resolved' | 'unresolved';
    eventId?: string;
}): Promise<void>;
export {};
//# sourceMappingURL=webhooks.d.ts.map
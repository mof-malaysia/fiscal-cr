import { App } from '@octokit/app';
export interface AppConfig {
    githubAppId: string;
    githubPrivateKey: string;
    githubWebhookSecret: string;
    apiKey: string;
    provider?: string;
    model?: string;
    baseUrl?: string;
    userAgent?: string;
}
export declare function createApp(config: AppConfig): App;
//# sourceMappingURL=app.d.ts.map
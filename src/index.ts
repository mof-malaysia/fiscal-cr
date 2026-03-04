import { Hono } from 'hono';
import { serve } from '@hono/node-server';
import { createApp } from './app.js';
import { logger } from './utils/logger.js';

const PORT = parseInt(process.env.PORT ?? '3000', 10);

const server = new Hono();

// Health check
server.get('/health', (c) => {
  return c.json({ status: 'ok', version: '0.1.0' });
});

// GitHub webhook endpoint
server.post('/api/webhook', async (c) => {
  const app = createApp({
    githubAppId: process.env.GITHUB_APP_ID!,
    githubPrivateKey: process.env.GITHUB_PRIVATE_KEY!,
    githubWebhookSecret: process.env.GITHUB_WEBHOOK_SECRET!,
    kimiApiKey: process.env.KIMI_API_KEY!,
    kimiModel: process.env.KIMI_MODEL,
    kimiBaseUrl: process.env.KIMI_BASE_URL,
  });

  const id = c.req.header('x-github-delivery') ?? '';
  const name = c.req.header('x-github-event') ?? '';
  const signature = c.req.header('x-hub-signature-256') ?? '';
  const payload = await c.req.text();

  try {
    await app.webhooks.verifyAndReceive({
      id,
      name: name as any,
      signature,
      payload,
    });
    return c.json({ ok: true });
  } catch (err) {
    logger.error({ err }, 'Webhook processing failed');
    return c.json({ error: 'Webhook processing failed' }, 500);
  }
});

// Start server
serve({ fetch: server.fetch, port: PORT }, () => {
  logger.info({ port: PORT }, 'Kimi Code Reviewer server started');
});

export { server };

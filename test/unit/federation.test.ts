import { afterEach, describe, expect, it, vi } from 'vitest';
import { createFederatedAuth, type FederationConfig } from '../../src/providers/federation.js';
import { ConfigError, LLMApiError } from '../../src/utils/errors.js';

const federation: FederationConfig = {
  exchange: {
    type: 'anthropic',
    federationRuleId: 'fdrl_1',
    organizationId: 'org-uuid',
    serviceAccountId: 'svac_1',
    workspaceId: 'wrkspc_1',
  },
  getIdentityToken: vi.fn(async () => 'jwt-1'),
};
const context = { baseUrl: 'https://api.anthropic.com/v1/' };

describe('workload identity federation', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.mocked(federation.getIdentityToken).mockClear();
  });

  it('mints the identity token for the exchange default audience unless overridden', async () => {
    vi.spyOn(globalThis, 'fetch').mockImplementation(
      async () =>
        new Response(JSON.stringify({ access_token: 'tok', expires_in: 600 }), { status: 200 }),
    );

    await createFederatedAuth('anthropic', federation, context).headers();
    await createFederatedAuth('anthropic', { ...federation, audience: 'custom' }, context).headers();

    expect(vi.mocked(federation.getIdentityToken).mock.calls).toEqual([
      ['https://api.anthropic.com'],
      ['custom'],
    ]);
  });

  it('rejects an exchange the provider cannot accept', () => {
    expect(() => createFederatedAuth('openai', federation, context)).toThrowError(ConfigError);
  });

  it('exchanges with the Anthropic jwt-bearer grant', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
      new Response(JSON.stringify({ access_token: 'sk-ant-oat01-a', expires_in: 600 }), {
        status: 200,
      }),
    );

    const auth = createFederatedAuth('anthropic', federation, context);

    expect(await auth.headers()).toEqual({ Authorization: 'Bearer sk-ant-oat01-a' });
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe('https://api.anthropic.com/v1/oauth/token');
    expect(JSON.parse(String(init?.body))).toEqual({
      grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
      assertion: 'jwt-1',
      federation_rule_id: 'fdrl_1',
      organization_id: 'org-uuid',
      service_account_id: 'svac_1',
      workspace_id: 'wrkspc_1',
    });
  });

  it('raises LLMApiError pointing at the authentication history on denial', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
      new Response('{"error":{"type":"authentication_error"}}', {
        status: 401,
        statusText: 'Unauthorized',
      }),
    );

    const err = await createFederatedAuth('anthropic', federation, context)
      .headers()
      .catch((e: unknown) => e);

    expect(err).toBeInstanceOf(LLMApiError);
    expect((err as LLMApiError).statusCode).toBe(401);
    expect((err as LLMApiError).message).toMatch(/Authentication history/);
  });
});

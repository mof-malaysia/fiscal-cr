import { afterEach, describe, expect, it, vi } from 'vitest';
import { apiKeyAuth, federationAuth } from '../../src/providers/anthropic-auth.js';
import { LLMApiError } from '../../src/utils/errors.js';

const tokenResponse = (accessToken: string, expiresIn = 600) =>
  new Response(JSON.stringify({ access_token: accessToken, token_type: 'Bearer', expires_in: expiresIn }), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  });

function makeAuth(getIdentityToken = vi.fn(async () => 'jwt-1')) {
  return {
    getIdentityToken,
    auth: federationAuth({
      baseUrl: 'https://api.anthropic.com/v1/',
      federationRuleId: 'fdrl_1',
      organizationId: 'org-uuid',
      serviceAccountId: 'svac_1',
      workspaceId: 'wrkspc_1',
      getIdentityToken,
    }),
  };
}

describe('anthropic auth', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  it('sends the static key as X-Api-Key', async () => {
    const auth = apiKeyAuth('sk-test');
    expect(await auth.headers()).toEqual({ 'X-Api-Key': 'sk-test' });
    expect(auth.invalidate).toBeUndefined();
  });

  it('exchanges the identity token with the jwt-bearer grant', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(tokenResponse('sk-ant-oat01-a'));
    const { auth } = makeAuth();

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

  it('caches the token and refreshes it with a fresh identity token near expiry', async () => {
    vi.useFakeTimers();
    const fetchMock = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(tokenResponse('tok-1', 600))
      .mockResolvedValueOnce(tokenResponse('tok-2', 600));
    let n = 0;
    const { auth, getIdentityToken } = makeAuth(vi.fn(async () => `jwt-${++n}`));

    await auth.headers();
    vi.advanceTimersByTime(400_000);
    expect(await auth.headers()).toEqual({ Authorization: 'Bearer tok-1' });
    expect(fetchMock).toHaveBeenCalledTimes(1);

    vi.advanceTimersByTime(81_000); // inside the 120s refresh margin
    expect(await auth.headers()).toEqual({ Authorization: 'Bearer tok-2' });
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(getIdentityToken).toHaveBeenCalledTimes(2);
    expect(JSON.parse(String(fetchMock.mock.calls[1]?.[1]?.body)).assertion).toBe('jwt-2');
  });

  it('shares one exchange across concurrent callers', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(tokenResponse('tok'));
    const { auth } = makeAuth();

    const results = await Promise.all([auth.headers(), auth.headers(), auth.headers()]);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(new Set(results.map((h) => h.Authorization))).toEqual(new Set(['Bearer tok']));
  });

  it('re-exchanges after invalidate()', async () => {
    const fetchMock = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(tokenResponse('tok-1'))
      .mockResolvedValueOnce(tokenResponse('tok-2'));
    const { auth } = makeAuth();

    await auth.headers();
    auth.invalidate();

    expect(await auth.headers()).toEqual({ Authorization: 'Bearer tok-2' });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('raises LLMApiError on a rejected exchange and retries on the next call', async () => {
    vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({ type: 'error', error: { type: 'authentication_error', message: 'Authentication failed' } }),
          { status: 401, statusText: 'Unauthorized' },
        ),
      )
      .mockResolvedValueOnce(tokenResponse('tok'));
    const { auth } = makeAuth();

    const err = await auth.headers().catch((e: unknown) => e);
    expect(err).toBeInstanceOf(LLMApiError);
    expect((err as LLMApiError).statusCode).toBe(401);
    expect((err as LLMApiError).message).toMatch(/Authentication history/);

    expect(await auth.headers()).toEqual({ Authorization: 'Bearer tok' });
  });
});

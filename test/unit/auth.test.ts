import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  bearerAuth,
  federatedAuth,
  fetchWithAuth,
  staticAuth,
  type RequestAuth,
  type TokenExchange,
} from '../../src/providers/auth.js';

describe('request auth', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('sends static credentials without a refresh hook', async () => {
    expect(await staticAuth({ 'X-Api-Key': 'k' }).headers()).toEqual({ 'X-Api-Key': 'k' });
    const bearer = bearerAuth('k');
    expect(await bearer.headers()).toEqual({ Authorization: 'Bearer k' });
    expect(bearer.invalidate).toBeUndefined();
  });

  describe('federatedAuth', () => {
    function setup(expiresInSeconds = 600) {
      let n = 0;
      const getIdentityToken = vi.fn(async () => `jwt-${++n}`);
      const exchange = vi.fn<TokenExchange>(async (jwt) => ({
        accessToken: `tok-for-${jwt}`,
        expiresInSeconds,
      }));
      return { getIdentityToken, exchange, auth: federatedAuth(getIdentityToken, exchange) };
    }

    it('exchanges a fresh identity token and sends a bearer token', async () => {
      const { auth, exchange } = setup();

      expect(await auth.headers()).toEqual({ Authorization: 'Bearer tok-for-jwt-1' });
      expect(exchange).toHaveBeenCalledWith('jwt-1');
    });

    it('caches until the refresh margin, then re-exchanges with a new identity token', async () => {
      vi.useFakeTimers();
      const { auth, exchange, getIdentityToken } = setup(600);

      await auth.headers();
      vi.advanceTimersByTime(400_000);
      expect(await auth.headers()).toEqual({ Authorization: 'Bearer tok-for-jwt-1' });
      expect(exchange).toHaveBeenCalledTimes(1);

      vi.advanceTimersByTime(81_000); // inside the 120s refresh margin
      expect(await auth.headers()).toEqual({ Authorization: 'Bearer tok-for-jwt-2' });
      expect(getIdentityToken).toHaveBeenCalledTimes(2);
    });

    it('shares one exchange across concurrent callers', async () => {
      const { auth, exchange } = setup();

      await Promise.all([auth.headers(), auth.headers(), auth.headers()]);

      expect(exchange).toHaveBeenCalledTimes(1);
    });

    it('re-exchanges after invalidate() and after a failed exchange', async () => {
      const { auth, exchange } = setup();
      exchange.mockRejectedValueOnce(new Error('denied'));

      await expect(auth.headers()).rejects.toThrow('denied');
      expect(await auth.headers()).toEqual({ Authorization: 'Bearer tok-for-jwt-2' });
      auth.invalidate!();
      expect(await auth.headers()).toEqual({ Authorization: 'Bearer tok-for-jwt-3' });
      expect(exchange).toHaveBeenCalledTimes(3);
    });
  });

  describe('fetchWithAuth', () => {
    const ok = () => new Response('{}', { status: 200 });
    const unauthorized = () => new Response('{}', { status: 401 });

    it('re-authenticates once on 401 for refreshable credentials', async () => {
      let n = 0;
      const auth: RequestAuth = {
        headers: async () => ({ Authorization: `Bearer ${++n}` }),
        invalidate: vi.fn(),
      };
      const send = vi.fn().mockResolvedValueOnce(unauthorized()).mockResolvedValueOnce(ok());

      const res = await fetchWithAuth(auth, send);

      expect(res.status).toBe(200);
      expect(auth.invalidate).toHaveBeenCalledTimes(1);
      expect(send.mock.calls.map((c) => c[0])).toEqual([
        { Authorization: 'Bearer 1' },
        { Authorization: 'Bearer 2' },
      ]);
    });

    it('returns a 401 as-is for static credentials', async () => {
      const send = vi.fn().mockResolvedValue(unauthorized());

      const res = await fetchWithAuth(bearerAuth('k'), send);

      expect(res.status).toBe(401);
      expect(send).toHaveBeenCalledTimes(1);
    });
  });
});

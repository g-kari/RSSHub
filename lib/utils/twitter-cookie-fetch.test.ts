import { CookieJar } from 'tough-cookie';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { config } from '@/config';
import cache from '@/utils/cache';
import logger from '@/utils/logger';

import { getClientTransactionId } from '../routes/twitter/api/web-api/client-transaction-id';
import { twitterGot } from '../routes/twitter/api/web-api/utils.worker';
import { createTwitterCookieJar, fetchTwitterWithCookies } from './twitter-cookie-fetch';

describe('Worker Twitter cookie transport', () => {
    it('sends jar cookies without an undici dispatcher and absorbs separate Set-Cookie values', async () => {
        const jar = new CookieJar();
        jar.setCookieSync('auth_token=dummy; Secure; Path=/', 'https://x.com');
        const response = new Response('ok', {
            headers: [
                ['set-cookie', 'ct0=csrf; Secure; Path=/'],
                ['set-cookie', 'guest_id=guest; Expires=Wed, 01 Jan 2031 00:00:00 GMT; Secure; Path=/'],
            ],
        });
        const fetcher = vi.fn<typeof fetch>().mockResolvedValue(response);
        expect(await fetchTwitterWithCookies('https://x.com/i/api/graphql/example', jar, { authorization: 'dummy-bearer' }, fetcher)).toBe(response);
        const [, init] = fetcher.mock.calls[0];
        expect(init?.redirect).toBe('manual');
        expect(new Request(fetcher.mock.calls[0][0], init).headers.get('cookie')).toBe('auth_token=dummy');
        expect(new Headers(init?.headers).get('authorization')).toBe('dummy-bearer');
        expect(init).not.toHaveProperty('dispatcher');
        expect(jar.getCookieStringSync('https://x.com')).toContain('ct0=csrf');
        expect(jar.getCookieStringSync('https://x.com')).toContain('guest_id=guest');
    });

    it('absorbs intermediate cookies and rebuilds the Cookie header for same-origin redirects', async () => {
        const jar = new CookieJar();
        const fetcher = vi
            .fn<typeof fetch>()
            .mockResolvedValueOnce(new Response('', { status: 302, headers: { location: '/home', 'set-cookie': 'ct0=csrf; Secure; Path=/' } }))
            .mockResolvedValueOnce(new Response('ok'));
        await fetchTwitterWithCookies('https://x.com', jar, undefined, fetcher);
        expect(fetcher).toHaveBeenCalledTimes(2);
        expect(fetcher.mock.calls[1][0]).toBe('https://x.com/home');
        expect(new Headers(fetcher.mock.calls[1][1]?.headers).get('cookie')).toBe('ct0=csrf');
    });

    it.each(['https://attacker.example/', 'http://x.com/', 'https://x.com.attacker.example/', 'https://user:password@x.com/'])('rejects unsafe redirect %s before sending credentials', async (location) => {
        const jar = new CookieJar();
        jar.setCookieSync('auth_token=dummy; Secure; Path=/', 'https://x.com');
        const fetcher = vi.fn<typeof fetch>().mockResolvedValue(new Response('', { status: 302, headers: { location } }));
        await expect(fetchTwitterWithCookies('https://x.com', jar, { authorization: 'dummy' }, fetcher)).rejects.toThrow('must stay');
        expect(fetcher).toHaveBeenCalledOnce();
    });

    it('bounds same-origin redirect loops', async () => {
        const fetcher = vi.fn<typeof fetch>().mockImplementation(() => Promise.resolve(new Response('', { status: 302, headers: { location: '/' } })));
        await expect(fetchTwitterWithCookies('https://x.com', new CookieJar(), undefined, fetcher)).rejects.toThrow('five redirects');
        expect(fetcher).toHaveBeenCalledTimes(6);
    });

    it('rejects an unsafe initial destination before making any request', async () => {
        const fetcher = vi.fn<typeof fetch>();
        await expect(fetchTwitterWithCookies('https://attacker.example/', new CookieJar(), undefined, fetcher)).rejects.toThrow('must stay');
        expect(fetcher).not.toHaveBeenCalled();
    });

    it('returns an HTTP error response without retries and propagates network failures', async () => {
        const fetcher = vi
            .fn<typeof fetch>()
            .mockResolvedValueOnce(new Response('rate limited', { status: 429 }))
            .mockRejectedValueOnce(new Error('offline'));
        expect((await fetchTwitterWithCookies('https://x.com', new CookieJar(), undefined, fetcher)).status).toBe(429);
        await expect(fetchTwitterWithCookies('https://x.com', new CookieJar(), undefined, fetcher)).rejects.toThrow('offline');
        expect(fetcher).toHaveBeenCalledTimes(2);
    });
});

describe('Twitter cookie bootstrap', () => {
    it.each([401, 403, 429, 500])('does not return cacheable cookies after HTTP %s', async (status) => {
        const fetcher = vi.fn<typeof fetch>().mockResolvedValue(new Response('', { status }));
        await expect(createTwitterCookieJar('dummy-token', fetcher)).rejects.toThrow(`bootstrap failed: ${status}`);
        expect(fetcher).toHaveBeenCalledOnce();
    });

    it('supports the guest token without adding an undefined auth cookie', async () => {
        const fetcher = vi.fn<typeof fetch>().mockResolvedValue(new Response('document.cookie="gt=12345";'));
        const jar = await createTwitterCookieJar(undefined, fetcher);
        expect(new Headers(fetcher.mock.calls[0][1]?.headers).get('cookie')).toBeNull();
        expect(jar.getCookieStringSync('https://x.com')).toBe('gt=12345');
    });
});

const mocks = vi.hoisted(() => ({
    values: new Map<string, string>(),
    get: vi.fn(),
    set: vi.fn(),
    debug: vi.fn(),
    transactionId: vi.fn(),
}));
vi.mock('@/config', () => ({ config: { twitter: { authToken: ['dummy-token'] as string[] }, cache: { contentExpire: 300 } } }));
vi.mock('@/utils/cache', () => ({ default: { get: mocks.get, set: mocks.set } }));
vi.mock('@/utils/logger', () => ({ default: { debug: mocks.debug } }));
vi.mock('@/utils/ofetch', () => ({ default: vi.fn() }));
vi.mock('../routes/twitter/api/web-api/client-transaction-id', () => ({ getClientTransactionId: mocks.transactionId }));

const endpoint = 'https://x.com/i/api/graphql/synthetic/UserTweetsAndReplies';

beforeEach(() => {
    vi.clearAllMocks();
    mocks.values.clear();
    mocks.get.mockImplementation((key: string) => Promise.resolve(mocks.values.get(key) || ''));
    mocks.set.mockImplementation((key: string, value: string) => {
        mocks.values.set(key, value);
        return Promise.resolve();
    });
    mocks.transactionId.mockResolvedValue('synthetic-transaction');
    config.twitter.authToken = ['dummy-token'];
});
afterEach(() => {
    vi.unstubAllGlobals();
});

function cacheCookie() {
    const jar = new CookieJar();
    jar.setCookieSync('auth_token=dummy-token; Secure; Path=/', 'https://x.com');
    jar.setCookieSync('ct0=dummy-csrf; Secure; Path=/', 'https://x.com');
    mocks.values.set('twitter:cookie:dummy-token', JSON.stringify(jar.serializeSync()));
}

describe('Worker Twitter API transport integration with synthetic responses', () => {
    it('bootstraps cookies, sends CSRF and transaction headers, and caches the updated jar', async () => {
        const fetcher = vi
            .fn<typeof fetch>()
            .mockResolvedValueOnce(new Response('', { headers: { 'set-cookie': 'ct0=dummy-csrf; Secure; Path=/' } }))
            .mockResolvedValueOnce(Response.json({ data: { ok: true } }));
        vi.stubGlobal('fetch', fetcher);
        expect(await twitterGot(endpoint, { variables: '{}' })).toEqual({ data: { ok: true } });
        expect(fetcher).toHaveBeenCalledTimes(2);
        const headers = new Request(fetcher.mock.calls[1][0], fetcher.mock.calls[1][1]).headers;
        expect(headers.get('cookie')).toContain('auth_token=dummy-token');
        expect(headers.get('cookie')).toContain('ct0=dummy-csrf');
        expect(headers.get('x-csrf-token')).toBe('dummy-csrf');
        expect(headers.get('x-client-transaction-id')).toBe('synthetic-transaction');
        expect(getClientTransactionId).toHaveBeenCalledWith('GET', new URL(endpoint).pathname);
        expect(await cache.get('twitter:cookie:dummy-token')).toContain('dummy-csrf');
        expect(cache.set).toHaveBeenLastCalledWith('twitter:cookie:dummy-token', expect.any(String), 300);
        expect(JSON.stringify(vi.mocked(logger.debug).mock.calls)).not.toMatch(/dummy-token|dummy-csrf/);
    });

    it('does not cache failed cookie bootstrap responses', async () => {
        const fetcher = vi.fn<typeof fetch>().mockResolvedValue(new Response('', { status: 401 }));
        vi.stubGlobal('fetch', fetcher);
        await expect(twitterGot(endpoint, {})).rejects.toThrow('authentication cookie');
        expect(fetcher).toHaveBeenCalledOnce();
        expect(mocks.values.has('twitter:cookie:dummy-token')).toBe(false);
        expect(JSON.stringify(mocks.debug.mock.calls)).not.toContain('dummy-token');
    });

    it.each([401, 403])('removes invalid authentication after API HTTP %s without attempting login', async (status) => {
        cacheCookie();
        const fetcher = vi.fn<typeof fetch>().mockResolvedValue(Response.json({}, { status }));
        vi.stubGlobal('fetch', fetcher);
        await expect(twitterGot(endpoint, {})).rejects.toThrow(`Twitter API error: ${status}`);
        expect(config.twitter.authToken).toEqual([]);
        expect(cache.set).toHaveBeenLastCalledWith('twitter:lock-token1:dummy-token', '1', 3600);
        expect(fetcher).toHaveBeenCalledOnce();
        expect(JSON.stringify(mocks.debug.mock.calls)).not.toMatch(/dummy-token|dummy-csrf/);
    });

    it('locks a rate-limited token without removing it or attempting another request', async () => {
        cacheCookie();
        const fetcher = vi.fn<typeof fetch>().mockResolvedValue(Response.json({}, { status: 429 }));
        vi.stubGlobal('fetch', fetcher);
        await expect(twitterGot(endpoint, {})).rejects.toThrow('Twitter API error: 429');
        expect(config.twitter.authToken).toEqual(['dummy-token']);
        expect(cache.set).toHaveBeenLastCalledWith('twitter:lock-token1:dummy-token', '1', 2000);
        expect(fetcher).toHaveBeenCalledOnce();
    });

    it('rejects missing required authentication before any network request', async () => {
        config.twitter.authToken = [];
        const fetcher = vi.fn<typeof fetch>();
        vi.stubGlobal('fetch', fetcher);
        await expect(twitterGot(endpoint, {})).rejects.toThrow('No valid Twitter token');
        expect(fetcher).not.toHaveBeenCalled();
    });

    it('retains explicit guest mode without transmitting an undefined auth token', async () => {
        config.twitter.authToken = [];
        const fetcher = vi
            .fn<typeof fetch>()
            .mockResolvedValueOnce(new Response('document.cookie="gt=12345";'))
            .mockResolvedValueOnce(Response.json({ data: {} }));
        vi.stubGlobal('fetch', fetcher);
        await twitterGot(endpoint, {}, { allowNoAuth: true });
        const headers = new Request(fetcher.mock.calls[1][0], fetcher.mock.calls[1][1]).headers;
        expect(headers.get('cookie')).toBe('gt=12345');
        expect(headers.get('x-guest-token')).toBe('12345');
        expect(headers.get('x-twitter-auth-type')).toBeNull();
    });
});

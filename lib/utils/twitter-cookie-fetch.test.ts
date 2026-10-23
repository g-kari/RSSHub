import { CookieJar } from 'tough-cookie';
import { describe, expect, it, vi } from 'vitest';

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

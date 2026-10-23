import { CookieJar } from 'tough-cookie';

const twitterOrigin = 'https://x.com';
const redirectStatuses = new Set([301, 302, 303, 307, 308]);

// Workers allow Cookie headers, but also forward them across redirects unless handled manually.
export async function fetchTwitterWithCookies(url: string, jar: CookieJar, headers?: HeadersInit, fetcher: typeof fetch = globalThis.fetch): Promise<Response> {
    let target = new URL(url);
    for (let redirects = 0; redirects <= 5; redirects++) {
        if (target.origin !== twitterOrigin || target.username || target.password) {
            throw new Error('Twitter requests and redirects must stay on https://x.com.');
        }
        const requestHeaders = new Headers(headers);
        requestHeaders.delete('cookie');
        const cookie = jar.getCookieStringSync(target.href);
        if (cookie) {
            requestHeaders.set('cookie', cookie);
        }
        const response = await fetcher(target.href, { headers: requestHeaders, redirect: 'manual' });
        for (const raw of response.headers.getSetCookie()) {
            try {
                jar.setCookieSync(raw, target.href);
            } catch {
                // Ignore malformed Set-Cookie headers, not other cookies in the response.
            }
        }
        if (!redirectStatuses.has(response.status)) {
            return response;
        }
        const location = response.headers.get('location');
        await response.body?.cancel();
        if (!location) {
            throw new Error('Twitter returned a redirect without a location.');
        }
        target = new URL(location, target);
    }
    throw new Error('Twitter request exceeded five redirects.');
}

export async function createTwitterCookieJar(token?: string, fetcher: typeof fetch = globalThis.fetch): Promise<CookieJar> {
    const jar = new CookieJar();
    if (token) {
        jar.setCookieSync(`auth_token=${token}`, twitterOrigin);
    }
    const response = await fetchTwitterWithCookies(token ? twitterOrigin : `${twitterOrigin}/narendramodi?mx=2`, jar, undefined, fetcher);
    if (!response.ok) {
        await response.body?.cancel();
        throw new Error(`Twitter cookie bootstrap failed: ${response.status}`);
    }
    if (token) {
        await response.body?.cancel();
    } else {
        const data = await response.text();
        const guestToken = data.match(/document\.cookie="gt=(\d+)/)?.[1];
        if (guestToken) {
            jar.setCookieSync(`gt=${guestToken}; Secure; Path=/`, twitterOrigin);
        }
    }
    return jar;
}

// Worker-compatible version of twitter/api/web-api/utils.ts
// Cloudflare Workers cannot use undici's CookieAgent/ProxyAgent (raw TCP).
// This variant relies solely on globalThis.fetch and manually builds the
// Cookie header from the tough-cookie jar.

import queryString from 'query-string';
import { Cookie, CookieJar } from 'tough-cookie';

import { config } from '@/config';
import ConfigNotFoundError from '@/errors/types/config-not-found';
import cache from '@/utils/cache';
import logger from '@/utils/logger';
import ofetch from '@/utils/ofetch';

import { baseUrl, bearerToken, gqlFeatures, gqlMap, thirdPartySupportedAPI } from './constants';
import login from './login';

let authTokenIndex = 0;

const absorbSetCookies = (jar: CookieJar, response: Response, requestUrl: string) => {
    // Response.headers.getSetCookie() returns each Set-Cookie header separately
    // (merged values would break cookie parsing). Fall back to split on 'set-cookie' if unavailable.
    const setCookies = typeof (response.headers as any).getSetCookie === 'function' ? (response.headers as any).getSetCookie() : [];
    for (const raw of setCookies) {
        try {
            jar.setCookieSync(raw, requestUrl);
        } catch {
            // ignore malformed Set-Cookie entries
        }
    }
};

const token2Cookie = async (token: string | undefined) => {
    const c = await cache.get(`twitter:cookie:${token}`);
    if (c) {
        return c;
    }
    const jar = new CookieJar();
    if (token) {
        await jar.setCookie(`auth_token=${token}`, 'https://x.com');
    }
    try {
        if (token) {
            // Worker flow: fetch x.com with auth_token, then absorb Set-Cookie into the jar
            // so ct0/guest_id/etc. are captured without a CookieAgent dispatcher.
            const response = await globalThis.fetch('https://x.com', {
                headers: { cookie: jar.getCookieStringSync('https://x.com') },
                redirect: 'follow',
            });
            absorbSetCookies(jar, response, 'https://x.com');
        } else {
            const response = await globalThis.fetch('https://x.com/narendramodi?mx=2');
            absorbSetCookies(jar, response, 'https://x.com');
            const data = await response.text();
            const gt = data.match(/document\.cookie="gt=(\d+)/)?.[1];
            if (gt) {
                jar.setCookieSync(`gt=${gt}`, 'https://x.com');
            }
        }
        const cookie = JSON.stringify(jar.serializeSync());
        cache.set(`twitter:cookie:${token}`, cookie);
        return cookie;
    } catch {
        return '';
    }
};

const lockPrefix = 'twitter:lock-token1:';

const getAuth = async (retry: number): Promise<{ token: string; username?: string; password?: string; authenticationSecret?: string } | undefined> => {
    if (config.twitter.authToken && retry > 0) {
        const index = authTokenIndex++ % config.twitter.authToken.length;
        const token = config.twitter.authToken[index];
        const lock = await cache.get(`${lockPrefix}${token}`, false);
        if (lock) {
            logger.debug(`twitter debug: twitter cookie for token ${token} is locked, retry: ${retry}`);
            await new Promise((resolve) => setTimeout(resolve, Math.random() * 500 + 500));
            return await getAuth(retry - 1);
        } else {
            logger.debug(`twitter debug: lock twitter cookie for token ${token}`);
            await cache.set(`${lockPrefix}${token}`, '1', 60);
            return {
                token,
                username: config.twitter.username?.[index],
                password: config.twitter.password?.[index],
                authenticationSecret: config.twitter.authenticationSecret?.[index],
            };
        }
    }
};

export const twitterGot = async (
    url: string,
    params: Record<string, any>,
    options?: {
        allowNoAuth?: boolean;
    }
) => {
    const auth = await getAuth(30);

    if (!auth && !options?.allowNoAuth) {
        throw new ConfigNotFoundError('No valid Twitter token found');
    }

    const requestUrl = `${url}?${queryString.stringify(params)}`;

    let cookie: string | Record<string, any> | null | undefined = await token2Cookie(auth?.token);
    if (!cookie && auth) {
        cookie = await login({
            username: auth.username,
            password: auth.password,
            authenticationSecret: auth.authenticationSecret,
        });
    }

    let jar: CookieJar | undefined;
    if (cookie) {
        logger.debug(`twitter debug: got twitter cookie for token ${auth?.token}`);
        if (typeof cookie === 'string') {
            cookie = JSON.parse(cookie);
        }
        jar = CookieJar.deserializeSync(cookie as any);
    } else if (auth) {
        throw new ConfigNotFoundError(`Twitter cookie for token ${auth?.token?.replace(/(\w{8})(\w+)/, (_, v1, v2) => v1 + '*'.repeat(v2.length))} is not valid`);
    }

    const cookieString = jar ? jar.getCookieStringSync(url) : '';
    const jsonCookie = jar
        ? Object.fromEntries(
              cookieString
                  .split(';')
                  .map((c) => Cookie.parse(c)?.toJSON())
                  .map((c) => [c?.key, c?.value])
          )
        : {};

    // In CF Workers we cannot use an undici dispatcher. Send the cookie header
    // directly via globalThis.fetch (CF allows setting the Cookie header).
    const response = await globalThis.fetch(requestUrl, {
        headers: {
            authority: 'x.com',
            accept: '*/*',
            'accept-language': 'en-US,en;q=0.9',
            authorization: bearerToken,
            'cache-control': 'no-cache',
            'content-type': 'application/json',
            dnt: '1',
            pragma: 'no-cache',
            referer: 'https://x.com/',
            cookie: cookieString,
            'x-twitter-active-user': 'yes',
            'x-twitter-client-language': 'en',
            'x-csrf-token': jsonCookie.ct0,
            ...(auth?.token
                ? {
                      'x-twitter-auth-type': 'OAuth2Session',
                  }
                : {
                      'x-guest-token': jsonCookie.gt,
                  }),
        },
    });

    if (jar) {
        absorbSetCookies(jar, response, url);
    }

    let responseData: any;
    try {
        responseData = await response.json();
    } catch {
        responseData = null;
    }

    // Handle rate limiting and auth errors
    const remaining = response.headers.get('x-rate-limit-remaining');
    const remainingInt = Number.parseInt(remaining || '0');
    const reset = response.headers.get('x-rate-limit-reset');
    logger.debug(`twitter debug: twitter rate limit remaining for token ${auth?.token} is ${remaining} and reset at ${reset}, auth: ${JSON.stringify(auth)}, status: ${response.status}, data: ${JSON.stringify(responseData?.data)}`);
    if (auth) {
        if (remaining && remainingInt < 2 && reset) {
            const resetTime = new Date(Number.parseInt(reset) * 1000);
            const delay = (resetTime.getTime() - Date.now()) / 1000;
            logger.debug(`twitter debug: twitter rate limit exceeded for token ${auth.token} with status ${response.status}, will unlock after ${delay}s`);
            await cache.set(`${lockPrefix}${auth.token}`, '1', Math.max(60, Math.ceil(delay) * 2));
        } else if (response.status === 429 || JSON.stringify(responseData?.data) === '{"user":{}}') {
            logger.debug(`twitter debug: twitter rate limit exceeded for token ${auth.token} with status ${response.status}`);
            await cache.set(`${lockPrefix}${auth.token}`, '1', 2000);
        } else if (response.status === 403 || response.status === 401) {
            const newCookie = await login({
                username: auth.username,
                password: auth.password,
                authenticationSecret: auth.authenticationSecret,
            });
            if (newCookie) {
                logger.debug(`twitter debug: reset twitter cookie for token ${auth.token}`);
                await cache.set(`twitter:cookie:${auth.token}`, newCookie, config.cache.contentExpire);
                await cache.set(`${lockPrefix}${auth.token}`, '', 60);
            } else {
                const tokenIndex = config.twitter.authToken?.indexOf(auth.token);
                if (tokenIndex !== undefined && tokenIndex !== -1) {
                    config.twitter.authToken?.splice(tokenIndex, 1);
                }
                logger.debug(`twitter debug: delete twitter cookie for token ${auth.token} with status ${response.status}`);
                await cache.set(`${lockPrefix}${auth.token}`, '1', 3600);
            }
        } else {
            logger.debug(`twitter debug: unlock twitter cookie with success for token ${auth.token}`);
            await cache.set(`${lockPrefix}${auth.token}`, '', 60);
        }
    }

    if (response.status >= 400) {
        throw new Error(`Twitter API error: ${response.status}`);
    }

    if (auth?.token && jar) {
        logger.debug(`twitter debug: update twitter cookie for token ${auth.token}`);
        await cache.set(`twitter:cookie:${auth.token}`, JSON.stringify(jar.serializeSync()), config.cache.contentExpire);
    }

    return responseData;
};

export const paginationTweets = async (endpoint: string, userId: number | undefined, variables: Record<string, any>, path?: string[]) => {
    const params = {
        variables: JSON.stringify({ ...variables, userId }),
        features: JSON.stringify(gqlFeatures[endpoint]),
    };

    const fetchData = async () => {
        if (config.twitter.thirdPartyApi && thirdPartySupportedAPI.includes(endpoint)) {
            const { data } = await ofetch(`${config.twitter.thirdPartyApi}${gqlMap[endpoint]}`, {
                method: 'GET',
                params,
                headers: {
                    'accept-encoding': 'gzip',
                },
            });
            return data;
        }
        const { data } = await twitterGot(baseUrl + gqlMap[endpoint], params);
        return data;
    };

    const getInstructions = (data: any) => {
        if (path) {
            let instructions = data;
            for (const p of path) {
                instructions = instructions[p];
            }
            return instructions.instructions;
        }

        const userResult = data?.user?.result;
        const timeline = userResult?.timeline?.timeline || userResult?.timeline?.timeline_v2 || userResult?.timeline_v2?.timeline;
        const instructions = timeline?.instructions;
        if (!instructions) {
            logger.debug(`twitter debug: instructions not found in data: ${JSON.stringify(data)}`);
        }
        return instructions;
    };

    const data = await fetchData();
    const instructions = getInstructions(data);
    if (!instructions) {
        return [];
    }

    const moduleItems = instructions.find((i: any) => i.type === 'TimelineAddToModule')?.moduleItems;
    const entries = instructions.find((i: any) => i.type === 'TimelineAddEntries')?.entries;
    const gridEntries = entries?.find?.((i: any) => i.entryId === 'profile-grid-0')?.content?.items;

    return gridEntries || moduleItems || entries || [];
};

export function gatherLegacyFromData(entries: any[], filterNested?: string[], userId?: number | string) {
    const tweets: any[] = [];
    const filteredEntries: any[] = [];
    for (const entry of entries) {
        const entryId = entry.entryId;
        if (entryId) {
            if (entryId.startsWith('tweet-') || entryId.startsWith('profile-grid-0-tweet-')) {
                filteredEntries.push(entry);
            }
            if (filterNested && filterNested.some((f) => entryId.startsWith(f))) {
                filteredEntries.push(...entry.content.items);
            }
        }
    }
    for (const entry of filteredEntries) {
        if (entry.entryId) {
            const content = entry.content || entry.item;
            let tweet = content?.content?.tweetResult?.result || content?.itemContent?.tweet_results?.result;
            if (tweet && tweet.tweet) {
                tweet = tweet.tweet;
            }
            if (tweet) {
                const retweet = tweet.legacy?.retweeted_status_result?.result;
                for (const t of [tweet, retweet]) {
                    if (!t?.legacy) {
                        continue;
                    }
                    t.legacy.user = t.core?.user_result?.result?.legacy || t.core?.user_results?.result?.legacy;
                    if (t.legacy.user && t.core?.user_results?.result?.core) {
                        const coreUser = t.core.user_results.result.core;
                        if (coreUser.name) {
                            t.legacy.user.name = coreUser.name;
                        }
                        if (coreUser.screen_name) {
                            t.legacy.user.screen_name = coreUser.screen_name;
                        }
                    }
                    t.legacy.id_str = t.rest_id;
                    const quote = t.quoted_status_result?.result?.tweet || t.quoted_status_result?.result;
                    if (quote) {
                        t.legacy.quoted_status = quote.legacy;
                        t.legacy.quoted_status.user = quote.core.user_result?.result?.legacy || quote.core.user_results?.result?.legacy;
                        if (t.legacy.quoted_status.user && quote.core?.user_results?.result?.core) {
                            const qc = quote.core.user_results.result.core;
                            if (qc.name) {
                                t.legacy.quoted_status.user.name = qc.name;
                            }
                            if (qc.screen_name) {
                                t.legacy.quoted_status.user.screen_name = qc.screen_name;
                            }
                        }
                    }
                    if (t.note_tweet) {
                        const tmp = t.note_tweet.note_tweet_results.result;
                        t.legacy.entities.hashtags = tmp.entity_set.hashtags;
                        t.legacy.entities.symbols = tmp.entity_set.symbols;
                        t.legacy.entities.urls = tmp.entity_set.urls;
                        t.legacy.entities.user_mentions = tmp.entity_set.user_mentions;
                        t.legacy.full_text = tmp.text;
                    }
                }
                const legacy = tweet.legacy;
                if (legacy) {
                    if (retweet) {
                        legacy.retweeted_status = retweet.legacy;
                    }
                    if (userId === undefined || legacy.user_id_str === userId + '') {
                        tweets.push(legacy);
                    }
                }
            }
        }
    }
    return tweets;
}

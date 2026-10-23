import queryString from 'query-string';
import { CookieJar } from 'tough-cookie';

import { config } from '@/config';
import ConfigNotFoundError from '@/errors/types/config-not-found';
import cache from '@/utils/cache';
import logger from '@/utils/logger';
import ofetch from '@/utils/ofetch';
import { createTwitterCookieJar, fetchTwitterWithCookies } from '@/utils/twitter-cookie-fetch';

import { getClientTransactionId } from './client-transaction-id';
import { baseUrl, bearerToken, gqlFeatures, gqlMap, thirdPartySupportedAPI } from './constants';

export type ApiParams = Record<string, string | number | boolean | undefined>;

let authTokenIndex = 0;

const token2Cookie = async (token: string | undefined) => {
    const cached = await cache.get(`twitter:cookie:${token}`);
    if (cached) {
        return cached;
    }
    try {
        const jar = await createTwitterCookieJar(token);
        const cookie = JSON.stringify(jar.serializeSync());
        await cache.set(`twitter:cookie:${token}`, cookie);
        return cookie;
    } catch {
        return '';
    }
};

const lockPrefix = 'twitter:lock-token1:';

const getAuth = async (retry: number) => {
    if (!config.twitter.authToken?.length || retry <= 0) {
        return;
    }
    const index = authTokenIndex++ % config.twitter.authToken.length;
    const token = config.twitter.authToken[index];
    const lock = await cache.get(`${lockPrefix}${token}`, false);
    if (lock) {
        logger.debug(`twitter debug: twitter cookie is locked, retry: ${retry}`);
        await new Promise((resolve) => setTimeout(resolve, Math.random() * 500 + 500));
        return await getAuth(retry - 1);
    }
    logger.debug('twitter debug: lock twitter cookie');
    await cache.set(`${lockPrefix}${token}`, '1', 20);
    return {
        token,
    };
};

export const twitterGot = async (
    url,
    params,
    options?: {
        allowNoAuth?: boolean;
    }
) => {
    const auth = await getAuth(30);

    if (!auth && !options?.allowNoAuth) {
        throw new ConfigNotFoundError('No valid Twitter token found');
    }

    const requestUrl = `${url}?${queryString.stringify(params)}`;

    const cookie = await token2Cookie(auth?.token);
    const jar = cookie ? CookieJar.deserializeSync(JSON.parse(cookie)) : new CookieJar();
    if (cookie) {
        logger.debug('twitter debug: got twitter cookie');
    } else if (auth) {
        throw new ConfigNotFoundError('Twitter authentication cookie is not valid. Check TWITTER_AUTH_TOKEN.');
    }
    const jsonCookie = Object.fromEntries(jar.getCookiesSync(url).map((cookie) => [cookie.key, cookie.value]));

    // Keep the latest API behavior while using the Workers-native cookie transport.
    const pathname = new URL(url).pathname;
    const clientTransactionId = /\/(?:UserTweetsAndReplies|SearchTimeline)$/.test(pathname) ? await getClientTransactionId('GET', pathname) : undefined;
    const response = await fetchTwitterWithCookies(requestUrl, jar, {
        authority: 'x.com',
        accept: '*/*',
        'accept-language': 'en-US,en;q=0.9',
        authorization: bearerToken,
        'cache-control': 'no-cache',
        'content-type': 'application/json',
        dnt: '1',
        pragma: 'no-cache',
        referer: 'https://x.com/',
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
        ...(clientTransactionId && {
            'x-client-transaction-id': clientTransactionId,
        }),
    });

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
    logger.debug(`twitter debug: twitter rate limit remaining is ${remaining} and reset at ${reset}, status: ${response.status}`);
    if (auth) {
        if (remaining && remainingInt < 2 && reset) {
            const resetTime = new Date(Number.parseInt(reset) * 1000);
            const delay = (resetTime.getTime() - Date.now()) / 1000;
            logger.debug(`twitter debug: twitter rate limit exceeded with status ${response.status}, will unlock after ${delay}s`);
            await cache.set(`${lockPrefix}${auth.token}`, '1', Math.ceil(delay) * 2);
        } else if (response.status === 429 || JSON.stringify(responseData?.data) === '{"user":{}}') {
            logger.debug(`twitter debug: twitter rate limit exceeded with status ${response.status}`);
            await cache.set(`${lockPrefix}${auth.token}`, '1', 2000);
        } else if (response.status === 403 || response.status === 401) {
            config.twitter.authToken = config.twitter.authToken?.filter((token) => token !== auth.token);
            logger.debug(`twitter debug: delete twitter cookie with status ${response.status}, remaining tokens: ${config.twitter.authToken?.length}`);
            await cache.set(`${lockPrefix}${auth.token}`, '1', 3600);
        } else {
            logger.debug('twitter debug: unlock twitter cookie with success');
            await cache.set(`${lockPrefix}${auth.token}`, '', 1);
        }
    }

    if (response.status >= 400) {
        throw new Error(`Twitter API error: ${response.status}`);
    }

    if (auth?.token) {
        logger.debug('twitter debug: update twitter cookie');
        await cache.set(`twitter:cookie:${auth.token}`, JSON.stringify(jar.serializeSync()), config.cache.contentExpire);
    }

    return responseData;
};

export const paginationTweets = async (endpoint: string, userId: number | undefined, variables: ApiParams, path?: string[]) => {
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

    const moduleItems = instructions.find((i) => i.type === 'TimelineAddToModule')?.moduleItems;
    const entries = instructions.find((i) => i.type === 'TimelineAddEntries')?.entries ?? [];
    const gridEntries = entries.find((i) => i.entryId === 'profile-grid-0')?.content?.items;

    const pinnedEntries = instructions.filter((instruction) => instruction.type === 'TimelinePinEntry' && instruction.entry).map((instruction) => instruction.entry);
    return new Map([...pinnedEntries, ...(gridEntries || moduleItems || entries)].map((entry) => [entry.entryId, entry])).values().toArray();
};

const hydrateLegacyUser = (legacy: any, tweet: any) => {
    const userResult = tweet.core?.user_results?.result;
    if (!userResult) {
        return;
    }

    legacy.user = {
        name: userResult.core?.name,
        screen_name: userResult.core?.screen_name,
        profile_image_url_https: userResult.avatar?.image_url,
    };
};

export function gatherLegacyFromData(entries: any[], filterNested?: string[], userId?: number | string) {
    const tweets: any[] = [];
    const contextTweets = new Map<string, any>();
    const filteredEntries: any[] = [];
    for (const entry of entries) {
        const entryId = entry.entryId;
        if (!entryId) {
            continue;
        }
        if (entryId.startsWith('tweet-') || entryId.startsWith('profile-grid-0-tweet-')) {
            filteredEntries.push(entry);
        }
        if (filterNested && filterNested.some((f) => entryId.startsWith(f))) {
            filteredEntries.push(...entry.content.items);
        }
    }
    for (const entry of filteredEntries) {
        if (!entry.entryId) {
            continue;
        }

        const content = entry.content || entry.item;
        let tweet = content?.content?.tweetResult?.result || content?.itemContent?.tweet_results?.result;
        // Handle subscriber-only preview posts (must check before tweet.tweet reassignment)
        if (tweet?.__typename === 'TweetPreviewDisplay') {
            const preview = tweet.tweet;
            if (preview?.rest_id) {
                const userResult = preview.core?.user_results?.result;
                const fakeLegacy: any = {
                    id_str: preview.rest_id,
                    full_text: `[Subscribers Only] ${preview.text ?? ''}`,
                    created_at: preview.created_at ?? '',
                    entities: { urls: [], hashtags: [], symbols: [], user_mentions: [] },
                    user_id_str: userResult?.rest_id ?? '',
                    favorite_count: preview.favorite_count ?? 0,
                    reply_count: preview.reply_count ?? 0,
                    retweet_count: preview.retweet_count ?? 0,
                };
                hydrateLegacyUser(fakeLegacy, { core: preview.core, rest_id: preview.rest_id });
                if (userId === undefined || fakeLegacy.user_id_str === userId + '') {
                    tweets.push(fakeLegacy);
                }
            }
            continue;
        }
        if (tweet && tweet.tweet) {
            tweet = tweet.tweet;
        }
        if (!tweet) {
            continue;
        }
        const retweet = tweet.legacy?.retweeted_status_result?.result;
        for (const t of [tweet, retweet]) {
            if (!t?.legacy) {
                continue;
            }
            hydrateLegacyUser(t.legacy, t);
            t.legacy.id_str = t.rest_id; // avoid falling back to conversation_id_str elsewhere
            contextTweets.set(t.rest_id, t.legacy);
            const quote = t.quoted_status_result?.result?.tweet || t.quoted_status_result?.result;
            if (quote?.legacy) {
                t.legacy.quoted_status = quote.legacy;
                hydrateLegacyUser(t.legacy.quoted_status, quote);
            }
            if (!t.note_tweet) {
                continue;
            }
            const tmp = t.note_tweet.note_tweet_results.result;
            t.legacy.entities.hashtags = tmp.entity_set.hashtags;
            t.legacy.entities.symbols = tmp.entity_set.symbols;
            t.legacy.entities.urls = tmp.entity_set.urls;
            t.legacy.entities.user_mentions = tmp.entity_set.user_mentions;
            t.legacy.full_text = tmp.text;
        }
        const legacy = tweet.legacy;
        if (!legacy) {
            continue;
        }
        if (retweet) {
            legacy.retweeted_status = retweet.legacy;
        }
        if (userId === undefined || legacy.user_id_str === userId + '') {
            tweets.push(legacy);
        }
    }

    for (const tweet of contextTweets.values()) {
        const parent = contextTweets.get(tweet.in_reply_to_status_id_str);
        if (parent && parent !== tweet) {
            tweet.in_reply_to_status = parent;
        }
    }
    return tweets;
}

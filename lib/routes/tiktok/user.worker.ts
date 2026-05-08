// Worker-specific tiktok/user route.
//
// Investigation summary (2026-05-08):
// - Node version listens to `https://www.tiktok.com/api/post/item_list/`
//   responses to populate the feed.
// - Inside CF Browser Rendering this fails for two compounding reasons:
//   1. `response.json()` raises "Network.getResponseBody: No data found"
//      because Chromium frees the body before the handler runs.
//   2. Re-issuing the signed URL doesn't work — X-Bogus / X-Gnarly / msToken
//      are single-use, so the second hit returns an empty body.
//   3. Hooking window.fetch in the page (cloning before TikTok reads) does
//      capture the body, but TikTok detects the headless fingerprint and
//      responds with 200 + empty body (or 403 once `navigator.webdriver` is
//      hidden — different detector path, same outcome).
// - Conclusion: tiktok/user cannot serve a populated feed from inside CF
//   Browser Rendering. Surface this clearly instead of silently returning
//   metadata with 0 items.
//
// User-detail metadata (followers, avatar, etc.) is still recoverable from
// the `__UNIVERSAL_DATA_FOR_REHYDRATION__` script tag, so we keep that path
// for callers that only need profile info.

import { load } from 'cheerio';

import type { Route } from '@/types';
import cache from '@/utils/cache';
import puppeteer from '@/utils/puppeteer';
import { queryToBoolean } from '@/utils/readable-social';

import type { Item } from './types';

const baseUrl = 'https://www.tiktok.com';

export const route: Route = {
    path: '/user/:user/:iframe?',
    categories: ['social-media'],
    example: '/tiktok/user/@linustech/true',
    parameters: { user: 'User ID, including @', iframe: 'Use the official iframe to embed the video, which allows you to view the video if the default option does not work. Default to `false`' },
    features: {
        requireConfig: false,
        requirePuppeteer: true,
        antiCrawler: false,
        supportBT: false,
        supportPodcast: false,
        supportScihub: false,
    },
    radar: [
        {
            source: ['www.tiktok.com/:user'],
            target: '/user/:user',
        },
    ],
    name: 'User',
    maintainers: ['TonyRL'],
    handler,
};

async function handler(ctx) {
    const { user, iframe } = ctx.req.param();
    // useIframe is unused here because we never produce items in this build,
    // but we keep parsing it so the param signature matches the Node route.
    void queryToBoolean(iframe);

    const data = await cache.tryGet(
        `tiktok:user:${user}`,
        async () => {
            const browser = await puppeteer();
            const page = await browser.newPage();
            await page.setRequestInterception(true);
            page.on('request', (request) => {
                ['document', 'script', 'xhr', 'fetch'].includes(request.resourceType()) ? request.continue() : request.abort();
            });
            await page.goto(`${baseUrl}/${user}`, { waitUntil: 'domcontentloaded' });
            const pageHtml = await page.content();
            await browser.close();

            const $ = load(pageHtml);
            const rehydrationRaw = $('script#__UNIVERSAL_DATA_FOR_REHYDRATION__').text();
            if (!rehydrationRaw) {
                throw new Error('TikTok: rehydration data not found (likely bot-blocked)');
            }
            const rehydrationData = JSON.parse(rehydrationRaw);
            const userDetail = rehydrationData.__DEFAULT_SCOPE__['webapp.user-detail'];
            return { userDetail, itemList: { itemList: [] as Item[] } };
        },
        300,
        false
    );

    const { userDetail } = data;

    throw new Error(
        'TikTok: feed items unavailable from Cloudflare Workers — TikTok blocks api/post/item_list ' + 'from CF Browser Rendering (returns empty body or 403). Profile metadata: ' + (userDetail?.shareMeta?.title ?? 'unknown')
    );
}

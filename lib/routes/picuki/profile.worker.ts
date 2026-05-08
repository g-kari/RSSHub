// Worker-compatible variant of picuki/profile that lets the Cloudflare JS
// anti-bot challenge run to completion inside the headless browser.
//
// Differences vs profile.ts (Node build):
// - No request interception. The original implementation aborts every
//   resource that is not document/script/xhr/fetch, which prevents Cloudflare
//   challenge endpoints (images, beacons) from firing and the challenge never
//   resolves.
// - waitUntil: 'networkidle0' so the CF JS challenge has time to round-trip.
// - waitForSelector timeout extended to 60s, after which we fall back to
//   reading whatever HTML is on the page so the user gets a useful error.

import { load } from 'cheerio';

import { config } from '@/config';
import NotFoundError from '@/errors/types/not-found';
import { renderUserEmbed } from '@/routes/tiktok/templates/user';
import type { DataItem, Route } from '@/types';
import cache from '@/utils/cache';
import ofetch from '@/utils/ofetch';
import { getPuppeteerPage } from '@/utils/puppeteer';

export const route: Route = {
    path: '/profile/:id/:type?/:functionalFlag?',
    categories: ['social-media'],
    example: '/picuki/profile/linustech',
    parameters: {
        id: 'Tiktok user id (without @)',
        type: {
            description: 'Type of profile page',
            options: [
                { value: 'profile', label: 'Profile Page' },
                { value: 'story', label: 'Story Page' },
            ],
            default: 'profile',
        },
        functionalFlag: {
            description: 'Functional flag for video embedding',
            options: [
                { value: '0', label: 'Off, only show video poster as an image' },
                { value: '1', label: 'On' },
            ],
            default: '1',
        },
    },
    features: {
        requireConfig: false,
        requirePuppeteer: true,
        antiCrawler: true,
        supportBT: false,
        supportPodcast: false,
        supportScihub: false,
    },
    radar: [
        { source: ['www.picuki.com/profile/:id'], target: '/profile/:id' },
        { source: ['www.picuki.com/story/:id'], target: '/profile/:id/story' },
    ],
    name: 'User Profile - Picuki',
    maintainers: ['hoilc', 'Rongronggg9', 'devinmugen', 'NekoAria'],
    handler,
};

async function handler(ctx) {
    const id = ctx.req.param('id');
    const type = ctx.req.param('type') ?? 'profile';
    const functionalFlag = ctx.req.param('functionalFlag') ?? '1';
    const useIframe = functionalFlag !== '0';

    const baseUrl = 'https://www.picuki.com';
    const profileUrl = `${baseUrl}/${type === 'story' ? 'story' : 'profile'}/${id}`;

    const data = (await cache.tryGet(`picuki:${type}:${id}`, async () => {
        let response: string | undefined;
        try {
            response = await ofetch(profileUrl, {
                headers: { 'User-Agent': config.trueUA },
            });
        } catch (error: any) {
            if (error?.status !== 403) {
                throw new NotFoundError(error?.message ?? String(error));
            }
            // ofetch returned 403 → likely Cloudflare challenge. Hand off to the
            // headless browser and let the JS challenge run.
            const { page, destroy } = await getPuppeteerPage(profileUrl, {
                gotoConfig: { waitUntil: 'networkidle0' },
            });
            try {
                await page.waitForSelector('.content', { timeout: 60000 });
            } catch {
                // selector never appeared (challenge stuck or layout changed) —
                // fall through to whatever HTML is on the page so cheerio can
                // surface a meaningful error message.
            }
            try {
                response = await page.content();
            } finally {
                await destroy();
            }
        }

        const $ = load(response!);

        if ($('.posts-empty').length) {
            throw new Error($('.posts-empty').text().trim() || 'No posts found');
        }
        if ($('.error-p').length) {
            throw new Error($('.error-p span').text().trim() || 'Profile not found');
        }
        if (/Just a moment|Attention Required|cf-mitigated/i.test(response!)) {
            // picuki sits behind Cloudflare bot management. From inside CF
            // Browser Rendering we hit the hard block page ("Attention
            // Required!"), not the JS challenge, so there is nothing for the
            // headless browser to solve. Surface this clearly instead of
            // returning empty items.
            throw new Error('Picuki: blocked by Cloudflare bot management; use the upstream tiktok route instead');
        }

        const username = $('.profile-info .username').text().trim();

        const items = $('.posts-video .posts__video-item .posts__video-item-a')
            .toArray()
            .map((item) => {
                const $item = $(item);
                const videoId = $item.attr('href')?.split('/').pop();
                const img = $item.find('img');
                return {
                    title: img.attr('alt') || '',
                    author: username,
                    renderData: {
                        poster: img.attr('src'),
                        source: `${baseUrl}/player/${videoId}`,
                        id: videoId,
                    },
                    link: `${baseUrl}/media/${videoId}`,
                    guid: `https://www.tiktok.com/@${id}/video/${videoId}`,
                };
            });

        return {
            title: $('head title').text(),
            description: $('.posts-current').text().trim(),
            image: $('.profile-image').attr('src'),
            items,
        };
    })) as {
        title: string;
        description: string;
        image: string;
        items: Array<{
            title: string;
            author: string;
            renderData: { poster: string; source: string; id: string };
            link: string;
            guid: string;
        }>;
    };

    const items: DataItem[] = data.items.map((item) => ({
        ...item,
        description: renderUserEmbed({
            poster: item.renderData.poster,
            source: item.renderData.source,
            useIframe,
            id: item.renderData.id,
        }),
    }));

    return {
        title: data.title,
        link: profileUrl,
        image: data.image,
        description: data.description,
        item: items,
    };
}

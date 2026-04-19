// Worker-compatible stub for youtube/api/google
// The `googleapis` package pulls heavy Node-only internals (util.inherits against
// Stream subclasses, OAuth2 client, etc.) that do not load inside Cloudflare Workers.
// Since the Worker build does not support YOUTUBE_KEY flows, stub out the exports and
// force callers to fall through to the youtubei.js path in `callApi`.

import ConfigNotFoundError from '@/errors/types/config-not-found';
import type { Data } from '@/types';

const unavailable = (): never => {
    throw new ConfigNotFoundError('YouTube Data API is not available in Cloudflare Workers');
};

export const youtubeOAuth2Client = {
    getAccessToken: () => Promise.reject(new ConfigNotFoundError('YouTube OAuth2 is not available in Cloudflare Workers')),
    setCredentials: unavailable,
};

export const exec = (_func: (youtube: unknown) => unknown): Promise<never> => Promise.reject(new ConfigNotFoundError('YouTube Data API is not available in Cloudflare Workers'));

const notAvailable = (): Promise<Data> => Promise.reject(new ConfigNotFoundError('YouTube Data API is not available in Cloudflare Workers'));

export const getDataByUsername = notAvailable;
export const getDataByChannelId = notAvailable;
export const getDataByPlaylistId = notAvailable;

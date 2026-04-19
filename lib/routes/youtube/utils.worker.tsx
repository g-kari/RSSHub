// Worker-compatible youtube utils
// Does not import `googleapis`. All googleapis-backed helpers throw, and `callApi`
// always routes to the youtubei.js-based implementation.

import { raw } from 'hono/html';
import { renderToString } from 'hono/jsx/dom/server';

import { config } from '@/config';
import ConfigNotFoundError from '@/errors/types/config-not-found';

const unavailable = () => {
    throw new ConfigNotFoundError('YouTube Data API is not available in Cloudflare Workers');
};

export const getPlaylistItems = unavailable as unknown as (id: any, part: any, cache: any) => any;
export const getPlaylist = unavailable as unknown as (id: any, part: any, cache: any) => any;
export const getChannelWithId = unavailable as unknown as (id: any, part: any, cache: any) => any;
export const getChannelWithUsername = unavailable as unknown as (username: any, part: any, cache: any) => any;
export const getVideos = unavailable as unknown as (id: any, part: any, cache: any) => any;
export const getSubscriptions = unavailable as unknown as (part: any, cache: any) => any;
export const getSubscriptionsRecusive = unavailable as unknown as (part: any, nextPageToken?: any) => any;
export const getLive = unavailable as unknown as (id: any, cache: any) => any;

export const getThumbnail = (thumbnails) => thumbnails.maxres || thumbnails.standard || thumbnails.high || thumbnails.medium || thumbnails.default;
export const formatDescription = (description) => description?.replaceAll(/\r\n|\r|\n/g, '<br>');
export const renderDescription = (embed, videoId, img, description) =>
    renderToString(
        <>
            {embed ? (
                <iframe
                    id="ytplayer"
                    type="text/html"
                    width="640"
                    height="360"
                    src={(config.youtube?.videoEmbedUrl || 'https://www.youtube-nocookie.com/embed/') + videoId}
                    frameborder="0"
                    allowfullscreen
                    referrerpolicy="strict-origin-when-cross-origin"
                />
            ) : (
                <img src={img?.url ?? ''} />
            )}
            <br />
            {description ? <>{raw(description)}</> : null}
        </>
    );

export const isYouTubeChannelId = (id) => /^UC[\w-]{21}[AQgw]$/.test(id);
export const getVideoUrl = (id: string) => `https://www.youtube-nocookie.com/embed/${id}?controls=1&autoplay=1&mute=0`;

export const getPlaylistWithShortsFilter = (id: string, filterShorts = true): string => {
    if (filterShorts) {
        if (id.startsWith('UC')) {
            return 'UULF' + id.slice(2);
        } else if (id.startsWith('UU')) {
            return 'UULF' + id.slice(2);
        }
    }
    return id;
};

// Always use youtubei.js in Worker builds; googleapis is stubbed out.
export const callApi = async function callApi<T>({ youtubeiApi, params }: { googleApi: (params: any) => Promise<T>; youtubeiApi: (params: any) => Promise<T>; params: any }): Promise<T> {
    return await youtubeiApi(params);
};

export default {
    getPlaylistItems,
    getPlaylist,
    getChannelWithId,
    getChannelWithUsername,
    getVideos,
    getThumbnail,
    formatDescription,
    renderDescription,
    getSubscriptions,
    getSubscriptionsRecusive,
    isYouTubeChannelId,
    getLive,
    getVideoUrl,
    getPlaylistWithShortsFilter,
};

import { FeedEntry, extractFeedTitle, parseFeedEntries } from './feed';
import { createLogger } from '../util/logger';

const log = createLogger('youtube');

const FEED_URL = 'https://www.youtube.com/feeds/videos.xml?channel_id=';
const USER_AGENT =
  process.env.YOUTUBE_USER_AGENT ||
  'Mozilla/5.0 (compatible; MutterBot/2.0; +https://github.com/) feed-reader';

export interface ChannelFeed {
  title: string;
  entries: FeedEntry[];
  notModified: boolean;
}

// Conditional-GET cache: the poller re-reads five feeds every few minutes, and
// YouTube answers 304 for the vast majority of those requests.
const feedCache = new Map<string, { etag?: string; lastModified?: string }>();

export function feedUrlFor(channelId: string): string {
  return `${FEED_URL}${encodeURIComponent(channelId)}`;
}

async function fetchText(url: string, headers: Record<string, string>, timeoutMs = 15_000) {
  const response = await fetch(url, {
    headers: { 'User-Agent': USER_AGENT, ...headers },
    redirect: 'follow',
    signal: AbortSignal.timeout(timeoutMs),
  });
  return response;
}

export async function fetchChannelFeed(
  channelId: string,
  useCache = true
): Promise<ChannelFeed | null> {
  const cached = useCache ? feedCache.get(channelId) : undefined;
  const headers: Record<string, string> = {};
  if (cached?.etag) {
    headers['If-None-Match'] = cached.etag;
  }
  if (cached?.lastModified) {
    headers['If-Modified-Since'] = cached.lastModified;
  }

  try {
    const response = await fetchText(feedUrlFor(channelId), headers);

    if (response.status === 304) {
      return { title: '', entries: [], notModified: true };
    }

    if (!response.ok) {
      log.warn(`Feed for ${channelId} returned HTTP ${response.status}`);
      return null;
    }

    const etag = response.headers.get('etag');
    const lastModified = response.headers.get('last-modified');
    if (etag || lastModified) {
      feedCache.set(channelId, {
        etag: etag || undefined,
        lastModified: lastModified || undefined,
      });
    }

    const xml = await response.text();
    return { title: extractFeedTitle(xml), entries: parseFeedEntries(xml), notModified: false };
  } catch (error) {
    log.warn(`Failed to fetch feed for ${channelId}`, error);
    return null;
  }
}

export async function fetchLatestVideos(channelId: string, limit = 5): Promise<FeedEntry[]> {
  const feed = await fetchChannelFeed(channelId, false);
  return feed ? feed.entries.slice(0, limit) : [];
}

const CHANNEL_ID_PATTERN = /^UC[\w-]{20,}$/;

function normalizeChannelInput(input: string): string {
  const trimmed = input.trim();

  if (CHANNEL_ID_PATTERN.test(trimmed)) {
    return `https://www.youtube.com/channel/${trimmed}`;
  }
  if (/^https?:\/\//i.test(trimmed)) {
    return trimmed;
  }
  if (trimmed.startsWith('@')) {
    return `https://www.youtube.com/${trimmed}`;
  }
  if (/^(youtube\.com|www\.youtube\.com|m\.youtube\.com|youtu\.be)\//i.test(trimmed)) {
    return `https://${trimmed}`;
  }
  return `https://www.youtube.com/@${trimmed}`;
}

export function extractChannelIdFromUrl(url: string): string | null {
  const direct = url.match(/youtube\.com\/channel\/(UC[\w-]{20,})/i)?.[1];
  if (direct) {
    return direct;
  }
  const fromFeed = url.match(/[?&]channel_id=(UC[\w-]{20,})/i)?.[1];
  if (fromFeed) {
    return fromFeed;
  }
  return CHANNEL_ID_PATTERN.test(url.trim()) ? url.trim() : null;
}

function extractChannelIdFromHtml(html: string): string | null {
  const patterns = [
    /"channelId":"(UC[\w-]{20,})"/i,
    /"externalId":"(UC[\w-]{20,})"/i,
    /<meta[^>]+itemprop=["']channelId["'][^>]+content=["'](UC[\w-]{20,})["']/i,
    /channel\/(UC[\w-]{20,})/i,
  ];

  for (const pattern of patterns) {
    const match = html.match(pattern)?.[1];
    if (match) {
      return match;
    }
  }
  return null;
}

export interface ResolvedChannel {
  channelId: string;
  title: string;
  latest: FeedEntry[];
}

// Accepts a UC id, /channel/ URL, @handle (bare or URL), legacy /c/ and /user/
// URLs, or a video URL, and resolves all of them to a canonical UC id.
export async function resolveChannel(input: string): Promise<ResolvedChannel | null> {
  const normalized = normalizeChannelInput(input);
  let channelId = extractChannelIdFromUrl(normalized);

  if (!channelId) {
    try {
      const response = await fetchText(normalized, {});
      if (!response.ok) {
        log.warn(`Channel page ${normalized} returned HTTP ${response.status}`);
        return null;
      }
      channelId = extractChannelIdFromHtml(await response.text());
    } catch (error) {
      log.warn(`Could not load channel page ${normalized}`, error);
      return null;
    }
  }

  if (!channelId) {
    log.warn(`Could not extract a channel id from ${input}`);
    return null;
  }

  // Validate by reading the feed, which also gives us the display title.
  const feed = await fetchChannelFeed(channelId, false);
  if (!feed) {
    return null;
  }

  return { channelId, title: feed.title || channelId, latest: feed.entries };
}

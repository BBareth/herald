// YouTube's WebSub push payload and its public RSS feed are the same Atom
// document, so both delivery paths share one parser. This is also why the
// project no longer depends on rss-parser.

export interface FeedEntry {
  channelId: string;
  videoId: string;
  title: string;
  link: string;
  author: string;
  published: string;
  updated: string;
}

const NAMED_ENTITIES: Record<string, string> = {
  '&quot;': '"',
  '&#34;': '"',
  '&apos;': "'",
  '&#39;': "'",
  '&amp;': '&',
  '&lt;': '<',
  '&gt;': '>',
  '&nbsp;': ' ',
};

export function decodeHtmlEntities(value: string): string {
  if (!value) {
    return value;
  }

  let decoded = value;

  // Feeds occasionally carry nested encodings such as `&amp;quot;`.
  for (let i = 0; i < 3; i++) {
    const next = decoded
      .replace(/&(quot|#34|apos|#39|amp|lt|gt|nbsp);/g, (entity) => NAMED_ENTITIES[entity] || entity)
      .replace(/&#(\d+);/g, (whole, codePoint) => {
        const code = Number(codePoint);
        return Number.isNaN(code) ? whole : String.fromCodePoint(code);
      })
      .replace(/&#x([0-9a-fA-F]+);/g, (whole, hexCodePoint) => {
        const code = Number.parseInt(hexCodePoint, 16);
        return Number.isNaN(code) ? whole : String.fromCodePoint(code);
      });

    if (next === decoded) {
      break;
    }

    decoded = next;
  }

  return decoded;
}

function extractTagValue(xml: string, tagName: string): string {
  const regex = new RegExp(`<${tagName}[^>]*>([^]*?)</${tagName}>`, 'i');
  return decodeHtmlEntities(xml.match(regex)?.[1]?.trim() || '');
}

function extractLinkHref(xml: string): string {
  // Prefer rel="alternate" (the watch page); fall back to the first link.
  const alternate =
    xml.match(/<link[^>]*rel=["']alternate["'][^>]*href=["']([^"']+)["']/i)?.[1] ||
    xml.match(/<link[^>]*href=["']([^"']+)["'][^>]*rel=["']alternate["']/i)?.[1];
  if (alternate) {
    return decodeHtmlEntities(alternate);
  }
  return decodeHtmlEntities(xml.match(/<link[^>]*href=["']([^"']+)["'][^>]*>/i)?.[1] || '');
}

// The <link rel="self"> href is the subscription topic URL. Its channel_id is
// the channel the notification was actually delivered for — reliable even for
// collaboration videos whose entry yt:channelId points at a collaborator.
export function extractTopicChannelId(xml: string): string {
  const selfLink =
    xml.match(/<link[^>]*rel=["']self["'][^>]*href=["']([^"']+)["']/i)?.[1] ||
    xml.match(/<link[^>]*href=["']([^"']+)["'][^>]*rel=["']self["']/i)?.[1] ||
    '';
  return decodeHtmlEntities(selfLink).match(/channel_id=([\w-]+)/i)?.[1] || '';
}

export function extractFeedTitle(xml: string): string {
  // The feed-level <title> sits before the first <entry>.
  const head = xml.split(/<entry[\s>]/i)[0];
  return extractTagValue(head, 'title');
}

export function parseFeedEntries(xml: string): FeedEntry[] {
  const feedChannelId =
    extractTagValue(xml.split(/<entry[\s>]/i)[0], 'yt:channelId') || extractTopicChannelId(xml);
  const entries = xml.match(/<entry[\s\S]*?<\/entry>/gi) || [];

  return entries
    .map((entryXml) => ({
      channelId:
        extractTagValue(entryXml, 'yt:channelId') ||
        extractTagValue(entryXml, 'channelId') ||
        feedChannelId,
      videoId: extractTagValue(entryXml, 'yt:videoId') || extractTagValue(entryXml, 'videoId'),
      title: extractTagValue(entryXml, 'title'),
      link: extractLinkHref(entryXml),
      author: extractTagValue(entryXml, 'name'),
      published: extractTagValue(entryXml, 'published'),
      updated: extractTagValue(entryXml, 'updated'),
    }))
    // Duplicate notifications (title/description edits that re-send an existing
    // video) are filtered downstream by the video_history claim, so entries are
    // never dropped on a published/updated delta here — that previously
    // discarded legitimate uploads (unlisted-then-public videos, scheduled
    // premieres, and large videos that finish processing long after publish).
    .filter((entry) => Boolean(entry.channelId && entry.videoId));
}

export function watchUrl(videoId: string): string {
  return `https://www.youtube.com/watch?v=${videoId}`;
}

import { v4 as uuidv4 } from 'uuid';
import { GuildRow, WatchRow, getBotToken, getDatabase, watchersOf } from '../database/db';
import { FeedEntry, watchUrl } from './feed';
import { sendMessage } from './discord';
import { createLogger } from '../util/logger';

const log = createLogger('notify');

export const DEFAULT_TEMPLATE = '{title} - {link}';

function renderTemplate(template: string, entry: FeedEntry, sourceTitle: string | null): string {
  const values: Record<string, string> = {
    title: entry.title || 'New video uploaded',
    link: entry.link || watchUrl(entry.videoId),
    url: entry.link || watchUrl(entry.videoId),
    channel: sourceTitle || entry.author || entry.channelId,
    author: entry.author || sourceTitle || entry.channelId,
    videoId: entry.videoId,
    published: entry.published || '',
  };

  // Replace every occurrence — a single-shot replace silently drops repeated
  // placeholders such as "{title} … watch {title}".
  return template.replace(/\{(\w+)\}/g, (whole, key: string) =>
    key in values ? values[key] : whole
  );
}

export type NotifySource = 'websub' | 'poll' | 'manual';

export interface FanoutResult {
  sent: number;
  duplicates: number;
  failed: number;
  unconfigured: number;
}

/**
 * Delivers one upload to a single guild's watch.
 *
 * The claim is an `INSERT OR IGNORE` against a unique (watch, video) index, so
 * a WebSub push and a poller pass racing over the same upload can never
 * double-post. A failed send releases the claim so the next pass retries.
 */
export async function notifyWatch(
  watch: WatchRow,
  guild: GuildRow,
  entry: FeedEntry,
  sourceTitle: string | null,
  source: NotifySource
): Promise<'sent' | 'duplicate' | 'failed' | 'unconfigured'> {
  const db = getDatabase();
  const token = getBotToken();

  const claim = db
    .prepare(
      `INSERT OR IGNORE INTO video_history (id, watch_id, video_id, title, source, sent_at)
       VALUES (?, ?, ?, ?, ?, CURRENT_TIMESTAMP)`
    )
    .run(uuidv4(), watch.id, entry.videoId, entry.title || null, source);

  if (claim.changes === 0) {
    return 'duplicate';
  }

  const releaseClaim = () =>
    db
      .prepare('DELETE FROM video_history WHERE watch_id = ? AND video_id = ?')
      .run(watch.id, entry.videoId);

  if (!token || !guild.notify_channel_id) {
    releaseClaim();
    return 'unconfigured';
  }

  const message = renderTemplate(guild.message_template || DEFAULT_TEMPLATE, entry, sourceTitle);
  const sent = await sendMessage(token, guild.notify_channel_id, message);

  if (!sent) {
    releaseClaim();
    log.warn(`Send failed for ${entry.videoId} in guild ${guild.id}; will retry`);
    return 'failed';
  }

  db.prepare('UPDATE watches SET last_notified_at = CURRENT_TIMESTAMP WHERE id = ?').run(watch.id);
  log.info(
    `Posted ${entry.videoId} "${entry.title}" to guild ${guild.name || guild.id} via ${source}`
  );
  return 'sent';
}

/**
 * Delivers one upload to every guild watching that YouTube channel. Guilds are
 * independent: one failing does not hold up the others, and each keeps its own
 * dedupe record.
 */
export async function fanOut(
  youtubeChannelId: string,
  entry: FeedEntry,
  sourceTitle: string | null,
  source: NotifySource
): Promise<FanoutResult> {
  const result: FanoutResult = { sent: 0, duplicates: 0, failed: 0, unconfigured: 0 };

  for (const watch of watchersOf(youtubeChannelId)) {
    const outcome = await notifyWatch(watch, watch.guild, entry, sourceTitle, source);
    if (outcome === 'sent') result.sent++;
    else if (outcome === 'duplicate') result.duplicates++;
    else if (outcome === 'failed') result.failed++;
    else result.unconfigured++;
  }

  return result;
}

export function isVideoKnown(watchId: string, videoId: string): boolean {
  return Boolean(
    getDatabase()
      .prepare('SELECT 1 FROM video_history WHERE watch_id = ? AND video_id = ? LIMIT 1')
      .get(watchId, videoId)
  );
}

/** Marks videos as already seen without posting them (used when adding a watch). */
export function baselineVideos(watchId: string, entries: FeedEntry[]): void {
  const db = getDatabase();
  const insert = db.prepare(
    `INSERT OR IGNORE INTO video_history (id, watch_id, video_id, title, source, sent_at)
     VALUES (?, ?, ?, ?, 'baseline', CURRENT_TIMESTAMP)`
  );
  const run = db.transaction((rows: FeedEntry[]) => {
    for (const entry of rows) {
      insert.run(uuidv4(), watchId, entry.videoId, entry.title || null);
    }
  });
  run(entries);
}

export function lastNotificationAt(): string | null {
  const row = getDatabase()
    .prepare("SELECT MAX(sent_at) AS at FROM video_history WHERE source != 'baseline'")
    .get() as { at: string | null };
  return row.at;
}

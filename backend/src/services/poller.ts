import { SourceRow, getDatabase, watchersOf } from '../database/db';
import { fetchChannelFeed } from './youtube';
import { baselineVideos, isVideoKnown, notifyWatch } from './notifier';
import { recordMissedPush } from './websub';
import { createLogger } from '../util/logger';

const log = createLogger('poller');

// WebSub is best-effort: the hub drops pushes when it cannot reach the callback
// and never redelivers them, and a lease can lapse silently. Polling the public
// RSS feed closes that gap — every upload is caught within one interval even if
// push delivery is completely broken.
const POLL_INTERVAL_MS = Number(process.env.POLL_INTERVAL_MS || 5 * 60 * 1000);
const POLL_SPACING_MS = Number(process.env.POLL_SPACING_MS || 1_000);
// Cap per watch per pass so a long outage cannot dump a wall of messages.
const MAX_NOTIFY_PER_PASS = Number(process.env.POLL_MAX_PER_PASS || 3);
// A push is near-instant while YouTube's RSS lags several minutes, so a poll
// win on a fresh upload is normal. Only an upload this old, still unpushed, is
// evidence that push is actually broken for the channel.
const MISSED_PUSH_GRACE_MS = Number(process.env.POLL_MISSED_PUSH_GRACE_MS || 15 * 60 * 1000);

let pollTimer: NodeJS.Timeout | undefined;
let pollRunning = false;
let lastPollAt: string | null = null;
let lastPollFound = 0;

export function getPollerStatus() {
  return {
    enabled: POLL_INTERVAL_MS > 0,
    intervalMs: POLL_INTERVAL_MS,
    lastPollAt,
    lastPollFound,
  };
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function pollSource(source: SourceRow): Promise<number> {
  const feed = await fetchChannelFeed(source.channel_id);

  getDatabase()
    .prepare('UPDATE youtube_sources SET last_polled_at = CURRENT_TIMESTAMP WHERE id = ?')
    .run(source.id);

  if (!feed || feed.notModified || feed.entries.length === 0) {
    return 0;
  }

  if (feed.title && feed.title !== source.title) {
    getDatabase()
      .prepare('UPDATE youtube_sources SET title = ? WHERE id = ?')
      .run(feed.title, source.id);
  }

  const leaseExpiresAt = source.lease_expires_at ? Date.parse(source.lease_expires_at) : NaN;
  const leaseLive = !Number.isNaN(leaseExpiresAt) && leaseExpiresAt > Date.now();
  const watchers = watchersOf(source.channel_id);

  let sent = 0;
  let missedPush = false;

  // Each guild has its own history, so "new" is decided per watch.
  for (const watch of watchers) {
    const addedAt = Date.parse(`${watch.created_at.replace(' ', 'T')}Z`);
    const unseen = feed.entries.filter((entry) => {
      if (isVideoKnown(watch.id, entry.videoId)) {
        return false;
      }
      // Anything published before this guild started watching is history,
      // whatever the history table says.
      const published = Date.parse(entry.published || '');
      if (!Number.isNaN(addedAt) && !Number.isNaN(published) && published < addedAt) {
        baselineVideos(watch.id, [entry]);
        return false;
      }
      return true;
    });

    if (unseen.length === 0) {
      continue;
    }

    // Oldest first so a backlog reads in upload order, newest last.
    const ordered = unseen
      .slice()
      .sort((a, b) => Date.parse(a.published || '0') - Date.parse(b.published || '0'));

    if (ordered.length > MAX_NOTIFY_PER_PASS) {
      log.warn(
        `${source.channel_id} has ${ordered.length} unseen videos for guild ${watch.guild_id}; posting the newest ${MAX_NOTIFY_PER_PASS}`
      );
    }

    for (const entry of ordered.slice(-MAX_NOTIFY_PER_PASS)) {
      const result = await notifyWatch(watch, watch.guild, entry, source.title, 'poll');
      if (result !== 'sent') {
        continue;
      }
      sent++;

      const published = Date.parse(entry.published || '');
      if (leaseLive && !Number.isNaN(published) && Date.now() - published > MISSED_PUSH_GRACE_MS) {
        missedPush = true;
      }
    }
  }

  if (missedPush) {
    recordMissedPush(
      source.channel_id,
      'An upload arrived by polling well after publish despite a live subscription; push is not being delivered'
    );
  }

  return sent;
}

export async function pollAllSources(): Promise<{ checked: number; sent: number }> {
  if (pollRunning) {
    return { checked: 0, sent: 0 };
  }
  pollRunning = true;

  try {
    const sources = getDatabase()
      .prepare(
        `SELECT s.* FROM youtube_sources s
         WHERE EXISTS (SELECT 1 FROM watches w WHERE w.source_id = s.id)`
      )
      .all() as SourceRow[];
    let sent = 0;

    for (const [index, source] of sources.entries()) {
      if (index > 0) {
        await sleep(POLL_SPACING_MS);
      }
      try {
        sent += await pollSource(source);
      } catch (error) {
        log.error(`Poll failed for ${source.channel_id}`, error);
      }
    }

    lastPollAt = new Date().toISOString();
    lastPollFound = sent;
    if (sent > 0) {
      log.info(`Poll pass posted ${sent} notification(s) missed by WebSub`);
    }
    return { checked: sources.length, sent };
  } finally {
    pollRunning = false;
  }
}

export function startPoller(): void {
  if (POLL_INTERVAL_MS <= 0) {
    log.info('Polling disabled (POLL_INTERVAL_MS <= 0)');
    return;
  }

  setTimeout(() => {
    pollAllSources().catch((error) => log.error('Initial poll failed', error));
  }, 20_000).unref();

  pollTimer = setInterval(() => {
    pollAllSources().catch((error) => log.error('Poll pass failed', error));
  }, POLL_INTERVAL_MS);
  pollTimer.unref();

  log.info(`RSS fallback poller every ${Math.round(POLL_INTERVAL_MS / 1000)}s`);
}

export function stopPoller(): void {
  if (pollTimer) {
    clearInterval(pollTimer);
    pollTimer = undefined;
  }
}

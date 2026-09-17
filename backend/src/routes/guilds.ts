import { Router, Request, Response } from 'express';
import { v4 as uuidv4 } from 'uuid';
import {
  GuildRow,
  SourceRow,
  WatchWithSource,
  getBotToken,
  getDatabase,
  getGuild,
  listWatches,
  upsertGuild,
} from '../database/db';
import { inviteUrl, listBotGuilds, listGuildChannels } from '../services/discord';
import { fetchChannelFeed, resolveChannel } from '../services/youtube';
import { subscribeToChannel, unsubscribeFromChannel } from '../services/websub';
import { DEFAULT_TEMPLATE, baselineVideos, notifyWatch } from '../services/notifier';
import { mayManageGuild } from '../services/auth';
import { createLogger } from '../util/logger';

const log = createLogger('guilds');

export const guildRouter = Router();

/** Every request under /:guildId proves the caller may administer that guild. */
function requireGuildAccess(req: Request, res: Response): GuildRow | null {
  const guildId = req.params.guildId;
  if (!mayManageGuild(req.user ?? null, guildId)) {
    res.status(403).json({ error: 'You do not manage that server' });
    return null;
  }
  const guild = getGuild(guildId);
  if (!guild) {
    res.status(404).json({ error: 'Server not configured yet' });
    return null;
  }
  return guild;
}

// The server picker: every guild the bot is in, annotated with whether the
// caller may manage it, plus an invite link for adding it somewhere new.
guildRouter.get('/', async (req: Request, res: Response) => {
  const token = getBotToken();
  if (!token) {
    return res.status(400).json({ error: 'No Discord bot token configured', guilds: [] });
  }

  const botGuilds = await listBotGuilds(token);
  const db = getDatabase();
  const counts = db
    .prepare('SELECT guild_id, COUNT(*) AS n FROM watches GROUP BY guild_id')
    .all() as Array<{ guild_id: string; n: number }>;
  const countByGuild = new Map(counts.map((row) => [row.guild_id, row.n]));

  const guilds = botGuilds
    .map((guild) => {
      const stored = getGuild(guild.id);
      return {
        id: guild.id,
        name: guild.name,
        icon: guild.icon,
        manageable: mayManageGuild(req.user ?? null, guild.id),
        configured: Boolean(stored?.notify_channel_id),
        watchCount: countByGuild.get(guild.id) || 0,
      };
    })
    .filter((guild) => guild.manageable);

  res.json({ guilds, inviteUrl: inviteUrl(token) });
});

guildRouter.get('/:guildId', async (req: Request, res: Response) => {
  const guildId = req.params.guildId;
  if (!mayManageGuild(req.user ?? null, guildId)) {
    return res.status(403).json({ error: 'You do not manage that server' });
  }

  const token = getBotToken();
  const botGuilds = token ? await listBotGuilds(token) : [];
  const botGuild = botGuilds.find((guild) => guild.id === guildId);
  if (!botGuild) {
    return res.status(404).json({ error: 'The bot is not in that server' });
  }

  // First visit creates the row, so a guild only exists once someone opens it.
  const guild = upsertGuild(guildId, botGuild.name, botGuild.icon);

  res.json({
    guild: {
      id: guild.id,
      name: guild.name,
      icon: guild.icon,
      notifyChannelId: guild.notify_channel_id,
      messageTemplate: guild.message_template || DEFAULT_TEMPLATE,
      enabled: Boolean(guild.enabled),
    },
    watches: listWatches(guildId),
  });
});

guildRouter.get('/:guildId/discord-channels', async (req: Request, res: Response) => {
  if (!requireGuildAccess(req, res)) {
    return;
  }
  const token = getBotToken();
  if (!token) {
    return res.status(400).json({ error: 'No Discord bot token configured' });
  }

  try {
    const channels = await listGuildChannels(token, req.params.guildId);
    if (channels.length === 0) {
      return res
        .status(400)
        .json({ error: 'No text channels visible. Grant the bot View Channels.' });
    }
    res.json({ channels });
  } catch (error) {
    log.error('Failed to list guild channels', error);
    res.status(502).json({ error: 'Could not read the channel list' });
  }
});

guildRouter.post('/:guildId/settings', (req: Request, res: Response) => {
  if (!requireGuildAccess(req, res)) {
    return;
  }

  const notifyChannelId = String(req.body?.notifyChannelId || '').trim();
  const messageTemplate = String(req.body?.messageTemplate || '').trim() || DEFAULT_TEMPLATE;
  const enabled = req.body?.enabled === undefined ? 1 : req.body.enabled ? 1 : 0;

  if (!notifyChannelId) {
    return res.status(400).json({ error: 'Pick a notification channel' });
  }

  getDatabase()
    .prepare(
      `UPDATE guilds
       SET notify_channel_id = ?, message_template = ?, enabled = ?, updated_at = CURRENT_TIMESTAMP
       WHERE id = ?`
    )
    .run(notifyChannelId, messageTemplate, enabled, req.params.guildId);

  res.json({ success: true, message: 'Settings saved' });
});

guildRouter.post('/:guildId/watches', async (req: Request, res: Response) => {
  const guild = requireGuildAccess(req, res);
  if (!guild) {
    return;
  }

  const channelUrl = String(req.body?.channelUrl || '').trim();
  if (!channelUrl) {
    return res.status(400).json({ error: 'Channel URL is required' });
  }

  const resolved = await resolveChannel(channelUrl);
  if (!resolved) {
    return res
      .status(400)
      .json({ error: 'Could not resolve that channel. Use a channel URL, @handle, or UC… id.' });
  }

  const db = getDatabase();
  const existingWatch = db
    .prepare(
      `SELECT w.id FROM watches w
       JOIN youtube_sources s ON s.id = w.source_id
       WHERE w.guild_id = ? AND s.channel_id = ?`
    )
    .get(req.params.guildId, resolved.channelId);
  if (existingWatch) {
    return res.status(409).json({ error: `Already watching ${resolved.title}` });
  }

  // The source is shared: a second guild watching the same creator reuses the
  // existing subscription rather than opening another one.
  let source = db.prepare('SELECT * FROM youtube_sources WHERE channel_id = ?').get(
    resolved.channelId
  ) as SourceRow | undefined;

  const isNewSource = !source;
  if (!source) {
    const sourceId = uuidv4();
    db.prepare(
      `INSERT INTO youtube_sources (id, channel_id, title, subscription_state)
       VALUES (?, ?, ?, 'pending')`
    ).run(sourceId, resolved.channelId, resolved.title);
    source = db.prepare('SELECT * FROM youtube_sources WHERE id = ?').get(sourceId) as SourceRow;
  }

  const watchId = uuidv4();
  db.prepare(
    'INSERT INTO watches (id, guild_id, source_id, channel_url) VALUES (?, ?, ?, ?)'
  ).run(watchId, req.params.guildId, source.id, channelUrl);

  // Existing uploads are recorded as seen so adding a channel never floods a
  // server with its back catalogue.
  baselineVideos(watchId, resolved.latest);

  if (isNewSource) {
    // Subscribing can take minutes when the hub is throttling, so it runs
    // detached; the renewal sweep retries and the poller covers the gap.
    void subscribeToChannel(resolved.channelId).catch((error) =>
      log.warn(`Initial subscribe deferred for ${resolved.channelId}`, error)
    );
  }

  res.json({
    success: true,
    message: `Now watching ${resolved.title}. Existing videos were baselined.`,
    watches: listWatches(req.params.guildId),
  });
});

function findWatch(guildId: string, watchId: string): WatchWithSource | undefined {
  return getDatabase()
    .prepare(
      `SELECT w.*, s.channel_id, s.title, s.subscription_state, s.lease_expires_at,
              s.last_push_at, s.last_error
       FROM watches w JOIN youtube_sources s ON s.id = w.source_id
       WHERE w.guild_id = ? AND w.id = ?`
    )
    .get(guildId, watchId) as WatchWithSource | undefined;
}

// Posts the newest video regardless of history, to confirm the Discord side
// works without waiting for an upload.
guildRouter.post('/:guildId/watches/:watchId/test', async (req: Request, res: Response) => {
  const guild = requireGuildAccess(req, res);
  if (!guild) {
    return;
  }
  const watch = findWatch(req.params.guildId, req.params.watchId);
  if (!watch) {
    return res.status(404).json({ error: 'Not watching that channel' });
  }

  const feed = await fetchChannelFeed(watch.channel_id, false);
  const entry = feed?.entries[0];
  if (!entry) {
    return res.status(502).json({ error: 'Could not read the channel feed' });
  }

  getDatabase()
    .prepare('DELETE FROM video_history WHERE watch_id = ? AND video_id = ?')
    .run(watch.id, entry.videoId);

  const result = await notifyWatch(watch, guild, entry, watch.title, 'manual');
  if (result !== 'sent') {
    return res.status(502).json({
      error:
        result === 'unconfigured'
          ? 'Pick a notification channel first'
          : `Test notification ${result}`,
    });
  }
  res.json({ success: true, message: `Posted "${entry.title}"` });
});

guildRouter.post('/:guildId/watches/:watchId/resubscribe', async (req: Request, res: Response) => {
  if (!requireGuildAccess(req, res)) {
    return;
  }
  const watch = findWatch(req.params.guildId, req.params.watchId);
  if (!watch) {
    return res.status(404).json({ error: 'Not watching that channel' });
  }

  try {
    await subscribeToChannel(watch.channel_id);
    res.json({ success: true, message: 'Subscription requested' });
  } catch (error) {
    res.status(502).json({ error: error instanceof Error ? error.message : 'Subscribe failed' });
  }
});

guildRouter.delete('/:guildId/watches/:watchId', async (req: Request, res: Response) => {
  if (!requireGuildAccess(req, res)) {
    return;
  }
  const watch = findWatch(req.params.guildId, req.params.watchId);
  if (!watch) {
    return res.status(404).json({ error: 'Not watching that channel' });
  }

  const db = getDatabase();
  db.prepare('DELETE FROM watches WHERE id = ?').run(watch.id);

  // The subscription only goes away once no guild wants it any more.
  const remaining = db
    .prepare('SELECT COUNT(*) AS n FROM watches WHERE source_id = ?')
    .get(watch.source_id) as { n: number };

  if (remaining.n === 0) {
    db.prepare('DELETE FROM youtube_sources WHERE id = ?').run(watch.source_id);
    try {
      await unsubscribeFromChannel(watch.channel_id);
    } catch (error) {
      // Not fatal: the lease lapses on its own and unmatched pushes are ignored.
      log.warn(`Unsubscribe failed for ${watch.channel_id}`, error);
    }
  }

  res.json({ success: true, message: 'Stopped watching', watches: listWatches(req.params.guildId) });
});

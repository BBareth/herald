import Database from 'better-sqlite3';
import path from 'path';
import { createLogger } from '../util/logger';

const log = createLogger('db');
const dbPath = process.env.DATABASE_PATH || path.join(__dirname, '../../data/herald.db');

let db: Database.Database | undefined;
let checkpointTimer: NodeJS.Timeout | undefined;

export function getDatabase(): Database.Database {
  if (!db) {
    db = new Database(dbPath);
    db.pragma('journal_mode = WAL');
    // Notifications are recoverable, so trade an fsync per commit for speed.
    db.pragma('synchronous = NORMAL');
    // Never fail a webhook because another writer holds the lock for a moment.
    db.pragma('busy_timeout = 5000');
    db.pragma('foreign_keys = ON');
  }
  return db;
}

function tableExists(database: Database.Database, table: string): boolean {
  return Boolean(
    database.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(table)
  );
}

function columnNames(database: Database.Database, table: string): Set<string> {
  const rows = database.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>;
  return new Set(rows.map((row) => row.name));
}

export interface ConfigRow {
  id: number;
  discord_token: string;
}

export interface GuildRow {
  id: string;
  name: string | null;
  icon: string | null;
  notify_channel_id: string | null;
  message_template: string | null;
  enabled: number;
  created_at: string;
  updated_at: string;
}

/** One row per YouTube channel, shared by every guild watching it. */
export interface SourceRow {
  id: string;
  channel_id: string;
  title: string | null;
  subscription_state: string | null;
  lease_expires_at: string | null;
  last_subscribed_at: string | null;
  last_verified_at: string | null;
  last_push_at: string | null;
  last_polled_at: string | null;
  last_error: string | null;
  created_at: string;
}

/** A guild's interest in a source. */
export interface WatchRow {
  id: string;
  guild_id: string;
  source_id: string;
  channel_url: string;
  created_at: string;
}

export interface WatchWithSource extends WatchRow {
  channel_id: string;
  title: string | null;
  subscription_state: string | null;
  lease_expires_at: string | null;
  last_push_at: string | null;
  last_error: string | null;
  last_notified_at: string | null;
}

export function initializeDatabase(): void {
  const database = getDatabase();

  // Global bot identity. Everything else that used to live here is per-guild.
  database.exec(`
    CREATE TABLE IF NOT EXISTS config (
      id INTEGER PRIMARY KEY,
      discord_token TEXT NOT NULL,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );
  `);

  database.exec(`
    CREATE TABLE IF NOT EXISTS guilds (
      id TEXT PRIMARY KEY,
      name TEXT,
      icon TEXT,
      notify_channel_id TEXT,
      message_template TEXT,
      enabled INTEGER NOT NULL DEFAULT 1,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );
  `);

  // The WebSub subscription belongs to the YouTube channel, not to any one
  // guild — ten guilds watching the same creator share a single lease.
  database.exec(`
    CREATE TABLE IF NOT EXISTS youtube_sources (
      id TEXT PRIMARY KEY,
      channel_id TEXT NOT NULL UNIQUE,
      title TEXT,
      subscription_state TEXT DEFAULT 'pending',
      lease_expires_at DATETIME,
      last_subscribed_at DATETIME,
      last_verified_at DATETIME,
      last_push_at DATETIME,
      last_polled_at DATETIME,
      last_error TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );
  `);

  database.exec(`
    CREATE TABLE IF NOT EXISTS watches (
      id TEXT PRIMARY KEY,
      guild_id TEXT NOT NULL REFERENCES guilds(id) ON DELETE CASCADE,
      source_id TEXT NOT NULL REFERENCES youtube_sources(id) ON DELETE CASCADE,
      channel_url TEXT NOT NULL,
      last_notified_at DATETIME,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      UNIQUE (guild_id, source_id)
    );
  `);

  // Dedupe is per watch: the same upload legitimately goes to every guild
  // watching that creator, but only once each.
  database.exec(`
    CREATE TABLE IF NOT EXISTS video_history (
      id TEXT PRIMARY KEY,
      watch_id TEXT NOT NULL REFERENCES watches(id) ON DELETE CASCADE,
      video_id TEXT NOT NULL,
      title TEXT,
      source TEXT,
      sent_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      UNIQUE (watch_id, video_id)
    );
  `);

  database.exec(`
    CREATE TABLE IF NOT EXISTS sessions (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      username TEXT,
      avatar TEXT,
      guild_ids TEXT NOT NULL DEFAULT '[]',
      expires_at DATETIME NOT NULL,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );
  `);

  database.exec(`
    CREATE INDEX IF NOT EXISTS idx_watches_source ON watches(source_id);
    CREATE INDEX IF NOT EXISTS idx_video_history_sent_at ON video_history(sent_at DESC);
    CREATE INDEX IF NOT EXISTS idx_sessions_expires ON sessions(expires_at);
  `);

  migrateFromSingleGuild(database);
  reconcileSubscriptionLabels(database);

  database.prepare('DELETE FROM sessions WHERE expires_at < ?').run(new Date().toISOString());

  // The WAL grew to megabytes against a small database because nothing ever
  // checkpointed it while the process stayed up.
  checkpointTimer = setInterval(() => {
    try {
      getDatabase().pragma('wal_checkpoint(TRUNCATE)');
    } catch (error) {
      log.warn('WAL checkpoint failed', error);
    }
  }, 6 * 60 * 60 * 1000);
  checkpointTimer.unref();

  log.info(`Database ready at ${dbPath}`);
}

/**
 * Carries a pre-multi-server database forward.
 *
 * The old schema held one Discord channel and one message template in `config`
 * and a flat `youtube_channels` table with no notion of a guild. Everything is
 * folded into the guild named by DISCORD_GUILD_ID (or the legacy channel's
 * guild, resolved at first connect), so an existing deployment keeps its
 * channels and, critically, its send history — otherwise every past upload
 * would look new and be re-announced.
 */
function migrateFromSingleGuild(database: Database.Database): void {
  if (!tableExists(database, 'youtube_channels')) {
    return;
  }
  const legacy = database.prepare('SELECT COUNT(*) AS n FROM youtube_channels').get() as {
    n: number;
  };
  if (legacy.n === 0) {
    return;
  }
  if (!columnNames(database, 'config').has('discord_channel_id')) {
    return;
  }

  const oldConfig = database
    .prepare('SELECT * FROM config ORDER BY id DESC LIMIT 1')
    .get() as Record<string, string> | undefined;
  const guildId = process.env.DISCORD_GUILD_ID || process.env.LEGACY_GUILD_ID;

  if (!guildId) {
    log.warn(
      'Legacy single-server data found but DISCORD_GUILD_ID is not set; skipping migration. ' +
        'Set it to the server those channels belong to and restart.'
    );
    return;
  }

  const run = database.transaction(() => {
    database
      .prepare(
        `INSERT INTO guilds (id, notify_channel_id, message_template)
         VALUES (?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET
           notify_channel_id = COALESCE(guilds.notify_channel_id, excluded.notify_channel_id),
           message_template = COALESCE(guilds.message_template, excluded.message_template)`
      )
      .run(guildId, oldConfig?.discord_channel_id || null, oldConfig?.message_template || null);

    const rows = database.prepare('SELECT * FROM youtube_channels').all() as Array<
      Record<string, any>
    >;

    for (const row of rows) {
      const sourceId = row.id as string;
      database
        .prepare(
          `INSERT INTO youtube_sources
             (id, channel_id, title, subscription_state, lease_expires_at, last_subscribed_at,
              last_verified_at, last_push_at, last_polled_at, last_error, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT(channel_id) DO NOTHING`
        )
        .run(
          sourceId,
          row.channel_name,
          row.channel_title ?? null,
          row.subscription_state ?? 'pending',
          row.lease_expires_at ?? null,
          row.last_subscribed_at ?? null,
          row.last_verified_at ?? null,
          row.last_push_at ?? null,
          row.last_polled_at ?? null,
          row.last_error ?? null,
          row.created_at ?? null
        );

      const source = database
        .prepare('SELECT id FROM youtube_sources WHERE channel_id = ?')
        .get(row.channel_name) as { id: string } | undefined;
      if (!source) {
        continue;
      }

      // The watch id deliberately reuses the old channel row id, so the old
      // video_history rows keep pointing at the right thing.
      database
        .prepare(
          `INSERT INTO watches (id, guild_id, source_id, channel_url, last_notified_at, created_at)
           VALUES (?, ?, ?, ?, ?, ?)
           ON CONFLICT(guild_id, source_id) DO NOTHING`
        )
        .run(
          sourceId,
          guildId,
          source.id,
          row.channel_url ?? '',
          row.last_notified_at ?? null,
          row.created_at ?? null
        );
    }

    // Re-home the old history onto the new watches, preserving dedupe.
    if (columnNames(database, 'video_history').has('channel_id')) {
      database.exec(`
        INSERT OR IGNORE INTO video_history (id, watch_id, video_id, title, source, sent_at)
        SELECT v.id, v.channel_id, v.video_id, v.title, v.source, v.sent_at
        FROM video_history_legacy v
        WHERE EXISTS (SELECT 1 FROM watches w WHERE w.id = v.channel_id);
      `);
    }

    database.exec('ALTER TABLE youtube_channels RENAME TO youtube_channels_legacy;');
  });

  // The old video_history has an incompatible shape, so it is set aside under a
  // legacy name first and copied across inside the transaction above.
  if (columnNames(database, 'video_history').has('channel_id')) {
    database.exec('ALTER TABLE video_history RENAME TO video_history_legacy;');
    database.exec(`
      CREATE TABLE video_history (
        id TEXT PRIMARY KEY,
        watch_id TEXT NOT NULL REFERENCES watches(id) ON DELETE CASCADE,
        video_id TEXT NOT NULL,
        title TEXT,
        source TEXT,
        sent_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        UNIQUE (watch_id, video_id)
      );
    `);
  }

  run();
  log.info(`Migrated ${legacy.n} legacy channel(s) into guild ${guildId}`);
}

/**
 * A live, hub-confirmed lease is 'verified'; 'active' additionally means a push
 * has been seen. Realigning on boot also clears labels left behind by a
 * throttled renewal attempt.
 */
function reconcileSubscriptionLabels(database: Database.Database): void {
  database
    .prepare(
      `UPDATE youtube_sources
       SET subscription_state = CASE
             WHEN last_push_at IS NOT NULL THEN 'active'
             WHEN subscription_state = 'degraded' THEN 'degraded'
             ELSE 'verified'
           END
       WHERE lease_expires_at IS NOT NULL AND lease_expires_at > ?`
    )
    .run(new Date().toISOString());
}

export function closeDatabase(): void {
  if (checkpointTimer) {
    clearInterval(checkpointTimer);
    checkpointTimer = undefined;
  }
  if (db) {
    try {
      db.pragma('wal_checkpoint(TRUNCATE)');
    } catch {
      /* best effort on shutdown */
    }
    db.close();
    db = undefined;
  }
}

export function getConfig(): ConfigRow | undefined {
  return getDatabase().prepare('SELECT * FROM config ORDER BY id DESC LIMIT 1').get() as
    | ConfigRow
    | undefined;
}

export function getBotToken(): string | undefined {
  return getConfig()?.discord_token || process.env.DISCORD_BOT_TOKEN || undefined;
}

export function getGuild(guildId: string): GuildRow | undefined {
  return getDatabase().prepare('SELECT * FROM guilds WHERE id = ?').get(guildId) as
    | GuildRow
    | undefined;
}

export function upsertGuild(guildId: string, name?: string | null, icon?: string | null): GuildRow {
  const database = getDatabase();
  database
    .prepare(
      `INSERT INTO guilds (id, name, icon) VALUES (?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET
         name = COALESCE(excluded.name, guilds.name),
         icon = COALESCE(excluded.icon, guilds.icon),
         updated_at = CURRENT_TIMESTAMP`
    )
    .run(guildId, name ?? null, icon ?? null);
  return getGuild(guildId) as GuildRow;
}

export function listWatches(guildId: string): WatchWithSource[] {
  return getDatabase()
    .prepare(
      `SELECT w.*, s.channel_id, s.title, s.subscription_state, s.lease_expires_at,
              s.last_push_at, s.last_error
       FROM watches w
       JOIN youtube_sources s ON s.id = w.source_id
       WHERE w.guild_id = ?
       ORDER BY w.created_at DESC`
    )
    .all(guildId) as WatchWithSource[];
}

/** Every guild watching a given YouTube channel, with its delivery settings. */
export function watchersOf(youtubeChannelId: string): Array<WatchRow & { guild: GuildRow }> {
  const rows = getDatabase()
    .prepare(
      `SELECT w.*, g.id AS g_id, g.name AS g_name, g.icon AS g_icon,
              g.notify_channel_id AS g_notify, g.message_template AS g_template,
              g.enabled AS g_enabled, g.created_at AS g_created, g.updated_at AS g_updated
       FROM watches w
       JOIN youtube_sources s ON s.id = w.source_id
       JOIN guilds g ON g.id = w.guild_id
       WHERE s.channel_id = ? AND g.enabled = 1`
    )
    .all(youtubeChannelId) as Array<Record<string, any>>;

  return rows.map((row) => ({
    id: row.id,
    guild_id: row.guild_id,
    source_id: row.source_id,
    channel_url: row.channel_url,
    created_at: row.created_at,
    guild: {
      id: row.g_id,
      name: row.g_name,
      icon: row.g_icon,
      notify_channel_id: row.g_notify,
      message_template: row.g_template,
      enabled: row.g_enabled,
      created_at: row.g_created,
      updated_at: row.g_updated,
    },
  }));
}

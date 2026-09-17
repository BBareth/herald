import { Router, Request, Response } from 'express';
import { SourceRow, getBotToken, getDatabase } from '../database/db';
import { connectedAs, isConnected } from '../services/discord';
import {
  getLastSweepAt,
  getCallbackUrl,
  syncSubscriptions,
  websubConfigured,
} from '../services/websub';
import { getPollerStatus, pollAllSources } from '../services/poller';
import { lastNotificationAt } from '../services/notifier';
import { getLastPushAt } from './websub';
import { authEnabled } from '../services/auth';

export const statusRouter = Router();

const startedAt = Date.now();

// A single view of "is this thing actually working?". The failure this project
// was built around — every WebSub lease silently expiring — was invisible until
// you went and asked Google's hub directly.
statusRouter.get('/', (req: Request, res: Response) => {
  const db = getDatabase();
  const now = Date.now();

  // Scoped to one server when asked, so a server admin sees only their own.
  const guildId = typeof req.query.guildId === 'string' ? req.query.guildId : null;

  const sources = (
    guildId
      ? db
          .prepare(
            `SELECT s.* FROM youtube_sources s
             JOIN watches w ON w.source_id = s.id
             WHERE w.guild_id = ?`
          )
          .all(guildId)
      : db.prepare('SELECT * FROM youtube_sources').all()
  ) as SourceRow[];

  const pushEnabled = websubConfigured();

  const subscriptions = sources.map((source) => {
    const expiresAt = source.lease_expires_at ? Date.parse(source.lease_expires_at) : null;
    const leaseValid = expiresAt !== null && !Number.isNaN(expiresAt) && expiresAt > now;
    const expired = expiresAt !== null && !Number.isNaN(expiresAt) && expiresAt <= now;

    // Derived from evidence rather than the stored label:
    //   active   - a push has actually been delivered
    //   verified - lease is live and the hub confirmed it; nothing uploaded
    //              since to prove delivery, which is normal for a quiet channel
    //   degraded - lease is live but an upload demonstrably bypassed it
    const state = !pushEnabled
      ? 'polling'
      : leaseValid
      ? source.last_push_at
        ? 'active'
        : source.subscription_state === 'degraded'
        ? 'degraded'
        : 'verified'
      : expired
      ? 'expired'
      : source.subscription_state || 'unknown';

    return {
      id: source.id,
      channelId: source.channel_id,
      title: source.title || source.channel_id,
      state,
      leaseExpiresAt: source.lease_expires_at,
      lastVerifiedAt: source.last_verified_at,
      lastPushAt: source.last_push_at,
      lastPolledAt: source.last_polled_at,
      lastError: source.last_error,
    };
  });

  const recent = (
    guildId
      ? db
          .prepare(
            `SELECT v.video_id, v.title, v.source, v.sent_at, s.title AS channel_title
             FROM video_history v
             JOIN watches w ON w.id = v.watch_id
             JOIN youtube_sources s ON s.id = w.source_id
             WHERE v.source != 'baseline' AND w.guild_id = ?
             ORDER BY v.sent_at DESC LIMIT 15`
          )
          .all(guildId)
      : db
          .prepare(
            `SELECT v.video_id, v.title, v.source, v.sent_at, s.title AS channel_title
             FROM video_history v
             JOIN watches w ON w.id = v.watch_id
             JOIN youtube_sources s ON s.id = w.source_id
             WHERE v.source != 'baseline'
             ORDER BY v.sent_at DESC LIMIT 15`
          )
          .all()
  ) as unknown[];

  res.json({
    uptimeSeconds: Math.round((now - startedAt) / 1000),
    authEnabled: authEnabled(),
    discord: {
      connected: isConnected(),
      tag: connectedAs(),
      tokenConfigured: Boolean(getBotToken()),
    },
    websub: {
      enabled: pushEnabled,
      callbackUrl: pushEnabled ? getCallbackUrl() : null,
      lastSweepAt: getLastSweepAt(),
      lastPushAt: getLastPushAt(),
      healthy: subscriptions.filter(
        (s) => s.state === 'active' || s.state === 'verified' || s.state === 'polling'
      ).length,
      active: subscriptions.filter((s) => s.state === 'active').length,
      degraded: subscriptions.filter((s) => s.state === 'degraded').length,
      total: subscriptions.length,
    },
    poller: getPollerStatus(),
    lastNotificationAt: lastNotificationAt(),
    subscriptions,
    recent,
  });
});

statusRouter.post('/resubscribe-all', async (_req: Request, res: Response) => {
  const result = await syncSubscriptions(true);
  res.json({ success: true, ...result });
});

statusRouter.post('/poll-now', async (_req: Request, res: Response) => {
  const result = await pollAllSources();
  res.json({ success: true, ...result });
});

import express, { Router, Request, Response } from 'express';
import crypto from 'crypto';
import { SourceRow, getDatabase } from '../database/db';
import { extractTopicChannelId, parseFeedEntries } from '../services/feed';
import { fanOut } from '../services/notifier';
import { recordPushDelivery, recordVerification } from '../services/websub';
import { createLogger } from '../util/logger';

const log = createLogger('websub-cb');

export const websubRouter = Router();

let lastPushAt: string | null = null;

export function getLastPushAt(): string | null {
  return lastPushAt;
}

function topicChannelIdFromUrl(topic: string): string {
  return topic.match(/channel_id=([\w-]+)/i)?.[1] || '';
}

// GET is the hub's subscription verification handshake.
websubRouter.get('/callback', (req: Request, res: Response) => {
  const mode = String(req.query['hub.mode'] || '');
  const topic = String(req.query['hub.topic'] || '');
  const challenge = String(req.query['hub.challenge'] || '');
  const verifyToken = String(req.query['hub.verify_token'] || '');
  const leaseSeconds = Number(req.query['hub.lease_seconds']) || null;

  const expectedToken = process.env.WEBSUB_VERIFY_TOKEN;
  if (!expectedToken) {
    log.error('WEBSUB_VERIFY_TOKEN is not set');
    return res.status(500).send('Server misconfigured: WEBSUB_VERIFY_TOKEN not set');
  }

  const expected = Buffer.from(expectedToken);
  const received = Buffer.from(verifyToken);
  if (expected.length !== received.length || !crypto.timingSafeEqual(expected, received)) {
    log.warn(`Rejected verification with bad token for topic ${topic}`);
    return res.status(403).send('Invalid verify token');
  }

  if (!challenge) {
    return res.status(400).send('Missing challenge');
  }

  const channelId = topicChannelIdFromUrl(topic);
  if (channelId) {
    // Recording the hub's own lease length is what lets the renewal loop act
    // before expiry instead of on a blind timer.
    recordVerification(channelId, mode, leaseSeconds);
  }

  log.info(
    `Verified ${mode} for ${channelId || topic}${leaseSeconds ? ` (lease ${leaseSeconds}s)` : ''}`
  );
  return res.status(200).type('text/plain').send(challenge);
});

// POST carries the Atom payload for a new (or edited) upload.
websubRouter.post(
  '/callback',
  express.raw({ type: () => true, limit: '4mb' }),
  async (req: Request, res: Response) => {
    try {
      // HMAC must be computed over the exact bytes received, so the body stays
      // a Buffer rather than a charset-decoded string.
      const raw: Buffer = Buffer.isBuffer(req.body) ? req.body : Buffer.from(String(req.body || ''));
      if (raw.length === 0) {
        return res.status(400).json({ error: 'Empty payload' });
      }

      const secret = process.env.WEBSUB_SECRET;
      if (!secret) {
        log.error('WEBSUB_SECRET is not set');
        return res.status(500).json({ error: 'Server misconfigured: WEBSUB_SECRET not set' });
      }

      const sha256Header = req.headers['x-hub-signature-256'];
      const sha1Header = req.headers['x-hub-signature'];
      const signatureHeader =
        (typeof sha256Header === 'string' && sha256Header) ||
        (typeof sha1Header === 'string' && sha1Header) ||
        '';

      if (!signatureHeader) {
        log.warn('Rejected push without a signature header');
        return res.status(403).json({ error: 'Missing signature' });
      }

      const algorithm = signatureHeader.startsWith('sha256=') ? 'sha256' : 'sha1';
      const expected = Buffer.from(
        `${algorithm}=${crypto.createHmac(algorithm, secret).update(raw).digest('hex')}`
      );
      const received = Buffer.from(signatureHeader);
      if (expected.length !== received.length || !crypto.timingSafeEqual(expected, received)) {
        log.warn('Rejected push with an invalid signature');
        return res.status(403).json({ error: 'Invalid signature' });
      }

      // Acknowledge before doing any work: the hub gives callbacks a short
      // timeout and counts a slow response as a delivery failure.
      res.status(204).send();
      lastPushAt = new Date().toISOString();

      const payload = raw.toString('utf8');
      const entries = parseFeedEntries(payload);
      if (entries.length === 0) {
        return;
      }

      const seen = new Set<string>();
      const db = getDatabase();
      const findSource = db.prepare('SELECT * FROM youtube_sources WHERE channel_id = ? LIMIT 1');
      const topicChannelId = extractTopicChannelId(payload);

      for (const entry of entries) {
        const key = `${entry.channelId}:${entry.videoId}`;
        if (seen.has(key)) {
          continue;
        }
        seen.add(key);

        // Match on the entry's channelId, then fall back to the subscription
        // topic's channelId (collaboration videos credit a collaborator rather
        // than the channel we actually subscribed to).
        let source = findSource.get(entry.channelId) as SourceRow | undefined;
        if (!source && topicChannelId && topicChannelId !== entry.channelId) {
          source = findSource.get(topicChannelId) as SourceRow | undefined;
          if (source) {
            log.info(
              `Matched ${entry.videoId} via topic channel ${topicChannelId} (entry said ${entry.channelId})`
            );
          }
        }

        if (!source) {
          log.debug(`Ignoring ${entry.videoId} from unmonitored channel ${entry.channelId}`);
          continue;
        }

        // Record delivery before the dedupe check: a repeat push for a video we
        // already have still proves the subscription is live.
        recordPushDelivery(source.channel_id);

        // One upload, every guild watching that creator.
        const result = await fanOut(source.channel_id, entry, source.title, 'websub');
        if (result.sent > 0) {
          log.info(`Fanned ${entry.videoId} out to ${result.sent} guild(s)`);
        }
      }
    } catch (error) {
      log.error('Callback processing failed', error);
      if (!res.headersSent) {
        res.status(500).json({ error: 'Failed to process webhook' });
      }
    }
  }
);

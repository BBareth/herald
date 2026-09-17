import { SourceRow, getDatabase } from '../database/db';
import { createLogger } from '../util/logger';

const log = createLogger('websub');

const HUB_URL = process.env.WEBSUB_HUB_URL || 'https://pubsubhubbub.appspot.com/subscribe';

// Google's hub answers a large share of subscribe requests with
// `503 Transient error; please try again later`. The previous implementation
// fired once per channel every 12 hours and gave up on the first failure, so
// leases quietly expired and pushes stopped arriving.
const MAX_ATTEMPTS = Number(process.env.WEBSUB_MAX_ATTEMPTS || 5);
const BASE_BACKOFF_MS = Number(process.env.WEBSUB_BASE_BACKOFF_MS || 4_000);
// The hub answers 503 with `Retry-After: 120`. Waiting less than it asks just
// earns another 503, so honour the header — but only up to this cap. A longer
// ask means "come back later", which is the sweep's job, not this loop's.
const MAX_BACKOFF_MS = Number(process.env.WEBSUB_MAX_BACKOFF_MS || 60_000);
const REQUEST_SPACING_MS = Number(process.env.WEBSUB_REQUEST_SPACING_MS || 2_000);

// How often the renewal loop wakes up, and how long before a lease expires we
// start trying to renew it.
const SWEEP_INTERVAL_MS = Number(process.env.WEBSUB_SWEEP_INTERVAL_MS || 5 * 60 * 1000);
const RENEW_MARGIN_MS = Number(process.env.WEBSUB_RENEW_MARGIN_MS || 24 * 60 * 60 * 1000);
// Fallback when the hub never told us a lease length.
const ASSUMED_LEASE_MS = Number(process.env.WEBSUB_ASSUMED_LEASE_MS || 5 * 24 * 60 * 60 * 1000);
const HUB_TIMEOUT_MS = Number(process.env.WEBSUB_HUB_TIMEOUT_MS || 45_000);
// A channel that simply has not uploaded cannot prove its subscription works,
// and re-requesting it on a timer achieved nothing but load: 663 handshakes in
// 54 hours. Renewal is now driven by the lease, and by evidence of an actually
// missed push (see the poller), not by the absence of uploads.

let sweepTimer: NodeJS.Timeout | undefined;
let sweepRunning = false;
let lastSweepAt: string | null = null;

export function getLastSweepAt(): string | null {
  return lastSweepAt;
}

export function buildTopicUrl(channelId: string): string {
  return `https://www.youtube.com/xml/feeds/videos.xml?channel_id=${channelId}`;
}

/**
 * Push needs a public HTTPS callback that Google can reach. Plenty of
 * self-hosters have no such URL, and for them the feed poller is the whole
 * delivery path — so the hub is never contacted and nothing is reported as
 * broken for a feature that was never switched on.
 */
export function websubConfigured(): boolean {
  return Boolean(
    process.env.WEBSUB_CALLBACK_BASE_URL &&
      process.env.WEBSUB_VERIFY_TOKEN &&
      process.env.WEBSUB_SECRET
  );
}

export function getCallbackUrl(): string {
  const baseUrl = (process.env.WEBSUB_CALLBACK_BASE_URL || 'http://localhost:3001').replace(/\/$/, '');
  return `${baseUrl}/api/websub/callback`;
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

function isRetryable(status: number): boolean {
  return status === 429 || status === 408 || status >= 500;
}

/** Retry-After is either a delay in seconds or an HTTP date. */
function parseRetryAfter(header: string | null): number | null {
  if (!header) {
    return null;
  }
  const seconds = Number(header.trim());
  if (Number.isFinite(seconds) && seconds >= 0) {
    return seconds * 1000;
  }
  const when = Date.parse(header);
  return Number.isNaN(when) ? null : Math.max(0, when - Date.now());
}

async function postToHub(mode: 'subscribe' | 'unsubscribe', channelId: string): Promise<void> {
  const params = new URLSearchParams();
  params.set('hub.mode', mode);
  params.set('hub.topic', buildTopicUrl(channelId));
  params.set('hub.callback', getCallbackUrl());
  params.set('hub.verify', 'async');

  if (process.env.WEBSUB_VERIFY_TOKEN) {
    params.set('hub.verify_token', process.env.WEBSUB_VERIFY_TOKEN);
  }
  if (process.env.WEBSUB_SECRET) {
    params.set('hub.secret', process.env.WEBSUB_SECRET);
  }
  if (mode === 'subscribe' && process.env.WEBSUB_LEASE_SECONDS) {
    params.set('hub.lease_seconds', process.env.WEBSUB_LEASE_SECONDS);
  }

  let lastError = '';

  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    try {
      const response = await fetch(HUB_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: params.toString(),
        signal: AbortSignal.timeout(HUB_TIMEOUT_MS),
      });

      if (response.ok) {
        if (attempt > 1) {
          log.info(`${mode} for ${channelId} succeeded on attempt ${attempt}`);
        }
        return;
      }

      const body = (await response.text()).trim().slice(0, 200);
      const retryAfterMs = parseRetryAfter(response.headers.get('retry-after'));
      lastError = `HTTP ${response.status}: ${body}`;

      if (!isRetryable(response.status) || attempt === MAX_ATTEMPTS) {
        throw new Error(`WebSub ${mode} failed (${lastError})`);
      }

      // The hub is shedding load for longer than we are willing to sit here.
      // Give up this pass; the renewal sweep comes back on its own schedule.
      if (retryAfterMs !== null && retryAfterMs > MAX_BACKOFF_MS) {
        throw new Error(
          `WebSub ${mode} deferred (${lastError}; hub asked for ${Math.round(retryAfterMs / 1000)}s)`
        );
      }

      if (retryAfterMs !== null) {
        log.warn(`${mode} for ${channelId} throttled; honouring Retry-After ${retryAfterMs}ms`);
        await sleep(retryAfterMs);
        continue;
      }
    } catch (error) {
      if (error instanceof Error && error.message.startsWith('WebSub ')) {
        throw error;
      }
      lastError = error instanceof Error ? error.message : String(error);
      if (attempt === MAX_ATTEMPTS) {
        throw new Error(`WebSub ${mode} failed (${lastError})`);
      }
    }

    // Exponential backoff with jitter, so five channels do not retry in lockstep.
    const delay = Math.min(
      BASE_BACKOFF_MS * 2 ** (attempt - 1) + Math.floor(Math.random() * 1_000),
      MAX_BACKOFF_MS
    );
    log.warn(`${mode} for ${channelId} failed (${lastError}); retrying in ${delay}ms`);
    await sleep(delay);
  }

  throw new Error(`WebSub ${mode} failed (${lastError})`);
}

function markSubscribeAttempt(channelId: string, error: string | null): void {
  // State describes the subscription, not the last request. A channel holding a
  // live lease must not drop to 'failed' just because one renewal nudge was
  // throttled — otherwise the badge flaps on every sweep.
  const nowIso = new Date().toISOString();
  getDatabase()
    .prepare(
      `UPDATE youtube_sources
       SET last_subscribed_at = CURRENT_TIMESTAMP,
           last_error = ?,
           subscription_state = CASE
             WHEN lease_expires_at IS NOT NULL AND lease_expires_at > ?
               THEN CASE
                 WHEN last_push_at IS NOT NULL THEN 'active'
                 WHEN subscription_state = 'degraded' THEN 'degraded'
                 ELSE 'verified'
               END
             WHEN ? IS NULL THEN 'pending'
             ELSE 'failed'
           END
       WHERE channel_id = ?`
    )
    .run(error, nowIso, error, channelId);
}

export async function subscribeToChannel(channelId: string): Promise<void> {
  if (!websubConfigured()) {
    getDatabase()
      .prepare(
        `UPDATE youtube_sources SET subscription_state = 'polling', last_error = NULL
         WHERE channel_id = ?`
      )
      .run(channelId);
    return;
  }
  try {
    await postToHub('subscribe', channelId);
    markSubscribeAttempt(channelId, null);
    log.info(`Subscribe requested for ${channelId}`);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    markSubscribeAttempt(channelId, message);
    throw error;
  }
}

export async function unsubscribeFromChannel(channelId: string): Promise<void> {
  if (!websubConfigured()) {
    return;
  }
  await postToHub('unsubscribe', channelId);
  log.info(`Unsubscribe requested for ${channelId}`);
}

/** Called from the callback route when the hub confirms a subscription. */
export function recordVerification(
  channelId: string,
  mode: string,
  leaseSeconds: number | null
): void {
  if (mode === 'unsubscribe') {
    getDatabase()
      .prepare(
        `UPDATE youtube_sources
         SET subscription_state = 'unsubscribed', lease_expires_at = NULL
         WHERE channel_id = ?`
      )
      .run(channelId);
    return;
  }

  const expiresAt = new Date(
    Date.now() + (leaseSeconds && leaseSeconds > 0 ? leaseSeconds * 1000 : ASSUMED_LEASE_MS)
  ).toISOString();

  // A fresh handshake clears a 'degraded' mark: the subscription has just been
  // re-established, so it deserves another chance to prove itself.
  getDatabase()
    .prepare(
      `UPDATE youtube_sources
       SET subscription_state = CASE WHEN last_push_at IS NOT NULL THEN 'active' ELSE 'verified' END,
           lease_expires_at = ?,
           last_verified_at = CURRENT_TIMESTAMP,
           last_error = NULL
       WHERE channel_id = ?`
    )
    .run(expiresAt, channelId);
}

/**
 * Called when a signed push actually arrives for a channel. This is the only
 * positive proof that a subscription is genuinely live, so it is what promotes
 * a channel to 'active' and clears any 'degraded' mark.
 */
export function recordPushDelivery(channelId: string): void {
  getDatabase()
    .prepare(
      `UPDATE youtube_sources
       SET subscription_state = 'active',
           last_push_at = CURRENT_TIMESTAMP,
           last_error = NULL
       WHERE channel_id = ?`
    )
    .run(channelId);
}

function parseSqlTime(value: string | null): number {
  if (!value) {
    return NaN;
  }
  // SQLite CURRENT_TIMESTAMP has no zone marker but is always UTC.
  return Date.parse(
    /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(value) ? `${value.replace(' ', 'T')}Z` : value
  );
}

/**
 * Records that an upload arrived via polling which a live subscription should
 * have pushed. This is the only reliable evidence that push is broken for a
 * channel, as opposed to merely unproven.
 */
export function recordMissedPush(channelId: string, detail: string): void {
  getDatabase()
    .prepare(
      `UPDATE youtube_sources
       SET subscription_state = 'degraded', last_error = ?
       WHERE channel_id = ? AND last_push_at IS NULL`
    )
    .run(detail, channelId);
  log.warn(`${channelId}: ${detail}`);
}

function needsRenewal(source: SourceRow): boolean {
  const expiresAt = parseSqlTime(source.lease_expires_at);

  // No usable lease at all — always worth asking.
  if (Number.isNaN(expiresAt)) {
    return true;
  }

  // Lease is running out.
  if (expiresAt - Date.now() <= RENEW_MARGIN_MS) {
    return true;
  }

  // The poller caught an upload that push should have delivered, so the lease
  // is live but the subscription is not working. Re-request it.
  if (source.subscription_state === 'degraded') {
    return true;
  }

  return false;
}

/**
 * Renews every subscription whose lease is missing or close to expiring.
 * Requests are spaced out because the hub throttles bursts from one subscriber.
 */
export async function syncSubscriptions(force = false): Promise<{ renewed: number; failed: number }> {
  if (sweepRunning || !websubConfigured()) {
    return { renewed: 0, failed: 0 };
  }
  sweepRunning = true;

  try {
    const sources = getDatabase().prepare('SELECT * FROM youtube_sources').all() as SourceRow[];
    const due = sources.filter((source) => source.channel_id && (force || needsRenewal(source)));

    let renewed = 0;
    let failed = 0;

    for (const [index, source] of due.entries()) {
      if (index > 0) {
        await sleep(REQUEST_SPACING_MS);
      }
      try {
        await subscribeToChannel(source.channel_id);
        renewed++;
      } catch (error) {
        failed++;
        log.error(`Could not renew ${source.channel_id}`, error);
      }
    }

    lastSweepAt = new Date().toISOString();
    if (due.length > 0) {
      log.info(`Subscription sweep: ${renewed} renewed, ${failed} failed, ${sources.length} total`);
    }
    return { renewed, failed };
  } finally {
    sweepRunning = false;
  }
}

export function startWebSubRenewalJob(): void {
  if (!websubConfigured()) {
    log.info(
      'WEBSUB_CALLBACK_BASE_URL/VERIFY_TOKEN/SECRET not all set — push is off, the feed poller is the only delivery path'
    );
    return;
  }

  setTimeout(() => {
    syncSubscriptions().catch((error) => log.error('Initial subscription sync failed', error));
  }, 3_000).unref();

  sweepTimer = setInterval(() => {
    syncSubscriptions().catch((error) => log.error('Subscription sweep failed', error));
  }, SWEEP_INTERVAL_MS);
  sweepTimer.unref();

  log.info(
    `Renewal loop every ${Math.round(SWEEP_INTERVAL_MS / 60000)}m, renewing ${Math.round(
      RENEW_MARGIN_MS / 3600000
    )}h before lease expiry`
  );
}

export function stopWebSubRenewalJob(): void {
  if (sweepTimer) {
    clearInterval(sweepTimer);
    sweepTimer = undefined;
  }
}

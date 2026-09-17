import React from 'react';

export interface Subscription {
  id: string;
  channelId: string;
  title: string;
  state: string;
  leaseExpiresAt: string | null;
  lastVerifiedAt: string | null;
  lastPushAt: string | null;
  lastPolledAt: string | null;
  lastError: string | null;
}

export interface RecentVideo {
  video_id: string;
  title: string | null;
  source: string | null;
  sent_at: string;
  channel_title: string | null;
}

export interface Status {
  uptimeSeconds: number;
  authEnabled: boolean;
  discord: { connected: boolean; tag: string | null; tokenConfigured: boolean };
  websub: {
    enabled: boolean;
    callbackUrl: string | null;
    lastSweepAt: string | null;
    lastPushAt: string | null;
    healthy: number;
    active: number;
    degraded: number;
    total: number;
  };
  poller: { enabled: boolean; intervalMs: number; lastPollAt: string | null; lastPollFound: number };
  lastNotificationAt: string | null;
  subscriptions: Subscription[];
  recent: RecentVideo[];
}

export function relativeTime(value: string | null): string {
  if (!value) {
    return 'never';
  }
  // SQLite CURRENT_TIMESTAMP has no zone marker but is always UTC.
  const normalized = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(value)
    ? `${value.replace(' ', 'T')}Z`
    : value;
  const then = Date.parse(normalized);
  if (Number.isNaN(then)) {
    return value;
  }

  const seconds = Math.round((Date.now() - then) / 1000);
  const abs = Math.abs(seconds);

  const steps: Array<[number, string]> = [
    [86400, 'day'],
    [3600, 'hour'],
    [60, 'minute'],
  ];

  let text = `${abs}s`;
  for (const [size, unit] of steps) {
    if (abs >= size) {
      const n = Math.round(abs / size);
      text = `${n} ${unit}${n === 1 ? '' : 's'}`;
      break;
    }
  }

  return seconds < 0 ? `in ${text}` : `${text} ago`;
}

function uptimeText(seconds: number): string {
  if (seconds < 60) return `${seconds}s`;
  if (seconds < 3600) return `${Math.round(seconds / 60)}m`;
  if (seconds < 86400) return `${(seconds / 3600).toFixed(1)}h`;
  return `${(seconds / 86400).toFixed(1)}d`;
}

const STATE_HELP: Record<string, string> = {
  active: 'Working — the hub has delivered at least one push on this subscription.',
  polling:
    'Push is switched off (no public callback URL configured), so uploads arrive through the feed poller instead.',
  verified:
    'Subscribed. The hub confirmed the lease, and nothing has been uploaded since, so there has been no push to observe yet. This is normal for a quiet channel.',
  degraded:
    'An upload reached Discord by polling that this live subscription should have pushed. Push is not being delivered for this channel; a re-subscribe has been queued.',
  pending: 'A subscribe request has been sent; waiting for the hub to verify.',
  failed: 'The last subscribe request was rejected by the hub.',
  expired: 'The lease has run out and has not been renewed.',
};

function stateBadge(state: string) {
  const cls =
    state === 'polling'
      ? 'badge-idle'
      : state === 'active' || state === 'verified'
      ? 'badge-ok'
      : state === 'expired' || state === 'failed' || state === 'degraded'
      ? 'badge-err'
      : state === 'pending'
      ? 'badge-warn'
      : 'badge-idle';
  return (
    <span className={`badge ${cls}`} title={STATE_HELP[state] || state}>
      {state}
    </span>
  );
}

interface Props {
  status: Status | null;
  busy: string | null;
  onResubscribeAll: () => void;
  onPollNow: () => void;
}

function StatusSection({ status, busy, onResubscribeAll, onPollNow }: Props) {
  if (!status) {
    return (
      <section className="card">
        <div className="section-header">
          <h2>Status</h2>
        </div>
        <p style={{ color: 'var(--text-faint)', margin: 0 }}>Loading…</p>
      </section>
    );
  }

  const { discord, websub, poller } = status;
  const healthy = websub.healthy ?? 0;
  const subsHealthy = websub.total > 0 && healthy === websub.total;

  return (
    <section className="card">
      <div className="section-header">
        <h2>Status</h2>
        <p>Up {uptimeText(status.uptimeSeconds)}</p>
        <div className="spacer" />
        <div className="actions">
          <button className="btn-ghost" onClick={onPollNow} disabled={busy !== null}>
            {busy === 'poll' ? <span className="loading" /> : null} Check feeds now
          </button>
          <button className="btn-ghost" onClick={onResubscribeAll} disabled={busy !== null}>
            {busy === 'resub' ? <span className="loading" /> : null} Resubscribe all
          </button>
        </div>
      </div>

      <div className="status-grid">
        <div className="status-tile">
          <div className="label">Discord</div>
          <div className="value">
            {discord.connected ? (
              <span className="badge badge-ok">online</span>
            ) : (
              <span className="badge badge-err">offline</span>
            )}
          </div>
          <div className="sub">{discord.tag || 'not connected'}</div>
        </div>

        <div className="status-tile">
          <div className="label">Push subscriptions</div>
          <div className="value">
            {websub.enabled ? (
              <>
                {healthy}/{websub.total}{' '}
                {websub.total > 0 && (
                  <span className={`badge ${subsHealthy ? 'badge-ok' : 'badge-err'}`}>
                    {subsHealthy ? 'ok' : 'degraded'}
                  </span>
                )}
              </>
            ) : (
              <span className="badge badge-idle">off</span>
            )}
          </div>
          <div className="sub">
            {websub.enabled ? `last push ${relativeTime(websub.lastPushAt)}` : 'no public callback URL'}
          </div>
        </div>

        <div className="status-tile">
          <div className="label">Feed poller</div>
          <div className="value">
            {poller.enabled ? `${Math.round(poller.intervalMs / 60000)} min` : 'off'}
          </div>
          <div className="sub">last run {relativeTime(poller.lastPollAt)}</div>
        </div>

        <div className="status-tile">
          <div className="label">Last notification</div>
          <div className="value" style={{ fontSize: '15px' }}>
            {relativeTime(status.lastNotificationAt)}
          </div>
          <div className="sub">across all channels</div>
        </div>
      </div>

      {websub.enabled && websub.total > 0 && !subsHealthy && (
        <div className="alert alert-error" style={{ marginTop: '16px', marginBottom: 0 }}>
          {websub.total - healthy} of {websub.total} subscriptions are not currently live
          {websub.degraded > 0 && (
            <>
              , and {websub.degraded} {websub.degraded === 1 ? 'is' : 'are'}{' '}
              <strong>degraded</strong> — an upload reached Discord by polling that push should have
              delivered
            </>
          )}
          . Uploads still arrive via the feed poller; only the low-latency path is affected.
        </div>
      )}

      {status.recent.length > 0 && (
        <div style={{ marginTop: '20px' }}>
          <div className="section-header" style={{ marginBottom: '8px' }}>
            <h2 style={{ fontSize: '13px', color: 'var(--text-muted)' }}>Recently posted</h2>
          </div>
          <div className="recent-list">
            {status.recent.map((item) => (
              <div className="recent-item" key={`${item.video_id}-${item.sent_at}`}>
                <span className="source-tag">{item.source || '?'}</span>
                <span className="title">
                  <a
                    href={`https://www.youtube.com/watch?v=${item.video_id}`}
                    target="_blank"
                    rel="noreferrer"
                  >
                    {item.title || item.video_id}
                  </a>
                  {item.channel_title ? (
                    <span style={{ color: 'var(--text-faint)' }}> — {item.channel_title}</span>
                  ) : null}
                </span>
                <span className="when">{relativeTime(item.sent_at)}</span>
              </div>
            ))}
          </div>
        </div>
      )}
    </section>
  );
}

export { stateBadge };
export default StatusSection;

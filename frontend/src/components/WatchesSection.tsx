import React, { useState } from 'react';
import { apiFetch } from '../apiClient';
import { Status, Subscription, relativeTime, stateBadge } from './StatusSection';

export interface Watch {
  id: string;
  guild_id: string;
  source_id: string;
  channel_url: string;
  channel_id: string;
  title: string | null;
  last_notified_at: string | null;
  created_at: string;
}

interface Props {
  guildId: string;
  watches: Watch[];
  status: Status | null;
  configured: boolean;
  onChanged: () => void;
  notify: (type: 'success' | 'error', text: string) => void;
}

function WatchesSection({ guildId, watches, status, configured, onChanged, notify }: Props) {
  const [newChannelUrl, setNewChannelUrl] = useState('');
  const [adding, setAdding] = useState(false);
  const [busyId, setBusyId] = useState<string | null>(null);

  // Subscription health is keyed by YouTube channel, since it is shared by
  // every server watching that creator.
  const subsByChannel = new Map<string, Subscription>(
    (status?.subscriptions || []).map((sub) => [sub.channelId, sub])
  );

  const handleAdd = async () => {
    const url = newChannelUrl.trim();
    if (!url) {
      notify('error', 'Enter a YouTube channel URL, @handle, or UC… id');
      return;
    }
    setAdding(true);
    try {
      const data = await apiFetch(`/api/guilds/${guildId}/watches`, {
        method: 'POST',
        body: JSON.stringify({ channelUrl: url }),
      });
      setNewChannelUrl('');
      notify('success', data.message || 'Channel added');
      onChanged();
    } catch (error: any) {
      notify('error', error.message || 'Failed to add channel');
    } finally {
      setAdding(false);
    }
  };

  const run = async (id: string, action: string, path: string, method = 'POST') => {
    setBusyId(`${id}:${action}`);
    try {
      const data = await apiFetch(path, { method });
      notify('success', data.message || 'Done');
      onChanged();
    } catch (error: any) {
      notify('error', error.message || 'Request failed');
    } finally {
      setBusyId(null);
    }
  };

  const handleRemove = (watch: Watch) => {
    if (!window.confirm(`Stop watching ${watch.title || watch.channel_id} in this server?`)) {
      return;
    }
    run(watch.id, 'remove', `/api/guilds/${guildId}/watches/${watch.id}`, 'DELETE');
  };

  return (
    <section className="card">
      <div className="section-header">
        <h2>YouTube channels</h2>
        <p>{watches.length} watched here</p>
      </div>

      {!configured && (
        <div className="alert alert-info">
          Pick a notification channel below before adding YouTube channels.
        </div>
      )}

      <div className="form-group">
        <label htmlFor="channel-url">Add a channel</label>
        <div className="form-row">
          <input
            id="channel-url"
            type="text"
            placeholder="https://youtube.com/@handle, /channel/UC…, or a bare UC… id"
            value={newChannelUrl}
            onChange={(event) => setNewChannelUrl(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Enter') handleAdd();
            }}
            disabled={adding}
          />
          <button className="btn-primary" onClick={handleAdd} disabled={adding}>
            {adding ? <span className="loading" /> : null} Add
          </button>
        </div>
        <small>Existing uploads are recorded as seen, so adding a channel never backfills.</small>
      </div>

      {watches.length === 0 ? (
        <div className="empty-state">
          <p>No channels yet</p>
          <small>Add one above to start receiving notifications in this server.</small>
        </div>
      ) : (
        <div className="channel-list">
          {watches.map((watch) => {
            const sub = subsByChannel.get(watch.channel_id);
            const state = sub?.state || 'unknown';
            return (
              <div className="channel-item" key={watch.id}>
                <div className="channel-info">
                  <p className="channel-title">
                    <span className="name">{watch.title || watch.channel_id}</span>
                    {stateBadge(state)}
                  </p>
                  <p className="channel-meta">
                    <a
                      href={`https://www.youtube.com/channel/${watch.channel_id}`}
                      target="_blank"
                      rel="noreferrer"
                      className="mono"
                    >
                      {watch.channel_id}
                    </a>
                    {sub?.leaseExpiresAt &&
                      (state === 'active' || state === 'verified' || state === 'degraded') && (
                        <span>lease renews {relativeTime(sub.leaseExpiresAt)}</span>
                      )}
                    {state === 'verified' && <span>no upload since subscribing</span>}
                    <span>last post {relativeTime(watch.last_notified_at)}</span>
                  </p>
                  {sub?.lastError && (
                    <p className="channel-meta" style={{ color: 'var(--err)' }}>
                      {sub.lastError}
                    </p>
                  )}
                </div>
                <div className="channel-actions">
                  <button
                    className="btn-ghost"
                    title="Ask the hub to re-subscribe now"
                    disabled={busyId !== null}
                    onClick={() =>
                      run(
                        watch.id,
                        'resub',
                        `/api/guilds/${guildId}/watches/${watch.id}/resubscribe`
                      )
                    }
                  >
                    {busyId === `${watch.id}:resub` ? <span className="loading" /> : null} Resub
                  </button>
                  <button
                    className="btn-ghost"
                    title="Post this channel's newest video here now"
                    disabled={busyId !== null}
                    onClick={() =>
                      run(watch.id, 'test', `/api/guilds/${guildId}/watches/${watch.id}/test`)
                    }
                  >
                    {busyId === `${watch.id}:test` ? <span className="loading" /> : null} Test
                  </button>
                  <button
                    className="btn-danger"
                    title="Stop watching in this server"
                    disabled={busyId !== null}
                    onClick={() => handleRemove(watch)}
                  >
                    Remove
                  </button>
                </div>
              </div>
            );
          })}
        </div>
      )}
    </section>
  );
}

export default WatchesSection;

import React, { useCallback, useEffect, useState } from 'react';
import { apiFetch } from '../apiClient';

export interface GuildDetail {
  id: string;
  name: string | null;
  icon: string | null;
  notifyChannelId: string | null;
  messageTemplate: string;
  enabled: boolean;
}

interface DiscordChannel {
  id: string;
  name: string;
  category: string | null;
  canSend: boolean;
}

const PLACEHOLDERS = ['{title}', '{link}', '{channel}', '{author}', '{videoId}'];

interface Props {
  guild: GuildDetail;
  onChanged: () => void;
  notify: (type: 'success' | 'error', text: string) => void;
}

function GuildSettings({ guild, onChanged, notify }: Props) {
  const [notifyChannelId, setNotifyChannelId] = useState(guild.notifyChannelId || '');
  const [messageTemplate, setMessageTemplate] = useState(guild.messageTemplate);
  const [channels, setChannels] = useState<DiscordChannel[]>([]);
  const [loadingChannels, setLoadingChannels] = useState(false);
  const [saving, setSaving] = useState(false);

  const loadChannels = useCallback(async () => {
    setLoadingChannels(true);
    try {
      const data = await apiFetch<{ channels: DiscordChannel[] }>(
        `/api/guilds/${guild.id}/discord-channels`
      );
      setChannels(data.channels);
    } catch (error: any) {
      notify('error', error.message);
    } finally {
      setLoadingChannels(false);
    }
  }, [guild.id, notify]);

  // The channel list is the first thing anyone needs here, so it loads up front
  // rather than behind a button.
  useEffect(() => {
    loadChannels();
  }, [loadChannels]);

  useEffect(() => {
    setNotifyChannelId(guild.notifyChannelId || '');
    setMessageTemplate(guild.messageTemplate);
  }, [guild.id, guild.notifyChannelId, guild.messageTemplate]);

  const save = async () => {
    setSaving(true);
    try {
      const data = await apiFetch(`/api/guilds/${guild.id}/settings`, {
        method: 'POST',
        body: JSON.stringify({ notifyChannelId, messageTemplate }),
      });
      notify('success', data.message || 'Saved');
      onChanged();
    } catch (error: any) {
      notify('error', error.message);
    } finally {
      setSaving(false);
    }
  };

  const selected = channels.find((channel) => channel.id === notifyChannelId);

  return (
    <section className="card">
      <div className="section-header">
        <h2>Settings</h2>
        <p>Where this server's notifications go, and how they read</p>
      </div>

      <div className="form-group">
        <label htmlFor="notify-channel">Notification channel</label>
        <div className="form-row">
          <select
            id="notify-channel"
            value={notifyChannelId}
            onChange={(event) => setNotifyChannelId(event.target.value)}
            disabled={loadingChannels}
          >
            <option value="">Select a channel…</option>
            {notifyChannelId && !selected && (
              <option value={notifyChannelId}>Current: {notifyChannelId}</option>
            )}
            {channels.map((channel) => (
              <option key={channel.id} value={channel.id} disabled={!channel.canSend}>
                {channel.category ? `${channel.category} / ` : ''}#{channel.name}
                {channel.canSend ? '' : ' — no permission'}
              </option>
            ))}
          </select>
          <button className="btn-secondary" onClick={loadChannels} disabled={loadingChannels}>
            {loadingChannels ? <span className="loading" /> : null} Refresh
          </button>
        </div>
        {selected && !selected.canSend && (
          <small style={{ color: 'var(--err)' }}>
            The bot cannot post in #{selected.name}. Grant it View Channel and Send Messages.
          </small>
        )}
      </div>

      <div className="form-group">
        <label htmlFor="template">Message template</label>
        <textarea
          id="template"
          value={messageTemplate}
          onChange={(event) => setMessageTemplate(event.target.value)}
          placeholder="{title} - {link}"
        />
        <small>
          Placeholders:{' '}
          {PLACEHOLDERS.map((placeholder, index) => (
            <React.Fragment key={placeholder}>
              {index > 0 && ', '}
              <code>{placeholder}</code>
            </React.Fragment>
          ))}
        </small>
      </div>

      <div className="actions">
        <button className="btn-primary" onClick={save} disabled={saving || !notifyChannelId}>
          {saving ? <span className="loading" /> : null} Save settings
        </button>
      </div>
    </section>
  );
}

export default GuildSettings;

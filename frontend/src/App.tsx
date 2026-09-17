import React, { useCallback, useEffect, useState } from 'react';
import ServerPicker, { GuildSummary, guildIconUrl, initials } from './components/ServerPicker';
import GuildSettings, { GuildDetail } from './components/GuildSettings';
import WatchesSection, { Watch } from './components/WatchesSection';
import StatusSection, { Status } from './components/StatusSection';
import { ApiError, apiFetch } from './apiClient';
import { Theme, applyTheme, getStoredTheme } from './theme';
import './App.css';

const REFRESH_MS = 30_000;

type Message = { type: 'success' | 'error'; text: string } | null;

interface Me {
  authEnabled: boolean;
  user: { id: string; username: string | null; avatar: string | null } | null;
}

/** The selected server lives in the hash, so a server view is linkable. */
function guildFromHash(): string | null {
  const match = window.location.hash.match(/^#\/servers\/(\d+)/);
  return match ? match[1] : null;
}

function App() {
  const [theme, setTheme] = useState<Theme>(getStoredTheme);
  const [me, setMe] = useState<Me | null>(null);
  const [guildId, setGuildId] = useState<string | null>(guildFromHash);
  const [guilds, setGuilds] = useState<GuildSummary[]>([]);
  const [inviteUrl, setInviteUrl] = useState<string | null>(null);
  const [guild, setGuild] = useState<GuildDetail | null>(null);
  const [watches, setWatches] = useState<Watch[]>([]);
  const [status, setStatus] = useState<Status | null>(null);
  const [booting, setBooting] = useState(true);
  const [message, setMessage] = useState<Message>(null);
  const [busy, setBusy] = useState<string | null>(null);

  useEffect(() => applyTheme(theme), [theme]);

  useEffect(() => {
    const onHashChange = () => setGuildId(guildFromHash());
    window.addEventListener('hashchange', onHashChange);
    return () => window.removeEventListener('hashchange', onHashChange);
  }, []);

  const notify = useCallback((type: 'success' | 'error', text: string) => {
    setMessage({ type, text });
    if (type === 'success') {
      setTimeout(() => setMessage(null), 4000);
    }
  }, []);

  const select = (id: string | null) => {
    window.location.hash = id ? `#/servers/${id}` : '';
    setGuildId(id);
    setGuild(null);
    setWatches([]);
    setStatus(null);
  };

  const refresh = useCallback(async () => {
    try {
      const identity = await apiFetch<Me>('/api/auth/me');
      setMe(identity);
      if (identity.authEnabled && !identity.user) {
        setBooting(false);
        return;
      }

      if (guildId) {
        const [detail, statusData] = await Promise.all([
          apiFetch<{ guild: GuildDetail; watches: Watch[] }>(`/api/guilds/${guildId}`),
          apiFetch<Status>(`/api/status?guildId=${guildId}`),
        ]);
        setGuild(detail.guild);
        setWatches(detail.watches || []);
        setStatus(statusData);
      } else {
        const list = await apiFetch<{ guilds: GuildSummary[]; inviteUrl: string | null }>(
          '/api/guilds'
        );
        setGuilds(list.guilds || []);
        setInviteUrl(list.inviteUrl);
      }
    } catch (error) {
      if (error instanceof ApiError && error.status === 401) {
        setMe({ authEnabled: true, user: null });
      } else if (error instanceof ApiError && error.status === 404 && guildId) {
        notify('error', 'That server is no longer available');
        select(null);
      } else if (error instanceof Error) {
        notify('error', error.message);
      }
    } finally {
      setBooting(false);
    }
  }, [guildId, notify]);

  useEffect(() => {
    refresh();
    const timer = setInterval(refresh, REFRESH_MS);
    return () => clearInterval(timer);
  }, [refresh]);

  const runStatusAction = async (action: 'poll' | 'resub') => {
    setBusy(action);
    try {
      const path = action === 'poll' ? '/api/status/poll-now' : '/api/status/resubscribe-all';
      const data = await apiFetch(path, { method: 'POST' });
      notify(
        'success',
        action === 'poll'
          ? `Checked ${data.checked} feed(s), posted ${data.sent}`
          : `Renewed ${data.renewed}, failed ${data.failed}`
      );
      await refresh();
    } catch (error: any) {
      notify('error', error.message);
    } finally {
      setBusy(null);
    }
  };

  const activeGuild = guilds.find((candidate) => candidate.id === guildId);
  const headerGuild = guild
    ? { id: guild.id, icon: guild.icon, name: guild.name || guild.id }
    : activeGuild || null;

  const header = (
    <header className="header">
      <div className="container header-inner">
        <button className="header-brand" onClick={() => select(null)} title="All servers">
          <span className="header-mark">▶</span>
          <span className="header-text">
            <span className="brand-name">herald</span>
            <span className="brand-tag">YouTube uploads → Discord</span>
          </span>
        </button>

        {guildId && headerGuild && (
          <>
            <span className="crumb-sep">/</span>
            <span className="crumb">
              {guildIconUrl(headerGuild) ? (
                <img src={guildIconUrl(headerGuild) as string} alt="" className="crumb-icon" />
              ) : (
                <span className="crumb-icon crumb-icon-fallback">
                  {initials(headerGuild.name || '?')}
                </span>
              )}
              {headerGuild.name}
            </span>
          </>
        )}

        <div className="header-actions">
          {me?.user && (
            <button
              className="btn-ghost"
              onClick={async () => {
                await apiFetch('/api/auth/logout', { method: 'POST' });
                setMe({ authEnabled: true, user: null });
              }}
            >
              Sign out {me.user.username}
            </button>
          )}
          <button
            className="theme-toggle"
            title={theme === 'dark' ? 'Switch to light' : 'Switch to dark'}
            onClick={() => setTheme(theme === 'dark' ? 'light' : 'dark')}
          >
            {theme === 'dark' ? '☀' : '☾'}
          </button>
        </div>
      </div>
    </header>
  );

  if (me?.authEnabled && !me.user) {
    return (
      <div className="app">
        {header}
        <main className="main">
          <div className="container">
            <div className="card gate">
              <div className="section-header">
                <h2>Sign in</h2>
              </div>
              <p style={{ marginTop: 0, color: 'var(--text-muted)' }}>
                Sign in with Discord to manage the servers where you have <strong>Manage Server</strong>.
              </p>
              <a className="btn-primary" href="/api/auth/login">
                Sign in with Discord
              </a>
            </div>
          </div>
        </main>
      </div>
    );
  }

  return (
    <div className="app">
      {header}
      <main className="main">
        <div className="container">
          {message && <div className={`alert alert-${message.type}`}>{message.text}</div>}

          {booting ? (
            <div className="center-loading">
              <span className="loading" />
              <p>Loading…</p>
            </div>
          ) : guildId ? (
            <>
              <StatusSection
                status={status}
                busy={busy}
                onPollNow={() => runStatusAction('poll')}
                onResubscribeAll={() => runStatusAction('resub')}
              />
              <WatchesSection
                guildId={guildId}
                watches={watches}
                status={status}
                configured={Boolean(guild?.notifyChannelId)}
                onChanged={refresh}
                notify={notify}
              />
              {guild && <GuildSettings guild={guild} onChanged={refresh} notify={notify} />}
            </>
          ) : (
            <ServerPicker guilds={guilds} inviteUrl={inviteUrl} onSelect={select} />
          )}
        </div>
      </main>

      <footer className="footer">
        <div className="container">
          <p style={{ margin: 0 }}>
            herald · WebSub push with a{' '}
            {status ? Math.round(status.poller.intervalMs / 60000) : 5}-minute feed fallback
          </p>
        </div>
      </footer>
    </div>
  );
}

export default App;

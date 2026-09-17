import React from 'react';

export interface GuildSummary {
  id: string;
  name: string;
  icon: string | null;
  manageable: boolean;
  configured: boolean;
  watchCount: number;
}

export function guildIconUrl(guild: { id: string; icon: string | null }): string | null {
  return guild.icon
    ? `https://cdn.discordapp.com/icons/${guild.id}/${guild.icon}.png?size=128`
    : null;
}

export function initials(name: string): string {
  return name
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((word) => word[0]?.toUpperCase() ?? '')
    .join('');
}

interface Props {
  guilds: GuildSummary[];
  inviteUrl: string | null;
  onSelect: (guildId: string) => void;
}

function ServerPicker({ guilds, inviteUrl, onSelect }: Props) {
  return (
    <section className="card">
      <div className="section-header">
        <h2>Your servers</h2>
        <p>{guilds.length} available</p>
        <div className="spacer" />
        {inviteUrl && (
          <a className="btn-primary" href={inviteUrl} target="_blank" rel="noreferrer">
            Add to server
          </a>
        )}
      </div>

      {guilds.length === 0 ? (
        <div className="empty-state">
          <p>No servers yet</p>
          <small>
            Use <strong>Add to server</strong> to invite the bot somewhere you manage, then come
            back and refresh.
          </small>
        </div>
      ) : (
        <div className="server-grid">
          {guilds.map((guild) => {
            const icon = guildIconUrl(guild);
            return (
              <button key={guild.id} className="server-card" onClick={() => onSelect(guild.id)}>
                {icon ? (
                  <img src={icon} alt="" className="server-icon" />
                ) : (
                  <span className="server-icon server-icon-fallback">{initials(guild.name)}</span>
                )}
                <span className="server-name">{guild.name}</span>
                <span className="server-meta">
                  {guild.watchCount} channel{guild.watchCount === 1 ? '' : 's'}
                  {!guild.configured && (
                    <>
                      {' · '}
                      <span className="needs-setup">needs setup</span>
                    </>
                  )}
                </span>
              </button>
            );
          })}
        </div>
      )}
    </section>
  );
}

export default ServerPicker;

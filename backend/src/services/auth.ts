import crypto from 'crypto';
import { getDatabase } from '../database/db';
import { createLogger } from '../util/logger';

const log = createLogger('auth');

const DISCORD_API = 'https://discord.com/api/v10';
const SESSION_COOKIE = 'herald_session';
const SESSION_TTL_MS = Number(process.env.SESSION_TTL_MS || 7 * 24 * 60 * 60 * 1000);
// Discord's MANAGE_GUILD bit. Anyone holding it on a server is treated as an
// administrator of that server's configuration here.
const MANAGE_GUILD = 1n << 5n;

export interface SessionUser {
  id: string;
  username: string | null;
  avatar: string | null;
  guildIds: string[];
}

/**
 * Login is opt-in. With no OAuth client secret configured the dashboard is
 * open, which is the right default for a bot running on a trusted LAN; set the
 * secret and every request must carry a session belonging to someone who holds
 * Manage Server on the guild they are touching.
 */
export function authEnabled(): boolean {
  return Boolean(process.env.DISCORD_CLIENT_SECRET && process.env.DISCORD_CLIENT_ID);
}

export function cookieName(): string {
  return SESSION_COOKIE;
}

function redirectUri(): string {
  const base = (process.env.PUBLIC_BASE_URL || 'http://localhost:8080').replace(/\/$/, '');
  return `${base}/api/auth/callback`;
}

export function authorizeUrl(state: string): string {
  const params = new URLSearchParams({
    client_id: process.env.DISCORD_CLIENT_ID as string,
    redirect_uri: redirectUri(),
    response_type: 'code',
    scope: 'identify guilds',
    state,
    prompt: 'none',
  });
  return `https://discord.com/oauth2/authorize?${params.toString()}`;
}

export function createState(): string {
  return crypto.randomBytes(16).toString('hex');
}

interface DiscordGuild {
  id: string;
  name: string;
  icon: string | null;
  owner?: boolean;
  permissions?: string;
}

/**
 * Exchanges the OAuth code and records a session listing only the guilds the
 * user may administer. Guild membership is captured at login rather than
 * checked per request, so a session is at most SESSION_TTL_MS stale.
 */
export async function completeLogin(code: string): Promise<string> {
  const body = new URLSearchParams({
    client_id: process.env.DISCORD_CLIENT_ID as string,
    client_secret: process.env.DISCORD_CLIENT_SECRET as string,
    grant_type: 'authorization_code',
    code,
    redirect_uri: redirectUri(),
  });

  const tokenResponse = await fetch(`${DISCORD_API}/oauth2/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: body.toString(),
    signal: AbortSignal.timeout(15_000),
  });
  if (!tokenResponse.ok) {
    throw new Error(`Discord rejected the login (${tokenResponse.status})`);
  }
  const tokens = (await tokenResponse.json()) as { access_token: string };

  const headers = { Authorization: `Bearer ${tokens.access_token}` };
  const [userResponse, guildsResponse] = await Promise.all([
    fetch(`${DISCORD_API}/users/@me`, { headers, signal: AbortSignal.timeout(15_000) }),
    fetch(`${DISCORD_API}/users/@me/guilds`, { headers, signal: AbortSignal.timeout(15_000) }),
  ]);
  if (!userResponse.ok || !guildsResponse.ok) {
    throw new Error('Could not read your Discord profile');
  }

  const user = (await userResponse.json()) as { id: string; username: string; avatar: string | null };
  const guilds = (await guildsResponse.json()) as DiscordGuild[];
  const manageable = guilds
    .filter((guild) => guild.owner || (BigInt(guild.permissions || '0') & MANAGE_GUILD) !== 0n)
    .map((guild) => guild.id);

  const sessionId = crypto.randomBytes(32).toString('hex');
  getDatabase()
    .prepare(
      `INSERT INTO sessions (id, user_id, username, avatar, guild_ids, expires_at)
       VALUES (?, ?, ?, ?, ?, ?)`
    )
    .run(
      sessionId,
      user.id,
      user.username,
      user.avatar,
      JSON.stringify(manageable),
      new Date(Date.now() + SESSION_TTL_MS).toISOString()
    );

  log.info(`${user.username} signed in with ${manageable.length} manageable server(s)`);
  return sessionId;
}

export function readSession(sessionId: string | undefined): SessionUser | null {
  if (!sessionId) {
    return null;
  }
  const row = getDatabase()
    .prepare('SELECT * FROM sessions WHERE id = ? AND expires_at > ?')
    .get(sessionId, new Date().toISOString()) as Record<string, any> | undefined;
  if (!row) {
    return null;
  }
  let guildIds: string[] = [];
  try {
    guildIds = JSON.parse(row.guild_ids);
  } catch {
    guildIds = [];
  }
  return { id: row.user_id, username: row.username, avatar: row.avatar, guildIds };
}

export function destroySession(sessionId: string | undefined): void {
  if (sessionId) {
    getDatabase().prepare('DELETE FROM sessions WHERE id = ?').run(sessionId);
  }
}

export function mayManageGuild(user: SessionUser | null, guildId: string): boolean {
  if (!authEnabled()) {
    return true;
  }
  return Boolean(user && user.guildIds.includes(guildId));
}

export function parseCookies(header: string | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  if (!header) {
    return out;
  }
  for (const part of header.split(';')) {
    const index = part.indexOf('=');
    if (index > 0) {
      out[part.slice(0, index).trim()] = decodeURIComponent(part.slice(index + 1).trim());
    }
  }
  return out;
}

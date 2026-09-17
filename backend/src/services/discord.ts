import {
  ActivityType,
  ChannelType,
  Client,
  GatewayIntentBits,
  PermissionFlagsBits,
  PresenceStatusData,
  TextChannel,
} from 'discord.js';
import { createLogger } from '../util/logger';

const log = createLogger('discord');

let client: Client | null = null;
let clientToken: string | null = null;
// Concurrent notifications used to each tear down the half-connected client of
// the previous caller, so only one of a burst of uploads ever got delivered.
let loginInFlight: Promise<Client> | null = null;

const ACTIVITY_TYPE_MAP: Record<string, ActivityType> = {
  playing: ActivityType.Playing,
  streaming: ActivityType.Streaming,
  listening: ActivityType.Listening,
  watching: ActivityType.Watching,
  competing: ActivityType.Competing,
};

function buildPresence() {
  const type =
    ACTIVITY_TYPE_MAP[(process.env.BOT_ACTIVITY_TYPE || 'watching').toLowerCase()] ??
    ActivityType.Watching;
  return {
    status: (process.env.BOT_ONLINE_STATUS || 'online') as PresenceStatusData,
    activities: [{ name: process.env.BOT_STATUS_TEXT || 'for new uploads', type }],
  };
}

export function isConnected(): boolean {
  return Boolean(client?.isReady());
}

export function connectedAs(): string | null {
  return client?.isReady() ? client.user?.tag ?? null : null;
}

/**
 * A bot token's first segment is the base64url-encoded application id, so the
 * invite link needs no extra configuration.
 */
export function deriveClientId(token: string | undefined): string | null {
  if (process.env.DISCORD_CLIENT_ID) {
    return process.env.DISCORD_CLIENT_ID;
  }
  if (!token) {
    return null;
  }
  try {
    const decoded = Buffer.from(token.split('.')[0], 'base64').toString('utf8');
    return /^\d{5,}$/.test(decoded) ? decoded : null;
  } catch {
    return null;
  }
}

export function inviteUrl(token: string | undefined): string | null {
  const clientId = deriveClientId(token);
  if (!clientId) {
    return null;
  }
  // View Channel + Send Messages + Embed Links. Nothing else is needed.
  const permissions = process.env.DISCORD_INVITE_PERMISSIONS || '19456';
  return (
    `https://discord.com/oauth2/authorize?client_id=${clientId}` +
    `&scope=bot&permissions=${permissions}`
  );
}

export async function initializeDiscordClient(token: string): Promise<Client> {
  if (client?.isReady() && clientToken === token) {
    return client;
  }
  if (loginInFlight && clientToken === token) {
    return loginInFlight;
  }
  if (client) {
    client.destroy().catch(() => undefined);
    client = null;
  }

  clientToken = token;
  loginInFlight = (async () => {
    const next = new Client({ intents: [GatewayIntentBits.Guilds] });

    next.once('clientReady', (readyClient) => {
      readyClient.user.setPresence(buildPresence());
      log.info(`Connected as ${readyClient.user.tag} in ${readyClient.guilds.cache.size} server(s)`);
    });
    next.on('error', (error) => log.error('Gateway error', error));
    next.on('shardDisconnect', (_event, id) => log.warn(`Shard ${id} disconnected`));
    next.on('shardReconnecting', (id) => log.warn(`Shard ${id} reconnecting`));
    next.on('guildCreate', (guild) => log.info(`Added to server ${guild.name} (${guild.id})`));
    next.on('guildDelete', (guild) => log.info(`Removed from server ${guild.name} (${guild.id})`));

    await next.login(token);
    // Prime the guild cache so lookups are deterministic after login.
    await next.guilds.fetch();
    client = next;
    return next;
  })();

  try {
    return await loginInFlight;
  } catch (error) {
    client = null;
    clientToken = null;
    throw error;
  } finally {
    loginInFlight = null;
  }
}

export interface BotGuild {
  id: string;
  name: string;
  icon: string | null;
}

/** Every server the bot itself is a member of. */
export async function listBotGuilds(token: string): Promise<BotGuild[]> {
  try {
    const discordClient = await initializeDiscordClient(token);
    const guilds = await discordClient.guilds.fetch();
    return [...guilds.values()]
      .map((guild) => ({ id: guild.id, name: guild.name, icon: guild.icon ?? null }))
      .sort((a, b) => a.name.localeCompare(b.name));
  } catch (error) {
    log.error('Failed to list bot guilds', error);
    return [];
  }
}

export interface GuildChannel {
  id: string;
  name: string;
  category: string | null;
  canSend: boolean;
}

/** Text channels in one guild, flagged with whether the bot may post there. */
export async function listGuildChannels(token: string, guildId: string): Promise<GuildChannel[]> {
  const discordClient = await initializeDiscordClient(token);
  const guild = await discordClient.guilds.fetch(guildId);
  const channels = await guild.channels.fetch();
  const me = await guild.members.fetchMe();

  const result: GuildChannel[] = [];
  for (const channel of channels.values()) {
    if (
      !channel ||
      (channel.type !== ChannelType.GuildText && channel.type !== ChannelType.GuildAnnouncement)
    ) {
      continue;
    }
    const permissions = channel.permissionsFor(me);
    result.push({
      id: channel.id,
      name: channel.name,
      category: channel.parent?.name ?? null,
      canSend: Boolean(
        permissions?.has(PermissionFlagsBits.ViewChannel) &&
          permissions?.has(PermissionFlagsBits.SendMessages)
      ),
    });
  }
  return result.sort((a, b) => a.name.localeCompare(b.name));
}

export async function sendMessage(
  token: string,
  channelId: string,
  message: string
): Promise<boolean> {
  try {
    const discordClient = await initializeDiscordClient(token);
    const channel = await discordClient.channels.fetch(channelId);

    if (!channel?.isTextBased() || !('send' in channel)) {
      log.error(`Channel ${channelId} not found or not text-based`);
      return false;
    }

    await (channel as TextChannel).send({
      content: message.slice(0, 2000),
      allowedMentions: { parse: ['users', 'roles'] },
    });
    return true;
  } catch (error) {
    log.error(`Failed to send message to ${channelId}`, error);
    return false;
  }
}

// A REST call is enough to prove a token is real, and it avoids opening a full
// gateway session just to validate.
export async function validateToken(token: string): Promise<boolean> {
  try {
    const response = await fetch('https://discord.com/api/v10/users/@me', {
      headers: { Authorization: `Bot ${token}` },
      signal: AbortSignal.timeout(10_000),
    });
    return response.ok;
  } catch (error) {
    log.warn('Token validation request failed', error);
    return false;
  }
}

export function disconnectDiscordClient(): void {
  if (client) {
    client.destroy().catch(() => undefined);
    client = null;
    clientToken = null;
  }
}

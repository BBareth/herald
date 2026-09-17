# Security

## Trust model

herald has two surfaces with very different exposure, and it is worth being
clear about which is which.

### The dashboard

By default there is **no authentication**. Anyone who can open the page can add
and remove YouTube channels, change the notification channel, and post test
messages in every server the bot is in.

That default exists because the common case is a bot on a home server that only
its owner can reach, and a mandatory login there is pure friction. It is the
wrong default the instant the port is reachable by anyone else.

**Set `DISCORD_CLIENT_ID` and `DISCORD_CLIENT_SECRET` if the dashboard is
reachable from outside a network you control.** With them, signing in with
Discord is required and each person sees only the servers where they hold
Manage Server. The server the bot is in but you do not administer is invisible
to you.

The startup log says which mode it is running in. Check it.

### The WebSub callback

`/api/websub/callback` is designed to be public, and it is the only path that
needs to be.

- `GET` (the hub's verification handshake) requires `WEBSUB_VERIFY_TOKEN`,
  compared in constant time.
- `POST` (an upload notification) requires a valid HMAC signature over the exact
  bytes received, keyed with `WEBSUB_SECRET`, also compared in constant time.
  Both SHA-1 and SHA-256 signatures are accepted.

An unsigned or wrongly-signed POST is rejected with `403` before anything is
parsed. Exposing this path alone does not expose the dashboard.

## Secrets

| Secret | Exposure if leaked |
| --- | --- |
| `DISCORD_BOT_TOKEN` | Full control of the bot: it can post anywhere it has been invited. Reset it in the developer portal. |
| `DISCORD_CLIENT_SECRET` | Lets an attacker impersonate your OAuth application. Rotate it in the portal. |
| `WEBSUB_SECRET` | Lets an attacker forge upload notifications, posting arbitrary text to your servers. Rotate and restart. |
| `WEBSUB_VERIFY_TOKEN` | Lets an attacker confirm or cancel subscriptions. Rotate and restart. |

None of these are ever sent to the browser. The dashboard authenticates with an
httpOnly session cookie and holds no secret in JavaScript or browser storage.

## What the bot can do in Discord

The invite asks for View Channel, Send Messages, and Embed Links, and no
privileged gateway intents. It cannot read message content, see your members, or
moderate anything.

## Reporting a vulnerability

Open a [security advisory](https://github.com/BBareth/herald/security/advisories/new)
rather than a public issue.

This is a hobby project maintained in spare time. There is no SLA, but genuine
reports will be taken seriously.

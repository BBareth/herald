# Deploying herald — agent runbook

A checklist for a coding agent asked to deploy herald on a host it has shell
access to. Every step has a command and a check that proves the step worked;
prefer the check over assuming success.

The human-facing version of the same process is [SETUP.md](./SETUP.md).

---

## What you cannot do without the operator

Stop and ask for these. None of them can be obtained from the shell.

| Needed | Where it comes from |
| --- | --- |
| `DISCORD_BOT_TOKEN` | The operator creates an application at discord.com/developers/applications, adds a bot, and copies the token. It is shown once. |
| Inviting the bot to a server | Requires a browser and Manage Server on the target guild. Give the operator the invite URL; they must click Authorise. |
| `DISCORD_CLIENT_ID` / `DISCORD_CLIENT_SECRET` | Same portal, OAuth2 tab. Only needed for dashboard login. |
| A public HTTPS URL | Only needed for push. The operator decides whether one exists. |

Do **not** invite the bot to servers the operator did not name, and do not post
test messages into servers or channels they did not nominate.

## 1. Preflight

```bash
docker --version                     # any recent Docker with compose v2
docker compose version
```

Decide where state lives. The container writes SQLite to `/data`; mount a named
volume or a host directory. Losing it loses the send history, which means
previously-announced videos can be announced again.

## 2. Configuration

Write `.env` next to the compose file. Minimum viable:

```dotenv
DISCORD_BOT_TOKEN=<from the operator>
```

Add these only if the operator supplied a public URL:

```dotenv
WEBSUB_CALLBACK_BASE_URL=https://herald.example.com
WEBSUB_VERIFY_TOKEN=<openssl rand -hex 24>
WEBSUB_SECRET=<openssl rand -hex 48>
```

Add these only if the dashboard is reachable beyond a trusted network:

```dotenv
DISCORD_CLIENT_ID=<from the operator>
DISCORD_CLIENT_SECRET=<from the operator>
PUBLIC_BASE_URL=https://herald.example.com
```

`PUBLIC_BASE_URL` must byte-for-byte match a redirect registered in the Discord
portal as `<PUBLIC_BASE_URL>/api/auth/callback`. If you set the variable, tell
the operator to register that exact URL — they cannot guess it.

Generate secrets rather than inventing them:

```bash
openssl rand -hex 24
openssl rand -hex 48
```

## 3. Start

```bash
docker compose up -d
```

**Check — the service is up:**

```bash
for i in $(seq 1 30); do
  [ "$(curl -fsS http://localhost:8080/api/health 2>/dev/null)" = "ok" ] && { echo up; break; }
  [ "$i" = 30 ] && { echo FAILED; docker compose logs --tail 50; exit 1; }
  sleep 1
done
```

**Check — Discord connected:**

```bash
docker compose logs | grep -E "Connected as|connect on startup failed"
```

`Connected as <name>#<discriminator> in N server(s)` means the token is good.
`Discord connect on startup failed` means it is not — stop and ask the operator
to reset the token.

**Check — the dashboard is served, not just the API:**

```bash
curl -fsS http://localhost:8080/ | grep -q 'id="root"' && echo "dashboard ok"
```

## 4. Get the bot into a server

```bash
curl -fsS http://localhost:8080/api/guilds
```

`inviteUrl` in that response is the link the operator must open. Hand it to them
verbatim and wait — you cannot complete an OAuth authorisation yourself.

Once they confirm, re-run the same request. The guild appears in `guilds` with
`"configured": false`.

> If `authEnabled` is true you cannot call `/api/guilds` without a session
> cookie. Either configure the server before enabling login, or have the
> operator drive the dashboard from here.

## 5. Configure a guild

Everything below uses `G` for the guild id from the previous step.

```bash
G=<guild id>
```

**List the channels the bot can post in:**

```bash
curl -fsS http://localhost:8080/api/guilds/$G/discord-channels
```

Choose one with `"canSend": true`. If the operator named a channel that reports
`false`, tell them it needs View Channel and Send Messages — do not silently
pick a different one.

**Save the settings:**

```bash
curl -fsS -X POST http://localhost:8080/api/guilds/$G/settings \
  -H 'content-type: application/json' \
  -d '{"notifyChannelId":"<channel id>","messageTemplate":"{title} - {link}"}'
```

**Add each YouTube channel the operator asked for:**

```bash
curl -fsS -X POST http://localhost:8080/api/guilds/$G/watches \
  -H 'content-type: application/json' \
  -d '{"channelUrl":"https://www.youtube.com/@SomeCreator"}'
```

Accepts a channel URL, an `@handle`, or a bare `UC…` id. A duplicate returns
`409`, which is not an error worth retrying.

## 6. Prove it end to end

Ask first — this posts a real message into the operator's server.

```bash
W=$(curl -fsS http://localhost:8080/api/guilds/$G \
     | python3 -c 'import json,sys; print(json.load(sys.stdin)["watches"][0]["id"])')

curl -fsS -X POST http://localhost:8080/api/guilds/$G/watches/$W/test
```

`{"success":true,...}` plus a message visible in Discord is the only proof that
matters. A `502` with `unconfigured` means no notification channel was saved.

## 7. Verify delivery health

```bash
curl -fsS "http://localhost:8080/api/status?guildId=$G"
```

Read `websub.enabled` first, then judge the rest against it:

| Observation | Meaning | Action |
| --- | --- | --- |
| `websub.enabled: false`, states `polling` | No public URL configured | Correct and healthy. Uploads arrive within `POLL_INTERVAL_MS`. |
| States `verified`, `active: 0` | Subscribed; nothing uploaded since | **Healthy.** Do not treat this as a failure. |
| State `active` | A push has genuinely arrived | Fully confirmed. |
| State `degraded` | An upload bypassed a live subscription | Push delivery is broken. Check the proxy is not blocking Google. |
| State `failed`, `503 Transient error` | Google's hub is throttling | Nothing to fix. It retries on its own, honouring `Retry-After`. |

> Do not conclude push is broken from `lastPushAt: null` alone. Check whether
> any watched channel has actually uploaded recently — a quiet channel produces
> no pushes, and that is not a fault. To test push for real, temporarily add a
> high-frequency channel, wait for a push, then remove it. Only do this with the
> operator's agreement, since it posts to their server.

## 8. Report back

State plainly:

- Where it runs and how to reach the dashboard.
- Whether login is on. If it is off, say so explicitly — it means anyone who can
  reach the page controls every server the bot is in.
- Whether push is on, or whether delivery is polling-only and what that means
  for latency.
- Which guilds and channels were configured, and which YouTube channels were
  added.
- Anything you could not do and need the operator to finish.

## Failure modes worth recognising

**`npm ci` fails building better-sqlite3.** Only relevant if building from
source. It has no musl prebuild; the Dockerfile compiles it in a dedicated stage.
Use the published image unless you are changing the code.

**Subscriptions verify then go quiet.** Something between Google and the
container is challenging the hub — Cloudflare Bot Fight Mode is the usual
culprit. See [SETUP.md](./SETUP.md#behind-cloudflare).

**Videos re-announced after a redeploy.** The `/data` volume was not persisted.
The send history lives there.

**Nothing posts but `Test` works.** Delivery works; detection does not. Confirm
`POLL_INTERVAL_MS` is not `0`, then `POST /api/status/poll-now` and read the
`sent` count.

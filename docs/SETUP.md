# Setting up herald

A complete walkthrough, from nothing to a bot posting upload notifications.
Allow about ten minutes.

You need somewhere to run Docker. A public URL is **optional** — the section on
[push notifications](#6-push-notifications-optional) explains what you gain by
having one.

---

## 1. Create the Discord application

1. Go to <https://discord.com/developers/applications> and click
   **New Application**. Name it whatever you want the bot to be called.
2. Open the **Bot** tab.
3. Click **Reset Token**, then **Copy**. This is your `DISCORD_BOT_TOKEN`.
   You only get to see it once; if you lose it, reset it again.
4. Scroll down to **Privileged Gateway Intents** and leave all three **off**.
   herald does not need any of them.

> [!WARNING]
> The token is a password for your bot. Anyone who has it can make the bot post
> anywhere it has been invited. Never commit it, never paste it into a chat.

## 2. Start the container

Create a directory to hold the config and data:

```bash
mkdir herald && cd herald
```

Write a `.env` file with, at minimum, your token:

```dotenv
DISCORD_BOT_TOKEN=paste_your_token_here
```

Then either run it directly:

```bash
docker run -d --name herald \
  -p 8080:8080 \
  -v herald_data:/data \
  --env-file .env \
  --restart unless-stopped \
  ghcr.io/bbareth/herald:latest
```

or use compose — download
[`docker-compose.yml`](../docker-compose.yml) next to your `.env` and run
`docker compose up -d`.

Check it came up:

```bash
curl -fsS http://localhost:8080/api/health    # prints: ok
docker logs herald | tail
```

The log should contain `Connected as YourBot#1234`. If it says
`No Discord bot token configured`, the `.env` did not reach the container.

## 3. Invite the bot to a server

1. Open <http://localhost:8080> in a browser.
2. Click **Add to server** in the top right.
3. Choose a server — you need **Manage Server** on it — and click **Authorise**.

The requested permissions are View Channel, Send Messages, and Embed Links.
Nothing else.

4. Return to the dashboard and reload. The server now appears in the grid.

> [!NOTE]
> The invite link is built from your bot token, so it always points at *your*
> application. There is nothing to configure.

## 4. Configure that server

Click the server. You land on its dashboard.

1. Scroll to **Settings**.
2. Pick a **Notification channel**. Channels the bot cannot post in are listed
   but disabled — if the one you want is greyed out, give the bot View Channel
   and Send Messages there in Discord, then press **Refresh**.
3. Optionally edit the **Message template**. Default is `{title} - {link}`.
   Placeholders are listed under the box; `<@&ROLE_ID>` pings a role.
4. Click **Save settings**.

## 5. Add a YouTube channel

In **YouTube channels**, paste any of these and press **Add**:

- `https://www.youtube.com/@SomeCreator`
- `https://www.youtube.com/channel/UCxxxxxxxxxxxxxxxxxxxxxx`
- `@SomeCreator`
- `UCxxxxxxxxxxxxxxxxxxxxxx`

Existing uploads are recorded as already seen, so adding a channel never
backfills old videos into your server.

Press **Test** on the new entry. It posts that channel's newest video into your
notification channel immediately. If that message appears, everything works.

Repeat for as many channels and as many servers as you like.

## 6. Push notifications (optional)

Without this, herald reads each channel's RSS feed every five minutes, so an
upload shows up within about five to eleven minutes (YouTube's feed itself lags
a few minutes behind publication). That is fine for most people, and it is the
delivery path that keeps working when everything else does not.

With a public HTTPS URL, YouTube pushes uploads within seconds.

### What you need

An HTTPS address that reaches the container. Any of these work:

- A reverse proxy (nginx, Caddy, Traefik) with a certificate.
- A [Cloudflare Tunnel](https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/) — no open ports, no certificate to manage.
- Tailscale Funnel.

Only the path `/api/websub/callback` has to be reachable. The dashboard can stay
private.

### Configure it

```dotenv
WEBSUB_CALLBACK_BASE_URL=https://herald.example.com
WEBSUB_VERIFY_TOKEN=generate_with_openssl_rand_hex_24
WEBSUB_SECRET=generate_with_openssl_rand_hex_48
```

Generate the two secrets:

```bash
openssl rand -hex 24    # WEBSUB_VERIFY_TOKEN
openssl rand -hex 48    # WEBSUB_SECRET
```

Restart the container. Within a few minutes each channel should move from
`polling` to `verified`, and to `active` once a push actually arrives.

### Check it reaches you

```bash
curl -i "https://herald.example.com/api/websub/callback?hub.mode=subscribe&hub.challenge=hello&hub.verify_token=YOUR_VERIFY_TOKEN"
```

A correct setup returns `200` and the body `hello`. Anything else — a redirect,
an HTML page, a challenge — and Google's hub will not be able to verify either.

### Behind Cloudflare

Cloudflare's bot protection will happily block Google's hub, and the symptom is
subtle: subscriptions never verify, and the bot looks broken for no visible
reason.

- **Bot Fight Mode cannot be exempted by WAF rules** on the Free plan. Either
  turn it off, or add an **IP Access Rule** allowing Google's ASNs
  (`AS15169` and `AS396982`), which takes precedence over it.
- Add a WAF **Skip** rule for
  `http.host eq "herald.example.com" and starts_with(http.request.uri.path, "/api/websub/")`
  covering Browser Integrity Check, Security Level, and Managed Rules.
- If you rate-limit, allow at least 100 requests per 10 seconds on that path.

The hub keeps its own records, which is the fastest way to see what it thinks:

```
https://pubsubhubbub.appspot.com/subscription-details?hub.callback=<your callback URL>&hub.topic=https://www.youtube.com/xml/feeds/videos.xml?channel_id=<UC...>&hub.secret=<your secret>
```

That page shows the lease expiry and, crucially, the hub's *last verification
error* and *last delivery error* — which is how you find out it has been getting
a `403` from your proxy.

## 7. Turn on Discord login

Skip this only if the dashboard is unreachable from outside your own machine or
LAN. Without it, anyone who opens the page manages every server the bot is in.

1. In the developer portal, open **OAuth2**.
2. Copy the **Client ID** and **Client Secret**.
3. Under **Redirects**, add exactly:
   `https://herald.example.com/api/auth/callback`
   (or `http://localhost:8080/api/auth/callback` for a local install).
4. Add to `.env`:

```dotenv
DISCORD_CLIENT_ID=your_client_id
DISCORD_CLIENT_SECRET=your_client_secret
PUBLIC_BASE_URL=https://herald.example.com
```

`PUBLIC_BASE_URL` must match the redirect you registered, character for
character, or Discord refuses the login.

5. Restart. The dashboard now asks you to sign in, and each person sees only the
   servers where they hold Manage Server.

## Troubleshooting

**The bot is offline in Discord.**
`docker logs herald` will say why. An invalid token gives
`Discord connect on startup failed`.

**A channel is greyed out when choosing a notification channel.**
The bot lacks View Channel or Send Messages there. Fix it in Discord's channel
permissions, then press **Refresh**.

**Test posts, but real uploads never arrive.**
Check the poller is on (`POLL_INTERVAL_MS` is not `0`) and look at the **Feed
poller** tile for its last run. Press **Check feeds now** to force a pass.

**Everything says `verified` but never `active`.**
That is normal. `active` requires a push to have actually arrived, and a channel
that has not uploaded since you subscribed cannot demonstrate one. It is not a
fault.

**Everything says `failed` with `503 Transient error`.**
Google's hub throttles, sometimes for hours. herald honours the `Retry-After`
the hub sends and keeps retrying; meanwhile the poller delivers. There is
nothing to fix on your side.

**A server disappeared from the dashboard.**
Either the bot was removed from it, or you lost Manage Server there.

## Upgrading

```bash
docker compose pull && docker compose up -d
# or
docker pull ghcr.io/bbareth/herald:latest && docker restart herald
```

The database migrates itself on start. Back up `/data` first if you care about
the history.

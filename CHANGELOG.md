# Changelog

All notable changes to this project are documented here.
Format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

## [1.0.0] — 2026-09-17

First public release.

### Added
- Multi-server support. One bot instance serves any number of Discord servers,
  each with its own watched YouTube channels, notification channel, and message
  template.
- Server picker dashboard with Discord server icons and an **Add to server**
  invite link derived from the bot token.
- Optional Discord OAuth login. When configured, each person sees only the
  servers where they hold Manage Server.
- RSS feed poller running alongside WebSub push, so uploads still arrive when
  Google's hub is throttling or has dropped a subscription.
- Subscription health reporting that distinguishes `active` (a push genuinely
  arrived), `verified` (subscribed, nothing uploaded since), `degraded` (an
  upload bypassed a live subscription), and `polling` (push not configured).
- Single container image serving both the API and the dashboard.
- Automatic migration from a pre-1.0 single-server database, preserving send
  history so nothing is re-announced.

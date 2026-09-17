# Changelog

All notable changes to this project are documented here.
Format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

## [1.0.3] — 2026-09-17

### Changed
- Dependency upgrades, notably better-sqlite3 9 to 13, verified against a real
  database before merging.
- `latest` is now only applied when the tag being published is the newest
  semver in the repository, so re-running an older tag's workflow cannot drag
  it backwards onto a superseded release.
- Dependabot ignores majors for the framework-shaped dependencies (express,
  React, Vite, TypeScript, the Node base image) and for type packages that must
  track a runtime. Those are migrations needing code changes, not bumps.
- `main` is protected: pull requests and passing CI are required.

## [1.0.2] — 2026-09-17

### Added
- A favicon for the dashboard, so the browser tab carries the logo rather than
  the generic default.
- Dependabot for both npm trees, the GitHub Actions workflows, and the base
  images.

### Changed
- The header mark now exists as an SVG asset rather than only as a CSS rule,
  and the README shows it, with a light-background variant.

## [1.0.1] — 2026-09-17

### Fixed
- The pre-1.0 migration silently dropped send history, because the copy was
  guarded on a column that had already been replaced by the time the guard ran.
  An empty history makes the poller treat every video in a feed as new, so
  anything published after a channel was originally added gets re-announced.

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

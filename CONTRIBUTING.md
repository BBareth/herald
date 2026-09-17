# Contributing

Bug reports, fixes, and well-scoped features are welcome.

## Before a large change

Open an issue first. herald is deliberately small: one container, one SQLite
file, no external services. The most useful thing a proposal can do is explain
why it belongs inside that shape. A change that would add a database server, a
queue, or an account system is probably a different project.

## Getting set up

Node 22+ and Docker.

```bash
# terminal 1 — API on :8080
cd backend && npm install && npm run dev

# terminal 2 — dashboard on :5173, proxying /api to :8080
cd frontend && npm install && npm run dev
```

Put a `.env` in `backend/` with at least `DISCORD_BOT_TOKEN`. Use a throwaway
bot and a throwaway server; development posts real messages.

On Windows, `npm install` in `backend/` may fail building better-sqlite3 without
the Visual Studio build tools. `npm install --ignore-scripts` is enough to
typecheck; run the real thing in Docker.

## Before opening a PR

```bash
cd backend  && npx tsc --noEmit
cd frontend && npm run build
docker build -t herald:test .
```

CI runs exactly this, plus a smoke test that boots the image and checks the
health endpoint, the served dashboard, and that an unsigned webhook is rejected.

## Style

Match what is there. A few things that are deliberate:

- **Comments explain why, not what.** Most comments in this codebase exist
  because something non-obvious bit us once — the hub's `Retry-After`, the
  baseline-on-add rule, the fan-out dedupe. Keep that bar.
- **State describes reality, not intent.** The subscription states exist because
  an earlier version reported a subscription as working when it demonstrably was
  not. Do not add a status the code cannot actually prove.
- **Failures should be visible.** The original bug this project was built around
  was silent: subscriptions expired and nothing noticed for months. Surface
  failures in `/api/status` rather than only in logs.

## Releasing

1. Merge everything you want in the release to `main` and let CI go green.
2. Add a `CHANGELOG.md` entry.
3. Tag and push: `git tag -a vX.Y.Z -m "herald X.Y.Z" && git push origin vX.Y.Z`.
4. Wait for **Publish image** to finish, then `gh release create vX.Y.Z --notes-file …`.

`latest` follows the newest semver tag. The publish workflow refuses to apply it
when the tag being built is not the highest one in the repository, so a rebuild
of an old release cannot drag `latest` backwards.

> [!WARNING]
> That guard lives in the workflow file, and a tag build runs **the workflow as
> it existed at that tag**. Tags cut before the guard landed (`v1.0.0`,
> `v1.0.1`, `v1.0.2`) therefore still carry the unguarded version, and
> re-running their publish *will* move `latest` onto that old release. This is
> not hypothetical — it has happened twice. Do not re-run publish on those
> tags; cut a new one instead. If it happens anyway, re-run publish on the
> newest tag to put `latest` back.

import express, { Application, NextFunction, Request, Response } from 'express';
import cookieParser from 'cookie-parser';
import helmet from 'helmet';
import rateLimit from 'express-rate-limit';
import path from 'path';
import fs from 'fs';
import dotenv from 'dotenv';
import { closeDatabase, getBotToken, getDatabase, initializeDatabase } from './database/db';
import { guildRouter } from './routes/guilds';
import { websubRouter } from './routes/websub';
import { statusRouter } from './routes/status';
import { authRouter } from './routes/auth';
import { startWebSubRenewalJob, stopWebSubRenewalJob } from './services/websub';
import { startPoller, stopPoller } from './services/poller';
import { disconnectDiscordClient, initializeDiscordClient } from './services/discord';
import { authEnabled, cookieName, readSession } from './services/auth';
import { createLogger } from './util/logger';

dotenv.config();

const log = createLogger('server');
const app: Application = express();
const PORT = Number(process.env.PORT || process.env.BACKEND_PORT || 8080);

// Trust the immediate upstream proxy (cloudflared, Nginx, Traefik). Only the
// first hop is trusted, so a client cannot forge its own X-Forwarded-For.
app.set('trust proxy', 1);
app.disable('x-powered-by');

app.use(
  helmet({
    // The SPA is served from this same origin; the default CSP would block its
    // own inline bootstrap.
    contentSecurityPolicy: false,
    crossOriginEmbedderPolicy: false,
  })
);
app.use(cookieParser());

const jsonBody = express.json({ limit: '256kb' });

const websubLimiter = rateLimit({
  windowMs: 60_000,
  max: Number(process.env.WEBSUB_RATE_LIMIT || 300),
  standardHeaders: true,
  legacyHeaders: false,
});

const apiLimiter = rateLimit({
  windowMs: 60_000,
  max: Number(process.env.API_RATE_LIMIT || 240),
  standardHeaders: true,
  legacyHeaders: false,
});

// Resolves the caller's session, if any. Authorisation itself happens per
// guild, because holding Manage Server on one guild says nothing about another.
const attachUser = (req: Request, _res: Response, next: NextFunction) => {
  const sessionId = req.cookies?.[cookieName()];
  req.sessionId = sessionId;
  req.user = readSession(sessionId);
  next();
};

const requireLogin = (req: Request, res: Response, next: NextFunction) => {
  if (authEnabled() && !req.user) {
    return res.status(401).json({ error: 'Sign in with Discord' });
  }
  next();
};

initializeDatabase();

// Seed the bot token from the environment on first run so a fresh deployment is
// functional without opening the UI.
(function seedTokenFromEnv() {
  const db = getDatabase();
  const existing = db.prepare('SELECT id FROM config LIMIT 1').get();
  if (existing || !process.env.DISCORD_BOT_TOKEN) {
    return;
  }
  db.prepare('INSERT INTO config (discord_token) VALUES (?)').run(process.env.DISCORD_BOT_TOKEN);
  log.info('Stored the Discord bot token from the environment');
})();

startWebSubRenewalJob();
startPoller();

(async () => {
  const token = getBotToken();
  if (!token) {
    log.warn('No Discord bot token configured — set DISCORD_BOT_TOKEN');
    return;
  }
  try {
    await initializeDiscordClient(token);
  } catch (error) {
    log.error('Discord connect on startup failed', error);
  }
})();

app.use('/api/auth', apiLimiter, jsonBody, attachUser, authRouter);
app.use('/api/guilds', apiLimiter, jsonBody, attachUser, requireLogin, guildRouter);
app.use('/api/status', apiLimiter, jsonBody, attachUser, requireLogin, statusRouter);
app.use('/api/websub', websubLimiter, websubRouter);

app.get('/api/health', (_req: Request, res: Response) => res.type('text/plain').send('ok'));
app.get('/health', (_req: Request, res: Response) => res.type('text/plain').send('ok'));

// Single-image deployment: the API and the built SPA are served from one
// origin, so there is no CORS surface and no second container to run.
const webRoot = process.env.WEB_ROOT || path.join(__dirname, '../public');
if (fs.existsSync(path.join(webRoot, 'index.html'))) {
  app.use(
    express.static(webRoot, {
      setHeaders: (res, filePath) => {
        // Hashed assets are immutable; index.html must never be cached or a
        // deploy keeps serving the previous bundle.
        if (filePath.includes(`${path.sep}static${path.sep}`)) {
          res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
        } else {
          res.setHeader('Cache-Control', 'no-cache');
        }
      },
    })
  );
  app.get(/^\/(?!api\/).*/, (_req: Request, res: Response) => {
    res.setHeader('Cache-Control', 'no-cache');
    res.sendFile(path.join(webRoot, 'index.html'));
  });
  log.info(`Serving the dashboard from ${webRoot}`);
} else {
  log.warn(`No built frontend at ${webRoot}; API only`);
}

app.use((_req: Request, res: Response) => res.status(404).json({ error: 'Not found' }));

app.use((err: any, _req: Request, res: Response, _next: NextFunction) => {
  log.error('Unhandled request error', err);
  res.status(err?.status || 500).json({ error: err?.message || 'Internal server error' });
});

const server = app.listen(PORT, () => {
  log.info(`Listening on http://0.0.0.0:${PORT}`);
  log.info(
    authEnabled()
      ? 'Discord login is required to manage servers'
      : 'Discord login is not configured — the dashboard is open to anyone who can reach it'
  );
});

function shutdown(signal: string) {
  log.info(`${signal} received, shutting down`);
  stopWebSubRenewalJob();
  stopPoller();
  disconnectDiscordClient();
  server.close(() => {
    closeDatabase();
    process.exit(0);
  });
  setTimeout(() => process.exit(1), 10_000).unref();
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
process.on('unhandledRejection', (reason) => log.error('Unhandled rejection', reason));

export default app;

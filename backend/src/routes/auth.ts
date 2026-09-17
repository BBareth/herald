import { Router, Request, Response } from 'express';
import {
  authEnabled,
  authorizeUrl,
  completeLogin,
  cookieName,
  createState,
  destroySession,
} from '../services/auth';
import { createLogger } from '../util/logger';

const log = createLogger('auth-route');

export const authRouter = Router();

// State is held in a short-lived cookie rather than server memory so the flow
// survives a restart mid-login and works behind multiple workers.
const STATE_COOKIE = 'herald_oauth_state';

function secureCookies(): boolean {
  return (process.env.PUBLIC_BASE_URL || '').startsWith('https://');
}

authRouter.get('/me', (req: Request, res: Response) => {
  res.json({
    authEnabled: authEnabled(),
    user: req.user
      ? { id: req.user.id, username: req.user.username, avatar: req.user.avatar }
      : null,
  });
});

authRouter.get('/login', (req: Request, res: Response) => {
  if (!authEnabled()) {
    return res.status(400).json({ error: 'Discord login is not configured' });
  }
  const state = createState();
  res.cookie(STATE_COOKIE, state, {
    httpOnly: true,
    sameSite: 'lax',
    secure: secureCookies(),
    maxAge: 10 * 60 * 1000,
  });
  res.redirect(authorizeUrl(state));
});

authRouter.get('/callback', async (req: Request, res: Response) => {
  if (!authEnabled()) {
    return res.status(400).send('Discord login is not configured');
  }

  const code = String(req.query.code || '');
  const state = String(req.query.state || '');
  const expected = req.cookies?.[STATE_COOKIE];

  // Without this check an attacker could hand the user a prepared callback URL
  // and log them into an account of the attacker's choosing.
  if (!code || !state || !expected || state !== expected) {
    return res.status(400).send('Login failed: state mismatch. Start again from the dashboard.');
  }
  res.clearCookie(STATE_COOKIE);

  try {
    const sessionId = await completeLogin(code);
    res.cookie(cookieName(), sessionId, {
      httpOnly: true,
      sameSite: 'lax',
      secure: secureCookies(),
      maxAge: Number(process.env.SESSION_TTL_MS || 7 * 24 * 60 * 60 * 1000),
    });
    res.redirect('/');
  } catch (error) {
    log.error('Login failed', error);
    res.status(502).send('Login failed. Check the server logs and try again.');
  }
});

authRouter.post('/logout', (req: Request, res: Response) => {
  destroySession(req.sessionId);
  res.clearCookie(cookieName());
  res.json({ success: true });
});

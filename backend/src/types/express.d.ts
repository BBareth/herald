import { SessionUser } from '../services/auth';

declare global {
  namespace Express {
    interface Request {
      user?: SessionUser | null;
      sessionId?: string;
    }
  }
}

export {};

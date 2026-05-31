// requireSession — Hono middleware that 401s when no valid session.
// On success, attaches `userId` and `sessionId` to context for downstream routes.

import type { MiddlewareHandler } from 'hono';
import { loadSession } from './session';
import type { Env } from '../env';

export type AuthVars = {
  userId: string;
  sessionId: string;
};

export const requireSession: MiddlewareHandler<{ Bindings: Env; Variables: AuthVars }> = async (
  c,
  next
) => {
  const session = await loadSession(c.env, c.req.header('Cookie') ?? null);
  if (!session) return c.json({ error: 'unauthenticated' }, 401);
  c.set('userId', session.userId);
  c.set('sessionId', session.sessionId);
  await next();
};

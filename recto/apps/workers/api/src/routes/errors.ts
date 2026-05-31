// GET /api/errors/messages — returns the failure-code → human message map.
// The UI loads this once and uses it to render any failure_code that
// appears in pushes or audit responses.

import { Hono } from 'hono';
import type { Env } from '../env';
import { ERROR_MESSAGES } from '../lib/error-messages';

export const errorsRouter = new Hono<{ Bindings: Env }>();

errorsRouter.get('/messages', (c) => c.json({ messages: ERROR_MESSAGES }));

// Audit log + push initiation.
//
// POST /api/pushes        — user approves a candidate, queues a push.
// GET  /api/pushes        — paginated audit log for the calling user.
// POST /api/pushes/:id/retry — manual retry after a failure (clears
//                              failure code, requeues).

import { Hono } from 'hono';
import { z } from 'zod';
import type { Env } from '../env';
import { ulid } from '../lib/ids';
import { requireSession, type AuthVars } from '../auth/middleware';

export const pushesRouter = new Hono<{ Bindings: Env; Variables: AuthVars }>();
pushesRouter.use('*', requireSession);

const PushBody = z.object({ candidateId: z.string().min(1) });

pushesRouter.post('/', async (c) => {
  const parsed = PushBody.safeParse(await c.req.json().catch(() => ({})));
  if (!parsed.success) return c.json({ error: 'invalid_body' }, 400);

  const userId = c.get('userId');
  const cand = await c.env.DB.prepare(
    `SELECT c.id
       FROM candidates c
       JOIN pages p ON p.id = c.source_page_id
       JOIN sites s ON s.id = p.site_id
      WHERE c.id = ? AND s.user_id = ?`
  )
    .bind(parsed.data.candidateId, userId)
    .first<{ id: string }>();
  if (!cand) return c.json({ error: 'candidate_not_found' }, 404);

  const id = ulid();
  await c.env.DB.prepare(
    `INSERT INTO pushes (id, user_id, candidate_id, pushed_at, status)
     VALUES (?, ?, ?, ?, 'pending')`
  )
    .bind(id, userId, cand.id, Date.now())
    .run();
  await c.env.Q_PUSH.send({ pushId: id });
  return c.json({ id, status: 'pending' }, 202);
});

pushesRouter.get('/', async (c) => {
  const userId = c.get('userId');
  const rawLimit = Number(c.req.query('limit') ?? 50);
  const limit = Number.isFinite(rawLimit) ? Math.max(1, Math.min(200, Math.floor(rawLimit))) : 50;
  const status = c.req.query('status');
  const where = status ? 'WHERE pu.user_id = ? AND pu.status = ?' : 'WHERE pu.user_id = ?';
  const params: unknown[] = status ? [userId, status, limit] : [userId, limit];

  const rows = await c.env.DB.prepare(
    `SELECT
       pu.id, pu.status, pu.pushed_at, pu.failure_code, pu.failure_msg,
       pu.verified_at, pu.verified_via,
       c.anchor_text,
       op.slug AS orphan_slug,
       sp.slug AS source_slug,
       s.url   AS site_url
     FROM pushes pu
     JOIN candidates c ON c.id = pu.candidate_id
     JOIN pages op     ON op.id = c.orphan_page_id
     JOIN pages sp     ON sp.id = c.source_page_id
     JOIN sites s      ON s.id = sp.site_id
     ${where}
     ORDER BY pu.pushed_at DESC
     LIMIT ?`
  )
    .bind(...params)
    .all();

  return c.json({ pushes: rows.results ?? [] });
});

pushesRouter.post('/:id/retry', async (c) => {
  const id = c.req.param('id');
  const userId = c.get('userId');
  const row = await c.env.DB.prepare(
    'SELECT id, status FROM pushes WHERE id = ? AND user_id = ?'
  )
    .bind(id, userId)
    .first<{ id: string; status: string }>();
  if (!row) return c.json({ error: 'not_found' }, 404);
  if (row.status !== 'failed') return c.json({ error: 'only_failed_pushes_can_be_retried' }, 409);

  await c.env.DB.prepare(
    `UPDATE pushes SET status='pending', failure_code=NULL, failure_msg=NULL WHERE id = ?`
  )
    .bind(id)
    .run();
  await c.env.Q_PUSH.send({ pushId: id });
  return c.json({ id, status: 'pending' });
});

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
    `SELECT c.id, c.anchor_text
       FROM candidates c
       JOIN pages p ON p.id = c.source_page_id
       JOIN sites s ON s.id = p.site_id
      WHERE c.id = ? AND s.user_id = ?`
  )
    .bind(parsed.data.candidateId, userId)
    .first<{ id: string; anchor_text: string | null }>();
  if (!cand) return c.json({ error: 'candidate_not_found' }, 404);
  // A candidate with an empty anchor_text is the "needs hand-pick" state — the
  // auto-selector found no verbatim phrase. Pushing it would just fail later as
  // wp_anchor_not_found; reject up front with an actionable message so the user
  // hand-picks a phrase first. (Hardened 2026-06-06.)
  if (!cand.anchor_text || !cand.anchor_text.trim()) {
    return c.json({ error: 'anchor_required', message: 'Pick or write an anchor phrase before pushing.' }, 422);
  }

  // Idempotency at the source. A double-click (or a retried request) would mint a
  // second push row for the SAME candidate — two q-push messages, two WP
  // round-trips, two verify enqueues, and a duplicate audit-log entry for one
  // user action. The per-pushId job guard only dedups REDELIVERY of one message,
  // and wp_already_linked only protects the CMS — neither stops a second ROW. If
  // an active (non-terminal) push already exists for this candidate, return it
  // instead of creating a duplicate. 'failed'/'undone' do NOT block — those are
  // legitimately re-pushable (see /retry and the re-link-after-undo flow).
  // (Hardened 2026-06-07.) Backstop for a true concurrent race: the job's
  // wp_already_linked short-circuit still prevents a duplicate live link.
  const existing = await c.env.DB.prepare(
    `SELECT id, status FROM pushes
      WHERE candidate_id = ? AND user_id = ? AND status IN ('pending','pushed','verified')
      ORDER BY pushed_at DESC LIMIT 1`
  )
    .bind(cand.id, userId)
    .first<{ id: string; status: string }>();
  if (existing) {
    return c.json({ id: existing.id, status: existing.status, deduped: true }, 200);
  }

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
  // Only honor a known status value; anything else is ignored (returns the full
  // list) rather than silently matching zero rows on a typo'd filter.
  const VALID_STATUS = new Set(['pending', 'pushed', 'verified', 'failed', 'undone']);
  const statusRaw = c.req.query('status');
  const status = statusRaw && VALID_STATUS.has(statusRaw) ? statusRaw : undefined;
  const where = status ? 'WHERE pu.user_id = ? AND pu.status = ?' : 'WHERE pu.user_id = ?';
  const params: unknown[] = status ? [userId, status, limit] : [userId, limit];

  const rows = await c.env.DB.prepare(
    `SELECT
       pu.id, pu.status, pu.pushed_at, pu.failure_code, pu.failure_msg,
       pu.verified_at, pu.verified_via,
       c.anchor_text,
       op.slug AS orphan_slug,
       sp.slug AS source_slug,
       s.url   AS site_url,
       s.id    AS site_id
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

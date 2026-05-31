// GET /api/sites/:id/orphans/:orphanId/candidates
//   Returns ranked source-page candidates for the orphan. Uses Vectorize to
//   find the top-K semantically-nearest pages, joins to GSC for source
//   authority, and generates the anchor text via Workers AI (or BYOK).
//
// POST /api/candidates/:id/regenerate-anchor
//   Re-rolls just the anchor text for a candidate without re-scoring.

import { Hono } from 'hono';
import type { Env } from '../env';
import { ulid } from '../lib/ids';
import { requireSession, type AuthVars } from '../auth/middleware';
import { generateAnchor } from '../integrations/anchor-gen';
import { lexicalTopK, deterministicAnchor } from '../lib/lexical-sim';

// Two routers — split because they mount on different prefixes (sites vs
// candidates) and we don't want a `.use('*')` to intercept other routers
// sharing those prefixes (e.g. /api/errors).
export const candidatesRouter = new Hono<{ Bindings: Env; Variables: AuthVars }>();
export const regenerateAnchorRouter = new Hono<{ Bindings: Env; Variables: AuthVars }>();

const TOP_K = 8;

candidatesRouter.get('/:siteId/orphans/:orphanId/candidates', requireSession, async (c) => {
  const userId = c.get('userId');
  const { siteId, orphanId } = c.req.param();

  // Auth + load orphan.
  const orphan = await c.env.DB.prepare(
    `SELECT p.id, p.slug, p.title, p.h1, p.excerpt
       FROM pages p JOIN sites s ON s.id = p.site_id
      WHERE p.id = ? AND s.id = ? AND s.user_id = ?`
  )
    .bind(orphanId, siteId, userId)
    .first<{
      id: string;
      slug: string;
      title: string | null;
      h1: string | null;
      excerpt: string | null;
    }>();
  if (!orphan) return c.json({ error: 'orphan_not_found' }, 404);

  // Resolve top-K source pages. Production uses Vectorize cosine on Workers AI
  // BGE embeddings. Local wrangler dev has no Vectorize binding — fall back to
  // an in-process lexical similarity over title+h1+excerpt so the SPA loop and
  // smoke tests work without a deployed index.
  let candidateIds: string[] = [];
  let similarityById = new Map<string, number>();
  const hasVectorize = !!c.env.VECTORIZE && typeof c.env.VECTORIZE.getByIds === 'function';

  if (hasVectorize) {
    const orphanVector = await c.env.VECTORIZE.getByIds([orphan.id]);
    const queryVector = orphanVector[0]?.values;
    if (!queryVector) {
      return c.json({ orphan: { id: orphan.id, slug: orphan.slug }, candidates: [], embeddingPending: true });
    }
    const matches = await c.env.VECTORIZE.query(queryVector, {
      topK: TOP_K + 1,
      filter: { site_id: siteId },
      returnMetadata: true,
    });
    candidateIds = (matches.matches ?? [])
      .filter((m) => m.id !== orphan.id)
      .slice(0, TOP_K)
      .map((m) => m.id);
    similarityById = new Map((matches.matches ?? []).map((m) => [m.id, m.score]));
  } else {
    // Lexical fallback: rank all same-site content pages by token overlap.
    const pool = await c.env.DB.prepare(
      `SELECT p.id, p.title, p.h1, p.excerpt
         FROM pages p
        WHERE p.site_id = ?
          AND p.slug NOT IN ('/wp-admin','/wp-login.php','/sample-page','/hello-world','/wp-json','/feed','/comments/feed','/wp-sitemap.xml','/xmlrpc.php','/wp-cron.php')
          AND p.slug NOT LIKE '/wp-admin/%'
          AND p.slug NOT LIKE '/wp-content/%'
          AND p.slug NOT LIKE '/wp-includes/%'
          AND p.slug NOT LIKE '/wp-json/%'
          AND p.slug NOT LIKE '/feed/%'
          AND p.slug NOT LIKE '/author/%'
          AND p.slug NOT LIKE '/tag/%'
          AND p.slug NOT LIKE '/category/%'
          AND p.slug NOT LIKE '/page/%'`
    )
      .bind(siteId)
      .all<{ id: string; title: string | null; h1: string | null; excerpt: string | null }>();
    const ranked = lexicalTopK(
      { id: orphan.id, title: orphan.title, h1: orphan.h1, excerpt: orphan.excerpt },
      pool.results ?? [],
      TOP_K
    );
    candidateIds = ranked.map((r) => r.id);
    similarityById = new Map(ranked.map((r) => [r.id, r.similarity]));
  }

  if (candidateIds.length === 0) {
    return c.json({ orphan: { id: orphan.id, slug: orphan.slug }, candidates: [] });
  }

  const placeholders = candidateIds.map(() => '?').join(',');
  const sourceRows = await c.env.DB.prepare(
    `SELECT p.id, p.slug, p.title, p.h1, p.excerpt,
            COALESCE(SUM(g.impressions), 0) AS impressions_28d
       FROM pages p
       LEFT JOIN gsc_data g ON g.page_id = p.id AND g.day >= date('now','-28 day')
      WHERE p.id IN (${placeholders})
      GROUP BY p.id, p.slug, p.title, p.h1, p.excerpt`
  )
    .bind(...candidateIds)
    .all<{
      id: string;
      slug: string;
      title: string | null;
      h1: string | null;
      excerpt: string | null;
      impressions_28d: number;
    }>();

  // Load the user's anchor-gen preferences once.
  const user = await c.env.DB.prepare(
    'SELECT byok_openai_key, byok_anthropic_key, digest_opt_in FROM users WHERE id = ?'
  )
    .bind(userId)
    .first<{
      byok_openai_key: Uint8Array | null;
      byok_anthropic_key: Uint8Array | null;
      digest_opt_in: number;
    }>();
  const preferByok = !!(user && (user.byok_openai_key || user.byok_anthropic_key));

  const candidates: Array<{
    id: string;
    sourceSlug: string;
    sourceTitle: string | null;
    similarity: number;
    sourceAuthority: number;
    anchorText: string;
    paragraphExcerpt: string;
    llmProvider: string;
  }> = [];

  const hasAI = !!c.env.AI && typeof (c.env.AI as Ai).run === 'function';

  for (const row of sourceRows.results ?? []) {
    const similarity = similarityById.get(row.id) ?? 0;
    const sourceAuthority = Math.round(Math.log1p(row.impressions_28d) * 100);

    const sourceParagraph = row.excerpt ?? row.h1 ?? row.title ?? '';
    let gen: { anchor: string; provider: string; tokensApprox: number };
    if (hasAI || preferByok) {
      gen = await generateAnchor(
        { AI: c.env.AI, RECTO_KEK: c.env.RECTO_KEK },
        {
          byok_openai_key: user?.byok_openai_key ?? null,
          byok_anthropic_key: user?.byok_anthropic_key ?? null,
          preferByok,
        },
        {
          sourceParagraph,
          targetTitle: orphan.title,
          targetH1: orphan.h1,
          targetExcerpt: orphan.excerpt,
        }
      );
    } else {
      // Local dev: no Workers AI binding. Deterministic anchor from orphan title.
      gen = {
        anchor: deterministicAnchor(orphan.title, orphan.h1, sourceParagraph),
        provider: 'local-lexical',
        tokensApprox: 0,
      };
    }

    // Find any existing candidate row for (orphan, source). If one exists
    // it may be referenced by a push (FK); INSERT OR REPLACE would delete it
    // and break the FK. Reuse the existing row's id and UPDATE in place.
    const existing = await c.env.DB.prepare(
      'SELECT id FROM candidates WHERE orphan_page_id = ? AND source_page_id = ?'
    )
      .bind(orphan.id, row.id)
      .first<{ id: string }>();
    const id = existing?.id ?? ulid();
    await c.env.DB.prepare(
      existing
        ? `UPDATE candidates SET similarity = ?, source_authority = ?, anchor_text = ?, paragraph_excerpt = ?, generated_at = ?, llm_provider = ?, cost_neurons = ? WHERE id = ?`
        : `INSERT INTO candidates (id, orphan_page_id, source_page_id, similarity, source_authority, anchor_text, paragraph_excerpt, generated_at, llm_provider, cost_neurons) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
      .bind(
        ...(existing
          ? [similarity, sourceAuthority, gen.anchor, row.excerpt ?? '', Date.now(), gen.provider, gen.tokensApprox, id]
          : [id, orphan.id, row.id, similarity, sourceAuthority, gen.anchor, row.excerpt ?? '', Date.now(), gen.provider, gen.tokensApprox])
      )
      .run();

    candidates.push({
      id,
      sourceSlug: row.slug,
      sourceTitle: row.title,
      similarity: +similarity.toFixed(3),
      sourceAuthority,
      anchorText: gen.anchor,
      paragraphExcerpt: row.excerpt ?? '',
      llmProvider: gen.provider,
    });
  }

  return c.json({
    orphan: { id: orphan.id, slug: orphan.slug, title: orphan.title, h1: orphan.h1 },
    candidates: candidates.sort((a, b) => b.similarity - a.similarity),
  });
});

// Manual anchor override. The insertion UI lets users edit the LLM-generated
// anchor inline before pushing. This stores the user's text on the candidate
// so the push job reads the override, not the LLM original.
regenerateAnchorRouter.put('/:id/anchor', requireSession, async (c) => {
  const userId = c.get('userId');
  const id = c.req.param('id');
  const body = (await c.req.json().catch(() => ({}))) as { anchorText?: unknown };
  const anchorText = typeof body.anchorText === 'string' ? body.anchorText.trim() : '';
  if (!anchorText || anchorText.length > 200) return c.json({ error: 'invalid_anchor' }, 400);

  const owns = await c.env.DB.prepare(
    `SELECT c.id FROM candidates c
       JOIN pages sp ON sp.id = c.source_page_id
       JOIN sites s ON s.id = sp.site_id
      WHERE c.id = ? AND s.user_id = ?`
  )
    .bind(id, userId)
    .first<{ id: string }>();
  if (!owns) return c.json({ error: 'not_found' }, 404);

  await c.env.DB.prepare(
    `UPDATE candidates SET anchor_text = ?, generated_at = ?, llm_provider = 'manual' WHERE id = ?`
  )
    .bind(anchorText, Date.now(), id)
    .run();
  return c.json({ id, anchorText, provider: 'manual' });
});

regenerateAnchorRouter.post('/:id/regenerate-anchor', requireSession, async (c) => {
  const userId = c.get('userId');
  const id = c.req.param('id');

  const row = await c.env.DB.prepare(
    `SELECT c.id, c.orphan_page_id, c.source_page_id, c.paragraph_excerpt,
            op.title AS orphan_title, op.h1 AS orphan_h1, op.excerpt AS orphan_excerpt
       FROM candidates c
       JOIN pages op ON op.id = c.orphan_page_id
       JOIN pages sp ON sp.id = c.source_page_id
       JOIN sites s ON s.id = sp.site_id
      WHERE c.id = ? AND s.user_id = ?`
  )
    .bind(id, userId)
    .first<{
      id: string;
      paragraph_excerpt: string;
      orphan_title: string | null;
      orphan_h1: string | null;
      orphan_excerpt: string | null;
    }>();
  if (!row) return c.json({ error: 'not_found' }, 404);

  const user = await c.env.DB.prepare(
    'SELECT byok_openai_key, byok_anthropic_key FROM users WHERE id = ?'
  )
    .bind(userId)
    .first<{ byok_openai_key: Uint8Array | null; byok_anthropic_key: Uint8Array | null }>();

  const hasAI = !!c.env.AI && typeof (c.env.AI as Ai).run === 'function';
  const preferByok = !!(user && (user.byok_openai_key || user.byok_anthropic_key));
  let gen: { anchor: string; provider: string; tokensApprox: number };
  if (hasAI || preferByok) {
    gen = await generateAnchor(
      { AI: c.env.AI, RECTO_KEK: c.env.RECTO_KEK },
      {
        byok_openai_key: user?.byok_openai_key ?? null,
        byok_anthropic_key: user?.byok_anthropic_key ?? null,
        preferByok,
      },
      {
        sourceParagraph: row.paragraph_excerpt,
        targetTitle: row.orphan_title,
        targetH1: row.orphan_h1,
        targetExcerpt: row.orphan_excerpt,
      }
    );
  } else {
    gen = {
      anchor: deterministicAnchor(row.orphan_title, row.orphan_h1, row.paragraph_excerpt),
      provider: 'local-lexical',
      tokensApprox: 0,
    };
  }
  await c.env.DB.prepare(
    'UPDATE candidates SET anchor_text = ?, generated_at = ?, llm_provider = ? WHERE id = ?'
  )
    .bind(gen.anchor, Date.now(), gen.provider, id)
    .run();

  return c.json({ id, anchorText: gen.anchor, provider: gen.provider });
});

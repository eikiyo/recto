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
import { selectAnchorPhrase, sanitizeSourceBody } from '../integrations/anchor-select';
import { lexicalTopK } from '../lib/lexical-sim';
import { phraseInText, normalizePhrase } from '../lib/phrase';

// Two routers — split because they mount on different prefixes (sites vs
// candidates) and we don't want a `.use('*')` to intercept other routers
// sharing those prefixes (e.g. /api/errors).
export const candidatesRouter = new Hono<{ Bindings: Env; Variables: AuthVars }>();
export const regenerateAnchorRouter = new Hono<{ Bindings: Env; Variables: AuthVars }>();

const TOP_K = 8;
// How many candidates the insertion UI actually renders. Eager anchor
// generation (one Workers-AI call each) is capped to this — see the slice below.
const SHOW_K = 3;

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

  // CACHE-FIRST. Candidates (incl. their anchors) are stored on first compute
  // and prewarmed in the background after a crawl, so a "Fix this" click reads
  // them instantly instead of waiting on Vectorize + a Workers-AI anchor call
  // per row. ?refresh=1 forces a recompute. This is the difference between an
  // instant page and a multi-second "Loading candidates…" spinner (2026-06-06).
  const wantsRefresh = c.req.query('refresh') === '1';
  if (!wantsRefresh) {
    const cached = await c.env.DB.prepare(
      `SELECT cd.id, cd.similarity, cd.source_authority, cd.anchor_text, cd.paragraph_excerpt, cd.llm_provider,
              sp.slug AS source_slug, sp.title AS source_title, sp.excerpt AS source_excerpt
         FROM candidates cd
         JOIN pages sp ON sp.id = cd.source_page_id
        WHERE cd.orphan_page_id = ?
        ORDER BY cd.similarity DESC`
    )
      .bind(orphan.id)
      .all<{
        id: string;
        similarity: number;
        source_authority: number;
        anchor_text: string;
        paragraph_excerpt: string | null;
        llm_provider: string;
        source_slug: string;
        source_title: string | null;
        source_excerpt: string | null;
      }>();
    if ((cached.results ?? []).length > 0) {
      return c.json({
        orphan: { id: orphan.id, slug: orphan.slug, title: orphan.title, h1: orphan.h1 },
        cached: true,
        candidates: (cached.results ?? []).map((row) => ({
          id: row.id,
          sourceSlug: row.source_slug,
          sourceTitle: row.source_title,
          similarity: +(row.similarity ?? 0).toFixed(3),
          sourceAuthority: row.source_authority,
          anchorText: row.anchor_text,
          // The anchor is an existing phrase from the source paragraph. When the
          // selector found none, anchor_text is empty → the UI offers hand-pick.
          paragraphExcerpt: row.paragraph_excerpt ?? row.source_excerpt ?? '',
          needsHandpick: !(row.anchor_text && row.anchor_text.trim()),
          llmProvider: row.llm_provider,
        })),
      });
    }
  }

  // Resolve top-K source pages. Production uses Vectorize cosine on Workers AI
  // BGE embeddings. Local wrangler dev has no Vectorize binding — fall back to
  // an in-process lexical similarity over title+h1+excerpt so the SPA loop and
  // smoke tests work without a deployed index.
  let candidateIds: string[] = [];
  let similarityById = new Map<string, number>();
  const hasVectorize = !!c.env.VECTORIZE && typeof c.env.VECTORIZE.getByIds === 'function';

  // Lexical fallback: rank all same-site content pages by token overlap. Used
  // when there's no Vectorize binding (local dev) AND as a SAFETY NET when a
  // deployed Vectorize index returns nothing (e.g. a missing metadata index on
  // site_id silently zeroes filtered queries — that shipped once and made the
  // core "Where to link from" empty for every orphan, 2026-06-06). The product
  // must NEVER show an empty candidate list when sibling pages exist.
  const lexicalFallback = async () => {
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
      (pool.results ?? []).filter((p) => p.id !== orphan.id),
      TOP_K
    );
    candidateIds = ranked.map((r) => r.id);
    similarityById = new Map(ranked.map((r) => [r.id, r.similarity]));
  };

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

    // Vectorize gave nothing but the orphan IS embedded — almost always a
    // misconfigured index (missing metadata index, mutation lag). Degrade to
    // lexical rather than show the user an empty product.
    if (candidateIds.length === 0) {
      console.warn('candidates: vectorize returned 0 with a present orphan vector — falling back to lexical', { siteId, orphanId: orphan.id });
      await lexicalFallback();
    }
  } else {
    await lexicalFallback();
  }

  if (candidateIds.length === 0) {
    // Genuinely no sibling content pages (e.g. a brand-new site whose only page
    // is this one). An empty list here is CORRECT, not a misconfiguration — log
    // so it's distinguishable from the Vectorize silent-zero case logged above.
    console.warn('candidates: no sibling pages to link from', { siteId, orphanId: orphan.id });
    return c.json({ orphan: { id: orphan.id, slug: orphan.slug }, candidates: [] });
  }

  // Only the top-ranked candidates are shown, and each one costs a Workers-AI
  // anchor call. Generating anchors for all TOP_K neighbours was the bulk of the
  // click latency — cap eager generation to what the UI renders (2026-06-06).
  candidateIds = candidateIds.slice(0, SHOW_K);

  const placeholders = candidateIds.map(() => '?').join(',');
  const sourceRows = await c.env.DB.prepare(
    `SELECT p.id, p.slug, p.title, p.h1, p.excerpt, p.body_text,
            COALESCE(SUM(g.impressions), 0) AS impressions_28d
       FROM pages p
       LEFT JOIN gsc_data g ON g.page_id = p.id AND g.day >= date('now','-28 day')
      WHERE p.id IN (${placeholders})
      GROUP BY p.id, p.slug, p.title, p.h1, p.excerpt, p.body_text`
  )
    .bind(...candidateIds)
    .all<{
      id: string;
      slug: string;
      title: string | null;
      h1: string | null;
      excerpt: string | null;
      body_text: string | null;
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
    needsHandpick: boolean;
    llmProvider: string;
  }> = [];

  // Generate the anchor selections for all shown candidates in PARALLEL. Each
  // selectAnchorPhrase is an independent Workers-AI call (up to 2 model
  // round-trips each, strict=false then strict=true) with no shared state. The
  // old sequential `for await` stacked them, so cold "Fix this" latency was
  // ~SHOW_K × (1-2 model round-trips). Overlapping them collapses that to ~the
  // slowest single candidate. DB writes below stay sequential (safe, unchanged
  // — distinct (orphan, source) rows). (Perf 2026-06-07.)
  const srcRows = sourceRows.results ?? [];
  const sels = await Promise.all(
    srcRows.map((row) =>
      selectAnchorPhrase(
        { AI: c.env.AI, RECTO_KEK: c.env.RECTO_KEK },
        {
          byok_openai_key: user?.byok_openai_key ?? null,
          byok_anthropic_key: user?.byok_anthropic_key ?? null,
          preferByok,
        },
        {
          // Prefer full body_text; fall back to excerpt for pages crawled
          // before body_text shipped.
          sourceBody: row.body_text ?? row.excerpt ?? '',
          targetTitle: orphan.title,
          targetH1: orphan.h1,
          targetExcerpt: orphan.excerpt,
          sourceTitle: row.title,
          sourceH1: row.h1,
        }
      )
    )
  );

  for (let i = 0; i < srcRows.length; i++) {
    const row = srcRows[i]!;
    const sel = sels[i]!;
    const similarity = similarityById.get(row.id) ?? 0;
    const sourceAuthority = Math.round(Math.log1p(row.impressions_28d) * 100);

    const anchorText = sel.phrase ?? '';
    const paragraphExcerpt = sel.paragraph || row.excerpt || '';

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
          ? [similarity, sourceAuthority, anchorText, paragraphExcerpt, Date.now(), sel.provider, sel.tokensApprox, id]
          : [id, orphan.id, row.id, similarity, sourceAuthority, anchorText, paragraphExcerpt, Date.now(), sel.provider, sel.tokensApprox])
      )
      .run();

    candidates.push({
      id,
      sourceSlug: row.slug,
      sourceTitle: row.title,
      similarity: +similarity.toFixed(3),
      sourceAuthority,
      anchorText,
      paragraphExcerpt,
      needsHandpick: sel.phrase === null,
      llmProvider: sel.provider,
    });
  }

  return c.json({
    orphan: { id: orphan.id, slug: orphan.slug, title: orphan.title, h1: orphan.h1 },
    candidates: candidates.sort((a, b) => b.similarity - a.similarity),
  });
});

// Manual anchor override (also used by hand-pick). The insertion UI lets users
// edit the anchor or pick their own phrase before pushing. The anchor we push
// must be a phrase that ALREADY exists in the source post — so we reject any
// override that is not a verbatim substring of the source body. This is the
// server-side guarantee behind "we never change the blog's words", and it stops
// a push that would later fail as wp_anchor_not_found.
regenerateAnchorRouter.put('/:id/anchor', requireSession, async (c) => {
  const userId = c.get('userId');
  const id = c.req.param('id');
  const body = (await c.req.json().catch(() => ({}))) as { anchorText?: unknown };
  const anchorText = typeof body.anchorText === 'string' ? body.anchorText.trim() : '';
  if (!anchorText || anchorText.length > 200) return c.json({ error: 'invalid_anchor' }, 400);

  const owns = await c.env.DB.prepare(
    `SELECT c.id, sp.body_text AS source_body, sp.excerpt AS source_excerpt
       FROM candidates c
       JOIN pages sp ON sp.id = c.source_page_id
       JOIN sites s ON s.id = sp.site_id
      WHERE c.id = ? AND s.user_id = ?`
  )
    .bind(id, userId)
    .first<{ id: string; source_body: string | null; source_excerpt: string | null }>();
  if (!owns) return c.json({ error: 'not_found' }, 404);

  const sourceBody = owns.source_body ?? owns.source_excerpt ?? '';
  if (!phraseInText(sourceBody, anchorText)) {
    return c.json(
      { error: 'anchor_not_in_source', message: 'The anchor must be text that already exists in the source post.' },
      422
    );
  }

  await c.env.DB.prepare(
    `UPDATE candidates SET anchor_text = ?, generated_at = ?, llm_provider = 'manual' WHERE id = ?`
  )
    .bind(normalizePhrase(anchorText), Date.now(), id)
    .run();
  return c.json({ id, anchorText: normalizePhrase(anchorText), provider: 'manual' });
});

// Hand-pick source. Returns the source post's prose so the UI can let the user
// select their own phrase to wrap when the auto-pick is empty or wrong. The user
// selects text from THIS body; the PUT above then validates it is a real
// substring before storing — closing the loop on "only existing text".
regenerateAnchorRouter.get('/:id/source', requireSession, async (c) => {
  const userId = c.get('userId');
  const id = c.req.param('id');
  const row = await c.env.DB.prepare(
    `SELECT sp.slug AS source_slug, sp.title AS source_title, sp.h1 AS source_h1,
            sp.body_text AS source_body, sp.excerpt AS source_excerpt
       FROM candidates c
       JOIN pages sp ON sp.id = c.source_page_id
       JOIN sites s ON s.id = sp.site_id
      WHERE c.id = ? AND s.user_id = ?`
  )
    .bind(id, userId)
    .first<{
      source_slug: string;
      source_title: string | null;
      source_h1: string | null;
      source_body: string | null;
      source_excerpt: string | null;
    }>();
  if (!row) return c.json({ error: 'not_found' }, 404);

  const body = normalizePhrase(
    sanitizeSourceBody(row.source_body ?? row.source_excerpt ?? '', row.source_title, row.source_h1)
  );
  const sentences = body
    .split(/(?<=[.!?])\s+/)
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
  return c.json({
    sourceSlug: row.source_slug,
    sourceTitle: row.source_title,
    sentences,
  });
});

regenerateAnchorRouter.post('/:id/regenerate-anchor', requireSession, async (c) => {
  const userId = c.get('userId');
  const id = c.req.param('id');

  const row = await c.env.DB.prepare(
    `SELECT c.id, c.orphan_page_id, c.source_page_id,
            sp.body_text AS source_body, sp.excerpt AS source_excerpt,
            sp.title AS source_title, sp.h1 AS source_h1,
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
      source_body: string | null;
      source_excerpt: string | null;
      source_title: string | null;
      source_h1: string | null;
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
  const preferByok = !!(user && (user.byok_openai_key || user.byok_anthropic_key));

  // Re-select a (possibly different) existing phrase from the source body.
  const sel = await selectAnchorPhrase(
    { AI: c.env.AI, RECTO_KEK: c.env.RECTO_KEK },
    {
      byok_openai_key: user?.byok_openai_key ?? null,
      byok_anthropic_key: user?.byok_anthropic_key ?? null,
      preferByok,
    },
    {
      sourceBody: row.source_body ?? row.source_excerpt ?? '',
      targetTitle: row.orphan_title,
      targetH1: row.orphan_h1,
      targetExcerpt: row.orphan_excerpt,
      sourceTitle: row.source_title,
      sourceH1: row.source_h1,
    }
  );

  await c.env.DB.prepare(
    'UPDATE candidates SET anchor_text = ?, paragraph_excerpt = ?, generated_at = ?, llm_provider = ? WHERE id = ?'
  )
    .bind(sel.phrase ?? '', sel.paragraph, Date.now(), sel.provider, id)
    .run();

  return c.json({
    id,
    anchorText: sel.phrase ?? '',
    paragraphExcerpt: sel.paragraph,
    needsHandpick: sel.phrase === null,
    provider: sel.provider,
  });
});

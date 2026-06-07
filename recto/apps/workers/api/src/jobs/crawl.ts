// q-crawl consumer. One message per crawl tick.
//
// Pulls a batch from the CrawlSession DO, fetches each URL with polite delay,
// extracts via HTMLRewriter, persists to D1, ticks the DO. If more work remains,
// self-enqueues another tick. If done, queues the crawl-complete email.

import type { Env } from '../env';
import { extract, contentHash } from '../lib/extract';
import { normalizeUrl, pathOf, sameOrigin } from '../lib/url-norm';
import { ulid } from '../lib/ids';
import { retryOrDrop } from '../lib/queue';
import { fetchWithTimeout } from '../lib/http';

type CrawlMsg = { siteId: string; trigger: 'manual' | 'scheduled'; crawlId: string };

const POLITENESS_MS = 1000; // 1 req/s per site default
const PER_INVOCATION_BUDGET_MS = 22_000; // stay under queue-consumer timeout
const MAX_TICK_DELIVERIES = 5; // bound retries on a wedged tick (DO/DB failures)
const CRAWL_FETCH_TIMEOUT_MS = 12_000; // a slow page can't blow the per-invocation budget

export async function handleCrawlBatch(
  batch: MessageBatch<CrawlMsg>,
  env: Env
): Promise<void> {
  for (const msg of batch.messages) {
    try {
      const cont = await runCrawlTick(env, msg.body);
      if (cont) {
        await env.Q_CRAWL.send(msg.body, { delaySeconds: 1 });
      }
      msg.ack();
    } catch (e) {
      retryOrDrop(msg, 'crawl', { siteId: msg.body.siteId, crawlId: msg.body.crawlId, error: (e as Error).message }, MAX_TICK_DELIVERIES, 30);
    }
  }
}

async function runCrawlTick(env: Env, job: CrawlMsg): Promise<boolean> {
  const doId = env.CRAWL_SESSION.idFromName(job.crawlId);
  const stub = env.CRAWL_SESSION.get(doId);

  const started = Date.now();

  // Get a batch of URLs from the DO.
  const workRes = await stub.fetch('https://do/work', { method: 'POST' });
  const work = (await workRes.json()) as { batch: string[]; remaining: number };

  if (work.batch.length === 0) {
    // Defensive: if a tick fires with no batch and no remaining, finalize.
    if (work.remaining === 0) {
      await finalize(env, job);
    }
    return false;
  }

  const processed: { url: string; ok: boolean; slug?: string }[] = [];
  const discovered: string[] = [];

  // Track where we stop so the URLs we pulled but didn't reach can be returned
  // to the DO queue. /work already SPLICED this batch out of the queue; with
  // BATCH_SIZE=25 and POLITENESS_MS=1000 the 22s budget is hit mid-batch on
  // nearly every tick, so without re-queuing the tail those pages were silently
  // dropped from the crawl (the site under-covered). (Hardened 2026-06-07.)
  let i = 0;
  for (; i < work.batch.length; i++) {
    const url = work.batch[i]!;
    if (Date.now() - started > PER_INVOCATION_BUDGET_MS) break;
    try {
      const result = await crawlOne(env, job.siteId, url);
      processed.push({ url, ok: true, slug: result.slug });
      for (const link of result.discovered) {
        if (!discovered.includes(link)) discovered.push(link);
      }
    } catch (e) {
      // Per-URL failure: mark visited so we don't loop, but don't fail the tick.
      processed.push({ url, ok: false });
      console.warn('crawl page failed', { url, error: (e as Error).message });
    }
    // Politeness — yields between requests within the budget.
    await sleep(POLITENESS_MS);
  }
  // URLs pulled from the DO but not reached this tick (budget hit at index i).
  const unprocessed = work.batch.slice(i);

  // Persist progress; DO returns whether more work remains.
  const persistRes = await stub.fetch('https://do/persist', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ processed, discovered, unprocessed }),
  });
  const persisted = (await persistRes.json()) as { ok: boolean; remaining: number; complete: boolean };

  if (persisted.complete) {
    await finalize(env, job);
    return false;
  }
  return true;
}

async function finalize(env: Env, job: CrawlMsg): Promise<void> {
  await reconcileEdges(env, job.siteId);
  await env.DB.prepare(
    'UPDATE sites SET last_crawl_at = ?, crawl_pages = (SELECT COUNT(*) FROM pages WHERE site_id = ?) WHERE id = ?'
  )
    .bind(Date.now(), job.siteId, job.siteId)
    .run();

  // Fan out embeds. q-embed consumer skips pages whose vector content_hash
  // already matches, so re-crawls don't re-invoke Workers AI unnecessarily.
  const pageRows = await env.DB.prepare('SELECT id FROM pages WHERE site_id = ?')
    .bind(job.siteId)
    .all<{ id: string }>();
  const ids = (pageRows.results ?? []).map((r) => r.id);
  if (ids.length > 0) {
    const messages = ids.map((id) => ({ body: { siteId: job.siteId, pageId: id } }));
    // sendBatch caps at 100; chunk if a site is larger.
    for (let i = 0; i < messages.length; i += 100) {
      await env.Q_EMBED.sendBatch(messages.slice(i, i + 100));
    }
  }

  const user = await env.DB.prepare('SELECT user_id FROM sites WHERE id = ?').bind(job.siteId).first<{ user_id: string }>();
  const siteRow = await env.DB.prepare('SELECT url FROM sites WHERE id = ?').bind(job.siteId).first<{ url: string }>();
  if (user && siteRow) {
    await env.Q_EMAIL.send({
      template: 'crawl-complete',
      userId: user.user_id,
      data: { siteUrl: siteRow.url, siteId: job.siteId, pages: ids.length },
    });
  }
}

// ────────────────────────────────────────────────────────────────────────────

async function crawlOne(
  env: Env,
  siteId: string,
  url: string
): Promise<{ slug: string; discovered: string[] }> {
  let res: Response;
  try {
    res = await fetchWithTimeout(url, {
      headers: {
        'User-Agent': 'recto-crawler/1.0 (+https://recto.so)',
        Accept: 'text/html,application/xhtml+xml',
      },
      cf: { cacheTtl: 0 } as RequestInitCfProperties,
    }, CRAWL_FETCH_TIMEOUT_MS);
  } catch (e) {
    throw new Error(`fetch_failed:${(e as Error).message}`);
  }

  if (!res.ok) throw new Error(`http_${res.status}`);
  const contentType = res.headers.get('content-type') ?? '';
  if (!/text\/html|xml/i.test(contentType)) throw new Error(`non_html:${contentType.slice(0, 40)}`);

  const lastModified = res.headers.get('last-modified');
  const lastModifiedMs = lastModified ? Date.parse(lastModified) : NaN;

  const ext = await extract(res, url);
  const composite = `${ext.title}\n${ext.h1}\n${ext.excerpt}`;
  const hash = await contentHash(composite);
  const slug = pathOf(url);

  // Upsert page; skip embed (D4) when content_hash unchanged is handled there.
  const existing = await env.DB.prepare(
    'SELECT id, content_hash FROM pages WHERE site_id = ? AND slug = ?'
  )
    .bind(siteId, slug)
    .first<{ id: string; content_hash: string }>();

  let pageId: string;
  if (existing) {
    pageId = existing.id;
    if (existing.content_hash !== hash) {
      await env.DB.prepare(
        'UPDATE pages SET title = ?, h1 = ?, excerpt = ?, body_text = ?, content_hash = ?, last_modified = ?, crawled_at = ? WHERE id = ?'
      )
        .bind(
          ext.title,
          ext.h1,
          ext.excerpt,
          ext.bodyText,
          hash,
          Number.isFinite(lastModifiedMs) ? lastModifiedMs : null,
          Date.now(),
          pageId
        )
        .run();
    } else {
      // Content unchanged, but still backfill body_text (added 2026-06-06) for
      // pages crawled before the column existed — otherwise the anchor selector
      // never gets a full body for already-crawled sites.
      await env.DB.prepare('UPDATE pages SET body_text = ?, crawled_at = ? WHERE id = ?')
        .bind(ext.bodyText, Date.now(), pageId)
        .run();
    }
  } else {
    pageId = ulid();
    await env.DB.prepare(
      'INSERT INTO pages (id, site_id, slug, title, h1, excerpt, body_text, content_hash, last_modified, crawled_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)'
    )
      .bind(
        pageId,
        siteId,
        slug,
        ext.title,
        ext.h1,
        ext.excerpt,
        ext.bodyText,
        hash,
        Number.isFinite(lastModifiedMs) ? lastModifiedMs : null,
        Date.now()
      )
      .run();
  }

  // Replace this page's outlinks (the staging table). Edges materialize at
  // crawl-complete via reconcileEdges() — see below.
  await env.DB.prepare('DELETE FROM outlinks WHERE src_page_id = ?').bind(pageId).run();

  const anchors = ext.internalAnchors.slice(0, 200);
  const outStmts: D1PreparedStatement[] = [];
  const discovered: string[] = [];
  const seenDst = new Set<string>();
  for (const a of anchors) {
    const dstSlug = pathOf(a.href);
    if (seenDst.has(dstSlug)) continue;
    seenDst.add(dstSlug);
    outStmts.push(
      env.DB.prepare(
        'INSERT INTO outlinks (src_page_id, dst_slug, anchor_text) VALUES (?, ?, ?)'
      ).bind(pageId, dstSlug, a.text || null)
    );
    // BFS discovery: queue this URL for crawl if not visited.
    const norm = normalizeUrl(a.href, url);
    if (norm && sameOrigin(norm, url)) discovered.push(norm);
  }
  if (outStmts.length) await env.DB.batch(outStmts);

  return { slug, discovered };
}

// reconcileEdges — rebuilds the materialized edges table from outlinks for one site.
// Runs once per crawl-complete. O(N) over the site's outlinks.
async function reconcileEdges(env: Env, siteId: string): Promise<void> {
  // Drop edges for this site, then rebuild from outlinks JOIN pages.
  await env.DB.prepare(
    `DELETE FROM edges WHERE src_page_id IN (SELECT id FROM pages WHERE site_id = ?)`
  )
    .bind(siteId)
    .run();
  await env.DB.prepare(
    `INSERT OR IGNORE INTO edges (src_page_id, dst_page_id, anchor_text)
     SELECT o.src_page_id, p.id, o.anchor_text
       FROM outlinks o
       JOIN pages sp ON sp.id = o.src_page_id AND sp.site_id = ?
       JOIN pages p ON p.site_id = ? AND p.slug = o.dst_slug`
  )
    .bind(siteId, siteId)
    .run();
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

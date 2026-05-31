// Global setup — seeds a fixture user + site + pages + candidate into the
// LOCAL D1 (wrangler dev) so persona-sim specs that need real domain data
// have something to act against. Runs once before the Playwright workers
// spawn.
import { execSync } from 'child_process';
import { promises as fs } from 'fs';

const DB_PATH =
  '/Users/seyedmosayebalameikiyo/Desktop/Kage OS/projects/D-Saas-01/Knowledge/recto/apps/workers/api/.wrangler/state/v3/d1/miniflare-D1DatabaseObject/c6fd68c54de15a864a3a484cdb98133c06756dbee6877a5b1a24969705d22006.sqlite';

function sql(q: string): string {
  // Flatten whitespace — sqlite3's shell rejects embedded newlines in the
  // single-string command argument.
  const flat = q.replace(/\s+/g, ' ').trim();
  return execSync(`sqlite3 "${DB_PATH}" ${JSON.stringify(flat)}`).toString().trim();
}

function ulid(): string {
  // Cheap pseudo-ulid for fixture rows. Not crypto, but deterministically sortable.
  return 'fx_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 10);
}

export default async function globalSetup(): Promise<void> {
  const email = 'eikiyo@recto.so';
  const now = Date.now();

  // Fresh fixture every run — wipe just this user's data.
  sql(`DELETE FROM candidates WHERE orphan_page_id IN (SELECT id FROM pages WHERE site_id IN (SELECT id FROM sites WHERE user_id IN (SELECT id FROM users WHERE email='${email}')))`);
  sql(`DELETE FROM pages WHERE site_id IN (SELECT id FROM sites WHERE user_id IN (SELECT id FROM users WHERE email='${email}'))`);
  sql(`DELETE FROM sites WHERE user_id IN (SELECT id FROM users WHERE email='${email}')`);
  sql(`DELETE FROM licenses WHERE user_id IN (SELECT id FROM users WHERE email='${email}')`);
  sql(`DELETE FROM sessions WHERE user_id IN (SELECT id FROM users WHERE email='${email}')`);
  sql(`DELETE FROM magic_tokens WHERE user_id IN (SELECT id FROM users WHERE email='${email}')`);
  sql(`DELETE FROM users WHERE email='${email}'`);

  // 1. User + license + onboarded.
  const userId = ulid();
  sql(`INSERT INTO users (id, email, name, created_at, onboarded_at, anchor_credits, digest_opt_in)
       VALUES ('${userId}', '${email}', 'Eikiyo', ${now}, ${now}, 100, 1)`);
  const licenseId = ulid();
  sql(`INSERT INTO licenses (id, user_id, appsumo_code, tier, redeemed_at)
       VALUES ('${licenseId}', '${userId}', 'fx-code-${now}', 1, ${now})`);

  // 2. Site.
  const siteId = ulid();
  sql(`INSERT INTO sites (id, user_id, url, cms, wp_username, vector_namespace, last_crawl_at, crawl_pages)
       VALUES ('${siteId}', '${userId}', 'https://fixture.test', 'wordpress', 'admin', 'site-${siteId}', ${now}, 2)`);

  // 3. Two pages: a source (well-linked) and an orphan.
  const sourceId = ulid();
  const orphanId = ulid();
  sql(`INSERT INTO pages (id, site_id, slug, title, h1, excerpt, content_hash, depth, crawled_at)
       VALUES ('${sourceId}', '${siteId}', '/posts/index-funds-basics', 'Index funds basics', 'Index funds basics',
               'Index funds are a low-cost way to own the whole market.', 'h_source', 1, ${now})`);
  sql(`INSERT INTO pages (id, site_id, slug, title, h1, excerpt, content_hash, depth, crawled_at)
       VALUES ('${orphanId}', '${siteId}', '/posts/etf-vs-mutual-fund', 'ETF vs mutual fund', 'ETF vs mutual fund',
               'ETFs trade like stocks; mutual funds settle once a day at NAV.', 'h_orphan', 3, ${now})`);

  // 4. Candidate linking source → orphan. paragraph_excerpt is what the
  //    insertion view renders; similarity * 100 + authority badge round-trip.
  const candId = ulid();
  sql(`INSERT INTO candidates (id, orphan_page_id, source_page_id, similarity, source_authority,
                                 anchor_text, paragraph_excerpt, generated_at, llm_provider)
       VALUES ('${candId}', '${orphanId}', '${sourceId}', 0.81, 5,
               'ETF vs mutual fund tradeoffs',
               'For long-horizon savers, the difference between an ETF and a traditional mutual fund usually comes down to two things — intraday liquidity and expense ratio.',
               ${now}, 'fixture')`);

  // 5. The persona-sim helper reads /tmp/recto-site-id to find the fixture.
  await fs.writeFile('/tmp/recto-site-id', siteId, 'utf8');

  console.log('[global-setup] seeded fixture site', siteId, 'orphan', orphanId, 'candidate', candId);
}

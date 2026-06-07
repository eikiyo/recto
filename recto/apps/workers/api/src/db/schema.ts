// recto — D1 (SQLite) schema. Mirrors TRD §4 verbatim.
// All `*_at` columns are unix milliseconds. All `*_key` BLOBs are AES-256-GCM envelopes.
// Authorization is enforced at the Hono procedure layer (D1 has no RLS).

import { sql } from 'drizzle-orm';
import { sqliteTable, text, integer, blob, real, primaryKey, index, uniqueIndex } from 'drizzle-orm/sqlite-core';

export const users = sqliteTable('users', {
  id: text('id').primaryKey(),
  email: text('email').notNull().unique(),
  createdAt: integer('created_at').notNull(),
  lastLoginAt: integer('last_login_at'),
  byokOpenaiKey: blob('byok_openai_key', { mode: 'buffer' }),
  byokAnthropicKey: blob('byok_anthropic_key', { mode: 'buffer' }),
  digestOptIn: integer('digest_opt_in').notNull().default(1),
});

export const sessions = sqliteTable(
  'sessions',
  {
    id: text('id').primaryKey(),
    userId: text('user_id').notNull().references(() => users.id),
    expiresAt: integer('expires_at').notNull(),
    ipHash: text('ip_hash'),
    uaHash: text('ua_hash'),
  },
  (t) => ({
    byUser: index('sessions_user').on(t.userId),
  })
);

export const magicTokens = sqliteTable('magic_tokens', {
  hash: text('hash').primaryKey(),
  userId: text('user_id').notNull().references(() => users.id),
  expiresAt: integer('expires_at').notNull(),
  usedAt: integer('used_at'),
});

export const sites = sqliteTable(
  'sites',
  {
    id: text('id').primaryKey(),
    userId: text('user_id').notNull().references(() => users.id),
    url: text('url').notNull(),
    cms: text('cms').notNull(), // 'wordpress' | 'webflow'
    wpUsername: text('wp_username'),
    wpAppPassword: blob('wp_app_password', { mode: 'buffer' }),
    webflowApiKey: blob('webflow_api_key', { mode: 'buffer' }),
    gscRefreshToken: blob('gsc_refresh_token', { mode: 'buffer' }),
    gscProperty: text('gsc_property'),
    lastCrawlAt: integer('last_crawl_at'),
    crawlPages: integer('crawl_pages'),
    vectorNamespace: text('vector_namespace').notNull(),
  },
  (t) => ({
    byUser: index('sites_user').on(t.userId),
    uniqUserUrl: uniqueIndex('sites_user_url').on(t.userId, t.url),
  })
);

export const pages = sqliteTable(
  'pages',
  {
    id: text('id').primaryKey(),
    siteId: text('site_id').notNull().references(() => sites.id),
    slug: text('slug').notNull(),
    title: text('title'),
    h1: text('h1'),
    excerpt: text('excerpt'),
    bodyText: text('body_text'),
    contentHash: text('content_hash').notNull(),
    depth: integer('depth'),
    lastModified: integer('last_modified'),
    crawledAt: integer('crawled_at').notNull(),
  },
  (t) => ({
    bySite: index('pages_site').on(t.siteId),
    uniqSiteSlug: uniqueIndex('pages_site_slug').on(t.siteId, t.slug),
  })
);

export const edges = sqliteTable(
  'edges',
  {
    srcPageId: text('src_page_id').notNull().references(() => pages.id),
    dstPageId: text('dst_page_id').notNull().references(() => pages.id),
    anchorText: text('anchor_text'),
  },
  (t) => ({
    pk: primaryKey({ columns: [t.srcPageId, t.dstPageId] }),
    byDst: index('edges_dst').on(t.dstPageId),
  })
);

// Raw outgoing anchors per page; materialized into `edges` after each crawl tick.
export const outlinks = sqliteTable(
  'outlinks',
  {
    srcPageId: text('src_page_id').notNull().references(() => pages.id, { onDelete: 'cascade' }),
    dstSlug: text('dst_slug').notNull(),
    anchorText: text('anchor_text'),
  },
  (t) => ({
    pk: primaryKey({ columns: [t.srcPageId, t.dstSlug] }),
    bySlug: index('outlinks_slug').on(t.dstSlug),
  })
);

export const gscData = sqliteTable(
  'gsc_data',
  {
    pageId: text('page_id').notNull().references(() => pages.id),
    day: text('day').notNull(), // YYYY-MM-DD
    impressions: integer('impressions').notNull(),
    clicks: integer('clicks').notNull(),
    position: real('position'),
  },
  (t) => ({
    pk: primaryKey({ columns: [t.pageId, t.day] }),
  })
);

export const candidates = sqliteTable(
  'candidates',
  {
    id: text('id').primaryKey(),
    orphanPageId: text('orphan_page_id').notNull().references(() => pages.id),
    sourcePageId: text('source_page_id').notNull().references(() => pages.id),
    similarity: real('similarity').notNull(),
    sourceAuthority: integer('source_authority').notNull(),
    anchorText: text('anchor_text').notNull(),
    paragraphExcerpt: text('paragraph_excerpt').notNull(),
    generatedAt: integer('generated_at').notNull(),
    llmProvider: text('llm_provider').notNull(), // 'workers-ai' | 'byok-openai' | 'byok-anthropic'
    costNeurons: integer('cost_neurons'),
  },
  (t) => ({
    uniqOrphanSource: uniqueIndex('candidates_orphan_source').on(t.orphanPageId, t.sourcePageId),
  })
);

export const pushes = sqliteTable(
  'pushes',
  {
    id: text('id').primaryKey(),
    userId: text('user_id').notNull().references(() => users.id),
    candidateId: text('candidate_id').notNull().references(() => candidates.id),
    pushedAt: integer('pushed_at').notNull(),
    status: text('status').notNull(), // 'pending' | 'verified' | 'failed' | 'undone'
    failureCode: text('failure_code'),
    failureMsg: text('failure_msg'),
    verifiedAt: integer('verified_at'),
    verifiedVia: text('verified_via'),
    undoneAt: integer('undone_at'),
  },
  (t) => ({
    byUser: index('pushes_user').on(t.userId),
    byStatus: index('pushes_status').on(t.status),
  })
);

export type User = typeof users.$inferSelect;
export type Site = typeof sites.$inferSelect;
export type Page = typeof pages.$inferSelect;
export type Candidate = typeof candidates.$inferSelect;
export type Push = typeof pushes.$inferSelect;

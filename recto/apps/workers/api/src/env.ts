// Runtime bindings for the recto-api Worker. Mirrors wrangler.toml.

export type GscBackfillJob =
  | { siteId: string; kind: 'backfill'; daysBack: number }
  | { siteId: string; kind: 'day'; day: string };

export type Env = {
  // Workers AI
  AI: Ai;

  // Browser Rendering
  BROWSER: Fetcher;

  // D1
  DB: D1Database;

  // KV (sessions, rate limits, ETag cache)
  KV: KVNamespace;

  // Vectorize (one logical index; namespaced per site via metadata)
  VECTORIZE: VectorizeIndex;

  // R2 (cold blobs). Optional: R2 requires a one-time enable in the CF
  // dashboard. Until then, audit archive falls back to D1-only retention.
  R2?: R2Bucket;

  // Queues
  Q_CRAWL: Queue<{ siteId: string; trigger: 'manual' | 'scheduled'; crawlId: string }>;
  Q_EMBED: Queue<{ siteId: string; pageId: string }>;
  Q_PUSH: Queue<{ pushId: string }>;
  Q_VERIFY: Queue<{ pushId: string; attempt: number }>;
  Q_EMAIL: Queue<{ template: string; userId: string; data: Record<string, unknown> }>;
  Q_GSC_BACKFILL: Queue<GscBackfillJob>;

  // Durable Object
  CRAWL_SESSION: DurableObjectNamespace;

  // Plain vars
  RECTO_ENV: 'dev' | 'preview' | 'prod';
  RECTO_PUBLIC_ORIGIN: string;

  // Secrets (set via `wrangler secret put`)
  RECTO_KEK: string;
  APPSUMO_WEBHOOK_SECRET: string;
  MAGIC_LINK_SECRET: string;
  GSC_CLIENT_ID: string;
  GSC_CLIENT_SECRET: string;
  // Email transports — checked in this order: Emailit (primary, rectoapp.com
  // is SPF/DKIM-verified on Emailit), Resend (legacy), MailChannels (fallback).
  EMAILIT_API_KEY?: string;
  RESEND_API_KEY?: string;
};

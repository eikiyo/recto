// q-embed consumer. One message per page; batched up to 10 per invocation.
//
// Each message embeds a single page via Workers AI BGE and upserts into
// Vectorize. Re-crawls skip pages whose content_hash matches the vector's
// stored metadata — keeps AI invocation cost down on mostly-static sites.

import type { Env } from '../env';
import { retryOrDrop } from '../lib/queue';

type EmbedMsg = { siteId: string; pageId: string };

const MODEL = '@cf/baai/bge-base-en-v1.5'; // 768-dim
const EMBED_INPUT_CAP = 2_000; // BGE accepts ~512 tokens; cap chars to stay well inside
const MAX_EMBED_DELIVERIES = 5; // bound retries when AI/Vectorize is persistently unavailable

export async function handleEmbedBatch(
  batch: MessageBatch<EmbedMsg>,
  env: Env
): Promise<void> {
  for (const msg of batch.messages) {
    try {
      await embedOne(env, msg.body);
      msg.ack();
    } catch (e) {
      retryOrDrop(msg, 'embed', { pageId: msg.body.pageId, siteId: msg.body.siteId, error: (e as Error).message }, MAX_EMBED_DELIVERIES, 30);
    }
  }
}

async function embedOne(env: Env, job: EmbedMsg): Promise<void> {
  const page = await env.DB.prepare(
    'SELECT id, site_id, slug, title, h1, excerpt, content_hash FROM pages WHERE id = ?'
  )
    .bind(job.pageId)
    .first<{
      id: string;
      site_id: string;
      slug: string;
      title: string | null;
      h1: string | null;
      excerpt: string | null;
      content_hash: string;
    }>();

  if (!page) {
    console.warn('embed skip — page not found', { pageId: job.pageId });
    return;
  }

  // Skip re-embed if the existing vector matches this content_hash.
  // VectorizeIndex.getByIds returns vectors with metadata if present.
  try {
    const existing = await env.VECTORIZE.getByIds([page.id]);
    const first = existing[0];
    if (first && first.metadata && first.metadata.content_hash === page.content_hash) {
      return;
    }
  } catch {
    // Index may not have this id yet — fall through to embed.
  }

  const text = composite(page);
  if (!text) {
    console.warn('embed skip — empty text', { pageId: job.pageId });
    return;
  }

  const ai = (await env.AI.run(MODEL, { text: [text] })) as { data: number[][] };
  const values = ai.data[0];
  if (!values || values.length === 0) {
    throw new Error('embed_empty_vector');
  }

  await env.VECTORIZE.upsert([
    {
      id: page.id,
      values,
      metadata: {
        site_id: page.site_id,
        slug: page.slug,
        content_hash: page.content_hash,
      },
    },
  ]);
}

function composite(p: {
  title: string | null;
  h1: string | null;
  excerpt: string | null;
}): string {
  const t = (p.title ?? '').trim();
  const h = (p.h1 ?? '').trim();
  const e = (p.excerpt ?? '').trim();
  const joined = [t, h, e].filter(Boolean).join('\n');
  return joined.slice(0, EMBED_INPUT_CAP);
}

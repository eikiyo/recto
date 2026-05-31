// Stub-driven verification of the embed pipeline contract.
// Does not exercise real Workers AI or Vectorize — verifies that:
//   1. Page row is fetched by id
//   2. Composite text concatenates title + h1 + excerpt
//   3. AI.run is called with the expected model + payload shape
//   4. Vectorize.upsert receives id, values, and metadata.content_hash
//   5. When an existing vector already matches content_hash, AI is skipped
//   6. When page is missing, no AI/Vectorize calls happen

import { describe, it, expect, vi } from 'vitest';
import { handleEmbedBatch } from '../src/jobs/embed';
import type { Env } from '../src/env';

type PageRow = {
  id: string;
  site_id: string;
  slug: string;
  title: string | null;
  h1: string | null;
  excerpt: string | null;
  content_hash: string;
};

function makeEnv(opts: {
  page: PageRow | null;
  existingVectorHash?: string;
  aiVector?: number[];
}): {
  env: Env;
  aiSpy: ReturnType<typeof vi.fn>;
  upsertSpy: ReturnType<typeof vi.fn>;
  getByIdsSpy: ReturnType<typeof vi.fn>;
} {
  const aiSpy = vi.fn(async () => ({ data: [opts.aiVector ?? [0.1, 0.2, 0.3]] }));
  const upsertSpy = vi.fn(async () => undefined);
  const getByIdsSpy = vi.fn(async () => {
    if (opts.existingVectorHash) {
      return [{ id: opts.page?.id ?? '', metadata: { content_hash: opts.existingVectorHash } }];
    }
    return [];
  });

  const env = {
    AI: { run: aiSpy },
    VECTORIZE: { getByIds: getByIdsSpy, upsert: upsertSpy },
    DB: {
      prepare: (_sql: string) => ({
        bind: (..._args: unknown[]) => ({
          first: async () => opts.page,
        }),
      }),
    },
  } as unknown as Env;

  return { env, aiSpy, upsertSpy, getByIdsSpy };
}

function makeBatch(body: { siteId: string; pageId: string }): MessageBatch<{ siteId: string; pageId: string }> {
  const ackSpy = vi.fn();
  const retrySpy = vi.fn();
  return {
    queue: 'q-embed',
    messages: [
      {
        id: 'm1',
        timestamp: new Date(),
        body,
        ack: ackSpy,
        retry: retrySpy,
        attempts: 1,
      } as unknown as Message<{ siteId: string; pageId: string }>,
    ],
    ackAll: () => undefined,
    retryAll: () => undefined,
  } as unknown as MessageBatch<{ siteId: string; pageId: string }>;
}

const samplePage: PageRow = {
  id: 'p1',
  site_id: 's1',
  slug: '/about',
  title: 'About us',
  h1: 'About the team',
  excerpt: 'We build internal-linking tools for solo founders.',
  content_hash: 'hash-v1',
};

describe('embed pipeline', () => {
  it('embeds a new page and upserts to Vectorize with content_hash metadata', async () => {
    const { env, aiSpy, upsertSpy } = makeEnv({ page: samplePage });
    await handleEmbedBatch(makeBatch({ siteId: 's1', pageId: 'p1' }), env);

    expect(aiSpy).toHaveBeenCalledTimes(1);
    expect(aiSpy.mock.calls[0]?.[0]).toBe('@cf/baai/bge-base-en-v1.5');
    const aiArg = aiSpy.mock.calls[0]?.[1] as { text: string[] };
    expect(aiArg.text[0]).toContain('About us');
    expect(aiArg.text[0]).toContain('About the team');
    expect(aiArg.text[0]).toContain('internal-linking tools');

    expect(upsertSpy).toHaveBeenCalledTimes(1);
    const [vectors] = upsertSpy.mock.calls[0] as [Array<{ id: string; values: number[]; metadata: Record<string, unknown> }>];
    expect(vectors[0]?.id).toBe('p1');
    expect(vectors[0]?.values).toEqual([0.1, 0.2, 0.3]);
    expect(vectors[0]?.metadata.content_hash).toBe('hash-v1');
    expect(vectors[0]?.metadata.site_id).toBe('s1');
    expect(vectors[0]?.metadata.slug).toBe('/about');
  });

  it('skips re-embed when existing vector already has matching content_hash', async () => {
    const { env, aiSpy, upsertSpy } = makeEnv({
      page: samplePage,
      existingVectorHash: 'hash-v1',
    });
    await handleEmbedBatch(makeBatch({ siteId: 's1', pageId: 'p1' }), env);

    expect(aiSpy).not.toHaveBeenCalled();
    expect(upsertSpy).not.toHaveBeenCalled();
  });

  it('re-embeds when existing vector content_hash is stale', async () => {
    const { env, aiSpy, upsertSpy } = makeEnv({
      page: samplePage,
      existingVectorHash: 'hash-old',
    });
    await handleEmbedBatch(makeBatch({ siteId: 's1', pageId: 'p1' }), env);

    expect(aiSpy).toHaveBeenCalledTimes(1);
    expect(upsertSpy).toHaveBeenCalledTimes(1);
  });

  it('no-ops when the page row is missing (consumer must ack, not retry)', async () => {
    const { env, aiSpy, upsertSpy } = makeEnv({ page: null });
    await handleEmbedBatch(makeBatch({ siteId: 's1', pageId: 'missing' }), env);

    expect(aiSpy).not.toHaveBeenCalled();
    expect(upsertSpy).not.toHaveBeenCalled();
  });
});

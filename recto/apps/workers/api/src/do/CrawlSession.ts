// CrawlSession — the orchestrator for one crawl run.
//
// State lives in DurableObject storage (durable across hibernation). The Worker
// process (the q-crawl consumer) polls /work for a batch, processes, then
// /persist with what it found + what it discovered.
//
// SSE: /sse returns an event stream that mirrors progress for the UI tab.
//
// The DO is the source of truth for "current crawl progress". It is also
// transactional: /work + /persist are atomic against the URL queue.

import type { Env } from '../env';
import { isContentPath } from '../lib/url-norm';

type Progress = {
  crawlId: string;
  siteId: string;
  total: number;     // total URLs queued + done
  done: number;
  currentSlug: string;
  startedAt: number;
  complete: boolean;
};

const BATCH_SIZE = 25;
const MAX_URLS = 10_000;

export class CrawlSession implements DurableObject {
  private state: DurableObjectState;
  private env: Env;
  private subscribers: Set<WritableStreamDefaultWriter<Uint8Array>> = new Set();

  constructor(state: DurableObjectState, env: Env) {
    this.state = state;
    this.env = env;
  }

  async fetch(req: Request): Promise<Response> {
    const url = new URL(req.url);
    const path = url.pathname.split('/').pop() || '';
    switch (path) {
      case 'init':
        return this.init(req);
      case 'work':
        return this.work();
      case 'persist':
        return this.persist(req);
      case 'state':
        return this.stateResponse();
      case 'sse':
        return this.sse();
      default:
        return new Response('not_found', { status: 404 });
    }
  }

  // ────────────────────────────────────────────────────────────────────────

  private async init(req: Request): Promise<Response> {
    const { crawlId, siteId, seedUrls } = (await req.json()) as {
      crawlId: string;
      siteId: string;
      seedUrls: string[];
    };

    const trimmed = seedUrls.slice(0, MAX_URLS);
    const progress: Progress = {
      crawlId,
      siteId,
      total: trimmed.length,
      done: 0,
      currentSlug: '',
      startedAt: Date.now(),
      complete: trimmed.length === 0,
    };

    await this.state.storage.put('progress', progress);
    await this.state.storage.put('queue', trimmed);
    await this.state.storage.put('visited', [] as string[]);

    await this.broadcast(progress);
    return Response.json({ ok: true, total: trimmed.length });
  }

  // ────────────────────────────────────────────────────────────────────────

  private async work(): Promise<Response> {
    const queue = ((await this.state.storage.get<string[]>('queue')) ?? []).slice();
    const batch = queue.splice(0, BATCH_SIZE);
    await this.state.storage.put('queue', queue);
    return Response.json({ batch, remaining: queue.length });
  }

  // ────────────────────────────────────────────────────────────────────────

  private async persist(req: Request): Promise<Response> {
    const body = (await req.json()) as {
      processed: { url: string; ok: boolean; slug?: string }[];
      discovered: string[];
    };

    const progress = (await this.state.storage.get<Progress>('progress'))!;
    const visited = new Set((await this.state.storage.get<string[]>('visited')) ?? []);
    const queueRaw = (await this.state.storage.get<string[]>('queue')) ?? [];

    // Mark processed URLs as visited + bump counters.
    let lastSlug = progress.currentSlug;
    for (const p of body.processed) {
      if (!visited.has(p.url)) {
        visited.add(p.url);
        progress.done++;
        if (p.slug) lastSlug = p.slug;
      }
    }
    progress.currentSlug = lastSlug;

    // Enqueue newly discovered URLs that we have not seen. Skip WP system
    // paths (wp-admin, wp-login, feed, attachments…) — these aren't content
    // pages and surfacing them as orphans wrecks Mira's first impression.
    const queueSet = new Set(queueRaw);
    for (const u of body.discovered) {
      if (visited.size + queueSet.size >= MAX_URLS) break;
      if (visited.has(u) || queueSet.has(u)) continue;
      if (!isContentPath(u)) continue;
      queueRaw.push(u);
      queueSet.add(u);
      progress.total++;
    }

    progress.complete = queueRaw.length === 0;

    await this.state.storage.put('progress', progress);
    await this.state.storage.put('queue', queueRaw);
    await this.state.storage.put('visited', [...visited]);

    await this.broadcast(progress);

    return Response.json({ ok: true, remaining: queueRaw.length, complete: progress.complete });
  }

  // ────────────────────────────────────────────────────────────────────────

  private async stateResponse(): Promise<Response> {
    const progress = await this.state.storage.get<Progress>('progress');
    return Response.json(progress ?? null);
  }

  // ────────────────────────────────────────────────────────────────────────

  private async sse(): Promise<Response> {
    const { readable, writable } = new TransformStream<Uint8Array, Uint8Array>();
    const writer = writable.getWriter();
    const enc = new TextEncoder();

    const progress = await this.state.storage.get<Progress>('progress');
    if (progress) {
      await writer.write(enc.encode(this.sseFrame('progress', progress)));
      if (progress.complete) {
        await writer.write(enc.encode(this.sseFrame('complete', { crawlId: progress.crawlId })));
        try {
          await writer.close();
        } catch {}
      } else {
        this.subscribers.add(writer);
      }
    } else {
      await writer.write(enc.encode(this.sseFrame('progress', { done: 0, total: 0, currentSlug: '', complete: false })));
      this.subscribers.add(writer);
    }

    return new Response(readable, {
      headers: {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        Connection: 'keep-alive',
      },
    });
  }

  private async broadcast(progress: Progress): Promise<void> {
    const enc = new TextEncoder();
    const frame = enc.encode(this.sseFrame('progress', progress));
    const dead: WritableStreamDefaultWriter<Uint8Array>[] = [];
    for (const w of this.subscribers) {
      try {
        await w.write(frame);
      } catch {
        dead.push(w);
      }
    }
    for (const w of dead) this.subscribers.delete(w);

    if (progress.complete) {
      const completeFrame = enc.encode(this.sseFrame('complete', { crawlId: progress.crawlId }));
      for (const w of this.subscribers) {
        try {
          await w.write(completeFrame);
          await w.close();
        } catch {}
      }
      this.subscribers.clear();
    }
  }

  private sseFrame(event: string, data: unknown): string {
    return `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
  }
}

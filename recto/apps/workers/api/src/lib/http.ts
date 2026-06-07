// Shared HTTP helpers for fetching UNTRUSTED user sites (their WordPress REST
// API, their sitemap, their live pages). Two failure modes these guard against:
//   - a slow/hanging endpoint pinning a Worker invocation until the platform
//     wall-clock limit — wasted compute and a frozen crawl / verify / push, and
//   - an enormous response body exhausting Worker memory.
// (Hardened 2026-06-06.)

// fetch() with a hard timeout. On timeout the underlying request is aborted and
// the call rejects with an AbortError, which every caller already treats as a
// network failure (retry / wp_network / per-URL skip).
export async function fetchWithTimeout(
  url: string,
  init: RequestInit,
  timeoutMs: number
): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...init, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

// Read a response body as text but never buffer more than maxBytes — a huge
// sitemap or page can't OOM the Worker. Rejects a declared-oversize body up
// front, and aborts the stream the moment the cap is crossed.
export async function readTextCapped(res: Response, maxBytes: number): Promise<string> {
  const declared = Number(res.headers.get('content-length') || 0);
  if (declared && declared > maxBytes) throw new Error(`response_too_large:${declared}`);
  const reader = res.body?.getReader();
  if (!reader) return await res.text();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (value) {
      total += value.byteLength;
      if (total > maxBytes) {
        await reader.cancel();
        throw new Error(`response_too_large:>${maxBytes}`);
      }
      chunks.push(value);
    }
  }
  const out = new Uint8Array(total);
  let off = 0;
  for (const c of chunks) { out.set(c, off); off += c.byteLength; }
  return new TextDecoder().decode(out);
}

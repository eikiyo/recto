// Lexical similarity fallback for local dev when Vectorize is unavailable.
//
// Production uses Workers AI BGE embeddings → Vectorize cosine. Local wrangler
// dev has no Vectorize binding, so we substitute a deterministic token-overlap
// score that ranks "obvious neighbours" correctly for the demo loop.
//
// Algorithm: weighted token-overlap. Title tokens count 3x, h1 tokens 2x,
// excerpt tokens 1x. Score is normalized intersection-over-union with weights.
//
// This is NOT a replacement for embeddings — it can't surface semantic
// neighbours that share no vocabulary. It exists so the local SPA loop and
// CI smoke tests can run without Vectorize.

const STOP = new Set([
  'a','an','the','and','or','but','of','to','in','on','at','for','with','by',
  'is','are','was','were','be','been','being','have','has','had','do','does',
  'did','it','its','this','that','these','those','as','from','if','then','than',
  'so','not','no','yes','can','will','would','should','could','i','you','we',
  'they','he','she','my','your','our','their','about','into','over','under',
  'when','what','which','who','why','how','one','two','three',
]);

export type LexDoc = {
  id: string;
  title: string | null;
  h1: string | null;
  excerpt: string | null;
};

function tokenize(s: string | null): string[] {
  if (!s) return [];
  return s
    .toLowerCase()
    .replace(/[^a-z0-9\s-]+/g, ' ')
    .split(/\s+/)
    .filter((t) => t.length > 2 && !STOP.has(t));
}

function weightedBag(d: LexDoc): Map<string, number> {
  const bag = new Map<string, number>();
  const add = (tokens: string[], weight: number) => {
    for (const t of tokens) bag.set(t, (bag.get(t) ?? 0) + weight);
  };
  add(tokenize(d.title), 3);
  add(tokenize(d.h1), 2);
  add(tokenize(d.excerpt), 1);
  return bag;
}

function cosine(a: Map<string, number>, b: Map<string, number>): number {
  let dot = 0;
  let an = 0;
  let bn = 0;
  for (const v of a.values()) an += v * v;
  for (const v of b.values()) bn += v * v;
  if (an === 0 || bn === 0) return 0;
  for (const [k, av] of a) {
    const bv = b.get(k);
    if (bv !== undefined) dot += av * bv;
  }
  return dot / Math.sqrt(an * bn);
}

// Returns top-K (id, similarity) ranked desc; orphan itself excluded.
export function lexicalTopK(query: LexDoc, pool: LexDoc[], k: number): Array<{ id: string; similarity: number }> {
  const qb = weightedBag(query);
  const scores: Array<{ id: string; similarity: number }> = [];
  for (const d of pool) {
    if (d.id === query.id) continue;
    const sim = cosine(qb, weightedBag(d));
    if (sim > 0) scores.push({ id: d.id, similarity: sim });
  }
  scores.sort((a, b) => b.similarity - a.similarity);
  return scores.slice(0, k);
}

// Deterministic anchor: pick the 2-3 most distinctive content words from the
// orphan title (drop stopwords + words already in the source paragraph).
export function deterministicAnchor(
  targetTitle: string | null,
  targetH1: string | null,
  sourceParagraph: string
): string {
  const sourceTokens = new Set(tokenize(sourceParagraph));
  const candidates = [
    ...tokenize(targetTitle),
    ...tokenize(targetH1),
  ];
  // Prefer words NOT already in the source paragraph (so the anchor reads as
  // a useful new pointer rather than a redundant repeat).
  const novel = candidates.filter((t) => !sourceTokens.has(t));
  const picked = (novel.length >= 2 ? novel : candidates).slice(0, 3);
  return picked.length ? picked.join(' ') : (targetTitle ?? targetH1 ?? 'related').toLowerCase();
}

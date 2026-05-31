// Anchor candidate generation.
//
// Floor tier: Workers AI Llama-3.1-8b-instruct — free until quota, no cost
// per call. Constrained prompt enforces a 2-5 word anchor matching the
// source paragraph register.
//
// Overflow tier: BYOK. If the user supplied an OpenAI key (preferred) or
// Anthropic key, we route there. We never store output tokens; cost is the
// user's. The decision is per-user:
//   - Always Workers AI by default.
//   - If `users.byok_openai_key` is set AND user opted in (digest_opt_in
//     flag is reused as a "byok preferred" toggle until we ship a
//     dedicated column), prefer OpenAI.

import { decrypt } from '../lib/crypto';

const WORKERS_AI_MODEL = '@cf/meta/llama-3.1-8b-instruct';

const PROMPT = `You generate internal-link anchor text for a content writer.

Rules:
- Output ONLY the anchor text. No quotes, no preamble, no markdown.
- 2 to 5 words.
- Match the register of the source paragraph (sober, professional, plain English).
- The anchor must read naturally if you swap it into the source paragraph in place of a noun phrase.
- Do NOT use marketing phrases ("learn more", "click here", "read this guide").
- Do NOT include the target page title verbatim.

Source paragraph:
{source}

Target page title: {targetTitle}
Target page H1: {targetH1}
Target page excerpt: {targetExcerpt}

Anchor text:`;

export type AnchorGenInput = {
  sourceParagraph: string;
  targetTitle: string | null;
  targetH1: string | null;
  targetExcerpt: string | null;
};

export type AnchorGenOutput = {
  anchor: string;
  provider: 'workers-ai' | 'byok-openai' | 'byok-anthropic';
  tokensApprox: number;
};

export async function generateAnchor(
  env: {
    AI: Ai;
    RECTO_KEK: string;
  },
  user: {
    byok_openai_key: Uint8Array | null;
    byok_anthropic_key: Uint8Array | null;
    preferByok: boolean;
  },
  input: AnchorGenInput
): Promise<AnchorGenOutput> {
  const prompt = PROMPT.replace('{source}', clip(input.sourceParagraph, 600))
    .replace('{targetTitle}', input.targetTitle ?? '')
    .replace('{targetH1}', input.targetH1 ?? '')
    .replace('{targetExcerpt}', clip(input.targetExcerpt ?? '', 300));

  if (user.preferByok && user.byok_openai_key) {
    return await callOpenAI(env.RECTO_KEK, user.byok_openai_key, prompt);
  }
  if (user.preferByok && user.byok_anthropic_key) {
    return await callAnthropic(env.RECTO_KEK, user.byok_anthropic_key, prompt);
  }
  return await callWorkersAI(env.AI, prompt);
}

async function callWorkersAI(ai: Ai, prompt: string): Promise<AnchorGenOutput> {
  const res = (await ai.run(WORKERS_AI_MODEL, {
    messages: [{ role: 'user', content: prompt }],
    max_tokens: 32,
    temperature: 0.3,
  })) as { response?: string };
  const anchor = sanitize(res.response ?? '');
  return { anchor, provider: 'workers-ai', tokensApprox: Math.ceil(prompt.length / 4) };
}

async function callOpenAI(kek: string, encKey: Uint8Array, prompt: string): Promise<AnchorGenOutput> {
  const key = await decrypt(encKey, kek);
  const res = await fetch('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: 'gpt-4o-mini',
      messages: [{ role: 'user', content: prompt }],
      max_tokens: 32,
      temperature: 0.3,
    }),
  });
  if (!res.ok) throw new Error(`openai_${res.status}`);
  const data = (await res.json()) as { choices?: Array<{ message?: { content?: string } }> };
  const anchor = sanitize(data.choices?.[0]?.message?.content ?? '');
  return { anchor, provider: 'byok-openai', tokensApprox: Math.ceil(prompt.length / 4) };
}

async function callAnthropic(kek: string, encKey: Uint8Array, prompt: string): Promise<AnchorGenOutput> {
  const key = await decrypt(encKey, kek);
  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'x-api-key': key,
      'anthropic-version': '2023-06-01',
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model: 'claude-haiku-4-5',
      max_tokens: 32,
      messages: [{ role: 'user', content: prompt }],
    }),
  });
  if (!res.ok) throw new Error(`anthropic_${res.status}`);
  const data = (await res.json()) as { content?: Array<{ text?: string }> };
  const anchor = sanitize(data.content?.[0]?.text ?? '');
  return { anchor, provider: 'byok-anthropic', tokensApprox: Math.ceil(prompt.length / 4) };
}

function sanitize(raw: string): string {
  let s = raw.trim();
  // Strip wrapping quotes, trailing punctuation, anchor: prefixes.
  s = s.replace(/^["'`]+|["'`]+$/g, '').trim();
  s = s.replace(/^anchor( text)?:\s*/i, '').trim();
  s = s.replace(/[.!?,;:]+$/g, '').trim();
  // Cap at 5 words.
  const words = s.split(/\s+/);
  if (words.length > 5) s = words.slice(0, 5).join(' ');
  return s;
}

function clip(s: string, max: number): string {
  return s.length <= max ? s : s.slice(0, max - 1) + '…';
}

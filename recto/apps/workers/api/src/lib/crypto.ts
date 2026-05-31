// Envelope encryption + HMAC signing. WebCrypto only — no npm crypto deps.
// - encrypt/decrypt: AES-256-GCM with random 12-byte IV prepended to ciphertext.
//   v1 uses a single master KEK directly. Per-user DEK envelope will land before
//   AppSumo launch (TRD §10) without changing the call sites.
// - sign/verify: HMAC-SHA-256 producing url-safe base64.
// - hashToken: SHA-256(token) returning hex, used to store magic links and sessions.

async function importKekRaw(kek: string): Promise<CryptoKey> {
  // KEK is provided as base64. 32 bytes (256 bits).
  const raw = b64decode(kek);
  if (raw.byteLength !== 32) {
    throw new Error('RECTO_KEK must be 32 bytes base64-encoded');
  }
  return crypto.subtle.importKey('raw', raw, 'AES-GCM', false, ['encrypt', 'decrypt']);
}

async function importHmacRaw(secret: string): Promise<CryptoKey> {
  const raw = new TextEncoder().encode(secret);
  return crypto.subtle.importKey(
    'raw',
    raw,
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign', 'verify']
  );
}

// ====== AES-GCM envelope ======

export async function encrypt(plaintext: string, kek: string): Promise<Uint8Array> {
  const key = await importKekRaw(kek);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const enc = new TextEncoder().encode(plaintext);
  const ct = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, enc);
  const out = new Uint8Array(12 + ct.byteLength);
  out.set(iv, 0);
  out.set(new Uint8Array(ct), 12);
  return out;
}

export async function decrypt(envelope: Uint8Array, kek: string): Promise<string> {
  if (envelope.byteLength < 13) throw new Error('envelope too short');
  const key = await importKekRaw(kek);
  const iv = envelope.subarray(0, 12);
  const ct = envelope.subarray(12);
  const pt = await crypto.subtle.decrypt({ name: 'AES-GCM', iv }, key, ct);
  return new TextDecoder().decode(pt);
}

// ====== HMAC signing for cookies and tokens ======

export async function sign(payload: string, secret: string): Promise<string> {
  const key = await importHmacRaw(secret);
  const sig = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(payload));
  return b64urlencode(new Uint8Array(sig));
}

export async function verify(payload: string, signature: string, secret: string): Promise<boolean> {
  const key = await importHmacRaw(secret);
  try {
    return await crypto.subtle.verify(
      'HMAC',
      key,
      b64urldecode(signature),
      new TextEncoder().encode(payload)
    );
  } catch {
    return false;
  }
}

// ====== Hashing tokens (one-way) ======

export async function hashToken(token: string): Promise<string> {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(token));
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

// ====== Random tokens (url-safe) ======

export function randomToken(bytes = 32): string {
  return b64urlencode(crypto.getRandomValues(new Uint8Array(bytes)));
}

// ====== Base64 helpers ======

function b64decode(s: string): Uint8Array {
  const norm = s.replace(/-/g, '+').replace(/_/g, '/');
  const bin = atob(norm);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

function b64urlencode(b: Uint8Array): string {
  let s = '';
  for (let i = 0; i < b.length; i++) s += String.fromCharCode(b[i] ?? 0);
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function b64urldecode(s: string): Uint8Array {
  const pad = s.length % 4 === 0 ? '' : '='.repeat(4 - (s.length % 4));
  return b64decode(s + pad);
}

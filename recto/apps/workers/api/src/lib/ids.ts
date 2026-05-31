// ULID — sortable 26-char identifiers. No npm dep; ~30 LOC.
// Format: 10 chars time (ms since epoch) + 16 chars randomness, Crockford base32.

const ENCODING = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';

function encode(value: number, length: number): string {
  let out = '';
  for (let i = length - 1; i >= 0; i--) {
    const mod = value % 32;
    out = ENCODING[mod] + out;
    value = (value - mod) / 32;
  }
  return out;
}

function randomBits(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(10));
  let out = '';
  for (let i = 0; i < 16; i++) {
    // Take 5 bits at a time from the byte stream.
    const bitIdx = i * 5;
    const byteIdx = Math.floor(bitIdx / 8);
    const bitOffset = bitIdx % 8;
    let val = bytes[byteIdx] ?? 0;
    if (bitOffset + 5 > 8 && byteIdx + 1 < bytes.length) {
      val = ((val << 8) | (bytes[byteIdx + 1] ?? 0)) >> (16 - bitOffset - 5);
    } else {
      val = val >> (8 - bitOffset - 5);
    }
    out += ENCODING[val & 31];
  }
  return out;
}

export function ulid(now: number = Date.now()): string {
  return encode(now, 10) + randomBits();
}

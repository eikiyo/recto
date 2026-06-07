// Shared queue helpers.
//
// Cloudflare Queues are at-least-once and, with no max_retries / dead_letter
// configured, fall back to the platform default of ~100 deliveries before a
// message is SILENTLY dropped. A handler that calls msg.retry() on every
// exception therefore lets a genuinely poison message (bad state, deleted row,
// permanently-down dependency) burn ~100 invocations and then vanish without a
// trace. retryOrDrop caps the retries and drops with a LOUD structured log so
// the failure is visible instead of silent. (Hardened 2026-06-06.)

type RetryableMessage = {
  attempts?: number;
  retry: (opts?: { delaySeconds?: number }) => void;
  ack: () => void;
};

export function retryOrDrop(
  msg: RetryableMessage,
  label: string,
  ctx: Record<string, unknown>,
  maxDeliveries: number,
  delaySeconds: number
): void {
  const attempts = msg.attempts ?? 1;
  if (attempts >= maxDeliveries) {
    console.error(`${label}: dropping poison message after ${attempts} deliveries`, ctx);
    msg.ack();
    return;
  }
  msg.retry({ delaySeconds });
}

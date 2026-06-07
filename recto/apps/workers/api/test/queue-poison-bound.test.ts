// Poison-message regression (2026-06-07): the q-push and q-verify consumers
// caught unexpected exceptions with a BARE `msg.retry()` and no delivery cap, so
// a message that throws on every delivery (e.g. a malformed stored site_url that
// makes `new URL()` raise, or a persistent D1 error) looped to the ~100-delivery
// platform default and was then SILENTLY dropped. Every other consumer routes
// exceptions through retryOrDrop; these two (the user's most important actions —
// insert the link, confirm it's live) had been missed. These tests drive the
// REAL batch handlers with an env whose first DB.prepare throws, and assert the
// catch is bounded: retried below the cap, dropped (ack + loud log) at the cap.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { Env } from '../src/env';
import { handlePushBatch } from '../src/jobs/push';
import { handleVerifyBatch } from '../src/jobs/verify';

// An env whose every DB query throws — forces the consumer's outer catch.
function throwingEnv(): Env {
  return {
    DB: { prepare: () => { throw new Error('boom: persistent D1 failure'); } },
  } as unknown as Env;
}

function fakeMsg(body: unknown, attempts: number) {
  return {
    body,
    attempts,
    retry: vi.fn(),
    ack: vi.fn(),
  };
}

beforeEach(() => {
  vi.spyOn(console, 'error').mockImplementation(() => undefined);
});
afterEach(() => {
  vi.restoreAllMocks();
});

describe('q-push consumer — poison exception path is delivery-bounded', () => {
  it('retries below the cap', async () => {
    const msg = fakeMsg({ pushId: 'p1' }, 2);
    await handlePushBatch({ messages: [msg] } as never, throwingEnv());
    expect(msg.retry).toHaveBeenCalledTimes(1);
    expect(msg.ack).not.toHaveBeenCalled();
  });
  it('drops (ack, no retry) at the cap instead of looping forever', async () => {
    const msg = fakeMsg({ pushId: 'p1' }, 5); // MAX_PUSH_DELIVERIES
    await handlePushBatch({ messages: [msg] } as never, throwingEnv());
    expect(msg.retry).not.toHaveBeenCalled();
    expect(msg.ack).toHaveBeenCalledTimes(1);
  });
});

describe('q-verify consumer — poison exception path is delivery-bounded', () => {
  it('retries below the cap', async () => {
    const msg = fakeMsg({ pushId: 'p1', attempt: 1 }, 2);
    await handleVerifyBatch({ messages: [msg] } as never, throwingEnv());
    expect(msg.retry).toHaveBeenCalledTimes(1);
    expect(msg.ack).not.toHaveBeenCalled();
  });
  it('drops (ack, no retry) at the cap instead of looping forever', async () => {
    const msg = fakeMsg({ pushId: 'p1', attempt: 1 }, 5); // MAX_VERIFY_DELIVERIES
    await handleVerifyBatch({ messages: [msg] } as never, throwingEnv());
    expect(msg.retry).not.toHaveBeenCalled();
    expect(msg.ack).toHaveBeenCalledTimes(1);
  });
});

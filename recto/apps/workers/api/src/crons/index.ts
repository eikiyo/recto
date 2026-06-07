// Cron dispatcher. wrangler.toml lists 3 schedules; we route on controller.cron.
//
//   "0 6 * * *"   → gscDailyIncremental    (GSC daily incremental pull)
//   "0 * * * *"   → hourlySweep            (weekly-digest fan-out)
//   "0 0 * * *"   → reverifySweep          (push-verification refresher)

import type { Env } from '../env';
import { gscDailyIncremental } from './gsc-daily';
import { hourlySweep } from './hourly';
import { reverifySweep } from './reverify';

export async function handleScheduled(
  controller: ScheduledController,
  env: Env,
  _ctx: ExecutionContext
): Promise<void> {
  const cron = controller.cron;
  // Wrap each job so a failure surfaces with the cron id + error instead of an
  // anonymous unhandled rejection that tells ops nothing about WHICH scheduled
  // job died. Re-throw so the invocation is still recorded as failed in
  // observability. (Hardened 2026-06-06.)
  try {
    switch (cron) {
      case '0 6 * * *':
        await gscDailyIncremental(env);
        return;
      case '0 * * * *':
        await hourlySweep(env);
        return;
      case '0 0 * * *':
        await reverifySweep(env);
        return;
      default:
        console.warn('unhandled cron', cron);
    }
  } catch (err) {
    console.error('scheduled-handler-error', { cron, name: (err as Error).name, msg: (err as Error).message });
    throw err;
  }
}

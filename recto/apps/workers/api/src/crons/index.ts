// Cron dispatcher. wrangler.toml lists 5 schedules; we route on controller.cron.
//
//   "0 6 * * *"   → gscDailyIncremental    (GSC D2.3)
//   "0 * * * *"   → hourlySweep            (BYOK-threshold sweep + tz fan-out)
//   "0 0 * * *"   → reverifySweep          (push-verification refresher; D6.2)
//   "0 0 1 * *"   → monthlyAnchorReset     (1st of month, 00:00 UTC: credits = codes×100)
//   "0 1 1 * *"   → monthlyAnchorAudit     (1st of month, 01:00 UTC: self-heal any drift
//                                           left by the reset cron; safe to run alone)

import type { Env } from '../env';
import { gscDailyIncremental } from './gsc-daily';
import { hourlySweep } from './hourly';
import { reverifySweep } from './reverify';
import { monthlyAnchorReset } from './monthly-reset';
import { monthlyAnchorAudit } from './monthly-audit';

export async function handleScheduled(
  controller: ScheduledController,
  env: Env,
  _ctx: ExecutionContext
): Promise<void> {
  const cron = controller.cron;
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
    case '0 0 1 * *':
      await monthlyAnchorReset(env);
      return;
    case '0 1 1 * *':
      await monthlyAnchorAudit(env);
      return;
    default:
      console.warn('unhandled cron', cron);
  }
}

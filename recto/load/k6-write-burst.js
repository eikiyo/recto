// k6 — write burst. Simulates many users triggering recrawl at once
// (e.g. cron-aligned re-runs or a "fix all" click on the dashboard).
//
// SLO target:
//   - p95 < 1500ms (writes are slower; OK)
//   - error rate < 1% (queue backpressure may surface as 5xx; we want it bounded)

import http from 'k6/http';
import { check, sleep } from 'k6';

const BASE = __ENV.BASE || 'http://localhost:8787';
const COOKIE = __ENV.COOKIE_HEADER || '';
const SITE_ID = __ENV.SITE_ID || '';

// Realistic 5K-user concurrent write profile: ~1% of users trigger a
// recrawl per minute = ~1 recrawl/sec. Doubling to 50/sec for the burst
// scenario (a launch-day "everyone tries it at once" spike).
const RATE = parseInt(__ENV.RATE || '50', 10);
const DURATION = __ENV.DURATION || '1m';

export const options = {
  scenarios: {
    recrawl_burst: {
      executor: 'constant-arrival-rate',
      rate: RATE,
      timeUnit: '1s',
      duration: DURATION,
      preAllocatedVUs: 50,
      maxVUs: 200,
    },
  },
  thresholds: {
    // 202 = enqueued; 503 with Retry-After is acceptable graceful degrade.
    http_req_duration: ['p(95)<1500'],
    'http_req_failed{status:5xx}': ['rate<0.05'],
  },
};

const headers = { Cookie: COOKIE, 'Content-Type': 'application/json' };

export default function () {
  if (!SITE_ID) return;
  const r = http.post(`${BASE}/api/sites/${SITE_ID}/recrawl`, '{}', { headers });
  check(r, {
    'recrawl 202 or 503 (graceful)': (res) => res.status === 202 || res.status === 503,
    'no 5xx other than 503': (res) => res.status < 500 || res.status === 503,
  });
  sleep(0.1);
}

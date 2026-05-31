// k6 — AppSumo webhook flood. Worst-case is a launch-day spike where
// thousands of redemptions hit /api/webhooks/appsumo/webhook at once.
//
// SLO target:
//   - p95 < 800ms
//   - error rate < 0.5%

import http from 'k6/http';
import crypto from 'k6/crypto';
import { check } from 'k6';

const BASE = __ENV.BASE || 'http://localhost:8787';
const SECRET = __ENV.WEBHOOK_SECRET || '';

export const options = {
  scenarios: {
    webhook_flood: {
      executor: 'constant-arrival-rate',
      rate: 100,             // 100 webhooks/sec
      timeUnit: '1s',
      duration: '1m',
      preAllocatedVUs: 50,
      maxVUs: 300,
    },
  },
  thresholds: {
    http_req_duration: ['p(95)<800'],
    http_req_failed: ['rate<0.005'],
  },
};

export default function () {
  const eventId = 'load-' + __VU + '-' + __ITER;
  const body = JSON.stringify({
    event: 'activate',
    event_id: eventId,
    email: 'load-' + __VU + '@example.com',
    appsumo_code: 'LOAD-' + __VU + '-' + __ITER,
    tier: 2,
  });
  const sig = crypto.hmac('sha256', SECRET, body, 'base64rawurl');
  const res = http.post(`${BASE}/api/webhooks/appsumo/webhook`, body, {
    headers: { 'Content-Type': 'application/json', 'x-appsumo-signature': sig },
  });
  check(res, { 'webhook 200': (r) => r.status === 200 });
}

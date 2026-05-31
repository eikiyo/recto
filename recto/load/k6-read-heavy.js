// k6 — read-heavy load test simulating the workbench/dashboard surface.
//
// Scenario: 5000 VUs ramping over 2 minutes, sustaining 5 minutes, then
// ramping down 2 minutes. Each VU loops:
//   1. GET /api/auth/me (auth check)
//   2. GET /api/workbench/since (3 numerals)
//   3. GET /api/workbench/sites (site rows)
//   4. GET /api/pushes?limit=20 (audit feed)
//   5. GET /api/errors/messages (cacheable, but every page loads it)
//
// SLO target:
//   - http_req_duration p95 < 500ms
//   - http_req_failed rate < 0.1%
//
// Auth: each VU uses a pre-seeded session cookie passed via env var
// COOKIE_HEADER. See load/seed-cookie.sh.
//
// Run:
//   COOKIE_HEADER='recto_session=...' BASE=http://localhost:8787 k6 run load/k6-read-heavy.js

import http from 'k6/http';
import { check, sleep } from 'k6';

const BASE = __ENV.BASE || 'http://localhost:8787';
const COOKIE = __ENV.COOKIE_HEADER || '';

const TARGET_VUS = parseInt(__ENV.TARGET_VUS || '5000', 10);
const RAMP = __ENV.RAMP || '2m';
const HOLD = __ENV.HOLD || '5m';
const RAMP_DOWN = __ENV.RAMP_DOWN || '2m';
// Smoke mode lowers thresholds because miniflare is single-threaded and
// will not match production p95 numbers. Real numbers come from running
// against the deployed Worker via BASE=https://api.recto.so.
const MODE = __ENV.MODE || 'full'; // smoke | full

export const options = {
  scenarios: {
    dashboard: {
      executor: 'ramping-vus',
      startVUs: 0,
      stages: [
        { duration: RAMP, target: TARGET_VUS },
        { duration: HOLD, target: TARGET_VUS },
        { duration: RAMP_DOWN, target: 0 },
      ],
      gracefulRampDown: '30s',
    },
  },
  thresholds: MODE === 'smoke' ? {
    http_req_duration: ['p(95)<3000'],
    http_req_failed: ['rate<0.05'],
    checks: ['rate>0.95'],
  } : {
    http_req_duration: ['p(95)<500', 'p(99)<1500'],
    http_req_failed: ['rate<0.001'],
    checks: ['rate>0.999'],
  },
};

const headers = {
  Cookie: COOKIE,
  Accept: 'application/json',
};

export default function () {
  const r1 = http.get(`${BASE}/api/auth/me`, { headers });
  check(r1, { 'me 200': (r) => r.status === 200 });

  const r2 = http.get(`${BASE}/api/workbench/since`, { headers });
  check(r2, { 'since 200': (r) => r.status === 200 });

  const r3 = http.get(`${BASE}/api/workbench/sites`, { headers });
  check(r3, { 'sites 200': (r) => r.status === 200 });

  const r4 = http.get(`${BASE}/api/pushes?limit=20`, { headers });
  check(r4, { 'pushes 200': (r) => r.status === 200 });

  const r5 = http.get(`${BASE}/api/errors/messages`);
  check(r5, { 'errors 200': (r) => r.status === 200 });

  sleep(1);
}

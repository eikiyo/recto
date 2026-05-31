#!/usr/bin/env bash
# scripts/smoke.sh — local end-to-end happy path smoke.
#
# Boots wrangler dev (local mode = miniflare) against the API worker, runs
# D1 migrations, then drives the magic-link → connect-site → recrawl flow
# with curl. Exits non-zero on any failure.
#
# Usage:
#   pnpm --filter @recto/api smoke         (defined in package.json scripts)
#   or directly: scripts/smoke.sh
#
# Pre-reqs: pnpm install, plus jq + curl + lsof on PATH.

set -euo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$HERE/.."
API="$ROOT/apps/workers/api"
BASE="http://localhost:8787"
COOKIES="$(mktemp)"
LOG="${WRANGLER_LOG:-/tmp/recto-smoke-wrangler.log}"
: > "$LOG"
PORT=8787
PID=""

cleanup() {
  if [ -n "$PID" ]; then
    kill "$PID" 2>/dev/null || true
    wait "$PID" 2>/dev/null || true
  fi
  rm -f "$COOKIES"
}
trap cleanup EXIT

step() { printf '\n\033[36m== %s\033[0m\n' "$*"; }
ok()   { printf '\033[32m✓\033[0m %s\n' "$*"; }
fail() {
  printf '\033[31m✗ %s\033[0m\n' "$*" >&2
  printf '\n--- wrangler log tail ---\n' >&2
  tail -80 "$LOG" >&2
  exit 1
}

require() { command -v "$1" >/dev/null || fail "missing dep: $1"; }
require jq
require curl
require lsof
require pnpm

if lsof -i ":$PORT" >/dev/null 2>&1; then
  fail "port $PORT already in use — kill the running worker first"
fi

step "Reset local miniflare state (idempotency)"
rm -rf "$API/.miniflare"
ok "state reset"

step "Apply migrations (local D1)"
( cd "$API" && pnpm db:migrate:local >/dev/null 2>&1 ) || fail "migration failed"
ok "migrations applied"

step "Boot wrangler dev (local mode)"
( cd "$API" && pnpm wrangler dev --local --port "$PORT" --persist-to .miniflare >"$LOG" 2>&1 ) &
PID=$!

# Wait for the worker to come up — poll /api/health for 20s.
for i in $(seq 1 40); do
  if curl -fsS "$BASE/api/health" >/dev/null 2>&1; then
    ok "worker up (pid=$PID)"
    break
  fi
  sleep 0.5
  if [ "$i" = 40 ]; then
    echo "--- wrangler log tail ---"
    tail -50 "$LOG"
    fail "worker did not come up"
  fi
done

# ── Seed a license so /api/sites POST won't be blocked by tier cap ──────
step "Seed test license via direct D1 write"
( cd "$API" && pnpm wrangler d1 execute recto --local --persist-to .miniflare --command \
  "INSERT INTO users (id, email, created_at, digest_opt_in) VALUES ('test-user-01', 'smoke@example.com', strftime('%s','now')*1000, 1) ON CONFLICT DO NOTHING; \
   INSERT INTO licenses (id, user_id, appsumo_code, tier, redeemed_at) VALUES ('test-lic-01', 'test-user-01', 'SMOKE-CODE-001', 2, strftime('%s','now')*1000) ON CONFLICT DO NOTHING; \
   UPDATE users SET anchor_credits = 100 WHERE id = 'test-user-01';" \
  >/dev/null 2>&1 ) || fail "seed failed"
ok "license seeded"

step "Magic link request"
MAGIC=$(curl -fsS -c "$COOKIES" -X POST "$BASE/api/auth/magic" \
  -H 'Content-Type: application/json' -H 'Origin: http://localhost:8765' \
  -d '{"email":"smoke@example.com"}')
TOKEN=$(echo "$MAGIC" | jq -r '.devToken // empty')
[ -n "$TOKEN" ] || fail "no devToken in response: $MAGIC"
ok "magic link minted (devToken length=${#TOKEN})"

step "Callback exchanges token for cookie"
curl -fsS -c "$COOKIES" -b "$COOKIES" "$BASE/api/auth/callback?token=$TOKEN" -o /dev/null
grep -q recto_session "$COOKIES" || fail "no session cookie set"
ok "session cookie set"

step "Whoami"
ME=$(curl -fsS -b "$COOKIES" "$BASE/api/auth/me")
EMAIL=$(echo "$ME" | jq -r '.email')
[ "$EMAIL" = "smoke@example.com" ] || fail "wrong email: $ME"
ok "authenticated as $EMAIL"

step "Workbench since (expect zeros on empty user)"
SINCE=$(curl -fsS -b "$COOKIES" "$BASE/api/workbench/since")
echo "$SINCE" | jq -e '.pages == 0 and .orphans == 0' >/dev/null || fail "non-zero since: $SINCE"
ok "workbench since clean"

step "Connect a site"
CONNECT=$(curl -fsS -b "$COOKIES" -X POST "$BASE/api/sites" \
  -H 'Content-Type: application/json' -H 'Origin: http://localhost:8765' \
  -d '{"url":"https://example.com","cms":"wordpress","wp_username":"u","wp_app_password":"abcd efgh ijkl mnop qrst uvwx"}')
SITE_ID=$(echo "$CONNECT" | jq -r '.id')
[ -n "$SITE_ID" ] && [ "$SITE_ID" != "null" ] || fail "no site id: $CONNECT"
ok "site id=$SITE_ID"

step "Sites list shows the new site"
SITES=$(curl -fsS -b "$COOKIES" "$BASE/api/sites")
echo "$SITES" | jq -e ".sites | length == 1" >/dev/null || fail "wrong site count: $SITES"
ok "sites count = 1"

step "Audit log empty"
PUSHES=$(curl -fsS -b "$COOKIES" "$BASE/api/pushes")
echo "$PUSHES" | jq -e ".pushes | length == 0" >/dev/null || fail "audit not empty: $PUSHES"
ok "pushes = 0"

step "Error-messages map populated"
ERR=$(curl -fsS "$BASE/api/errors/messages")
echo "$ERR" | jq -e '.messages.wp_auth_failed.what != null' >/dev/null || fail "missing failure code mapping"
ok "error map ok"

step "Cross-origin preflight returns CORS headers for SPA"
HEADERS=$(curl -fsSI -X OPTIONS "$BASE/api/sites" -H 'Origin: http://localhost:8765' -H 'Access-Control-Request-Method: POST')
echo "$HEADERS" | grep -i "access-control-allow-origin: http://localhost:8765" >/dev/null || fail "missing CORS allow-origin"
echo "$HEADERS" | grep -i "access-control-allow-credentials: true" >/dev/null || fail "missing CORS credentials"
ok "CORS preflight ok"

printf '\n\033[32mSMOKE PASS\033[0m\n'

#!/usr/bin/env bash
# Integration tests against the live worker (wrangler dev local).
# Builds on scripts/smoke.sh — same boot mechanism, more assertions.

set -euo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$HERE/.."
API="$ROOT/apps/workers/api"
BASE="http://localhost:8787"
PORT=8787
USER_A_COOKIES="$(mktemp)"
USER_B_COOKIES="$(mktemp)"
LOG="${WRANGLER_LOG:-/tmp/recto-integration-wrangler.log}"
: > "$LOG"
PID=""
FAIL=0

cleanup() {
  if [ -n "$PID" ]; then kill "$PID" 2>/dev/null || true; wait "$PID" 2>/dev/null || true; fi
  rm -f "$USER_A_COOKIES" "$USER_B_COOKIES"
}
trap cleanup EXIT

step() { printf '\n\033[36m== %s\033[0m\n' "$*"; }
ok()   { printf '\033[32m  ✓\033[0m %s\n' "$*"; }
ng()   { printf '\033[31m  ✗\033[0m %s\n' "$*" >&2; FAIL=$((FAIL+1)); }

assert_eq()  { if [ "$2" = "$3" ]; then ok "$1"; else ng "$1: got '$2' expected '$3'"; fi; }
assert_ne()  { if [ "$2" != "$3" ]; then ok "$1"; else ng "$1: got '$2' should not equal '$3'"; fi; }
assert_neq() { assert_ne "$@"; }

# Wrap curl: return only the HTTP status code.
status() { curl -s -o /dev/null -w '%{http_code}' "$@"; }

if lsof -i ":$PORT" >/dev/null 2>&1; then
  echo "fatal: port $PORT busy" >&2; exit 1
fi

step "Boot fresh worker"
rm -rf "$API/.miniflare"
( cd "$API" && pnpm db:migrate:local >/dev/null 2>&1 )
( cd "$API" && pnpm wrangler dev --local --port "$PORT" --persist-to .miniflare >"$LOG" 2>&1 ) &
PID=$!
for i in $(seq 1 40); do
  if curl -fsS "$BASE/api/health" >/dev/null 2>&1; then ok "worker up"; break; fi
  sleep 0.5
  if [ "$i" = 40 ]; then tail -40 "$LOG"; exit 1; fi
done

# ── Seed two users (self-hosted: no licenses, no caps) ─────────────────
step "Seed users A and B"
( cd "$API" && pnpm wrangler d1 execute recto --local --persist-to .miniflare --command \
  "INSERT INTO users (id, email, created_at, digest_opt_in) VALUES ('user-A','a@example.com', strftime('%s','now')*1000, 1); \
   INSERT INTO users (id, email, created_at, digest_opt_in) VALUES ('user-B','b@example.com', strftime('%s','now')*1000, 1);" >/dev/null 2>&1 )
ok "seeded"

login() {
  local email="$1" jar="$2"
  local tok=$(curl -fsS -c "$jar" -X POST "$BASE/api/auth/magic" -H 'Content-Type: application/json' \
    -d "{\"email\":\"$email\"}" | jq -r '.devToken')
  curl -fsS -c "$jar" -b "$jar" "$BASE/api/auth/callback?token=$tok" -o /dev/null
}

# ── AUTH ─────────────────────────────────────────────────────────────
step "Auth"

login a@example.com "$USER_A_COOKIES"
login b@example.com "$USER_B_COOKIES"

ME_A=$(curl -fsS -b "$USER_A_COOKIES" "$BASE/api/auth/me" | jq -r '.email')
assert_eq "A authenticated" "$ME_A" "a@example.com"

ME_B=$(curl -fsS -b "$USER_B_COOKIES" "$BASE/api/auth/me" | jq -r '.email')
assert_eq "B authenticated" "$ME_B" "b@example.com"

UNAUTH=$(status "$BASE/api/auth/me")
assert_eq "no-cookie /me returns 401" "$UNAUTH" "401"

# Magic-link replay protection: tokens are single-use.
TOK=$(curl -fsS -X POST "$BASE/api/auth/magic" -H 'Content-Type: application/json' -d '{"email":"a@example.com"}' | jq -r '.devToken')
S1=$(status "$BASE/api/auth/callback?token=$TOK")
S2=$(status "$BASE/api/auth/callback?token=$TOK")
assert_eq "first callback ok" "$S1" "302"
assert_neq "replayed token rejected" "$S2" "302"

# ── SITES + SCOPE ────────────────────────────────────────────────────
step "Sites + cross-user isolation"

# A creates a site.
SITE_A=$(curl -fsS -b "$USER_A_COOKIES" -X POST "$BASE/api/sites" -H 'Content-Type: application/json' \
  -d '{"url":"https://a.com","cms":"wordpress","wp_username":"u","wp_app_password":"a b c d e f"}' | jq -r '.id')
assert_ne "A site created" "$SITE_A" "null"
assert_ne "A site id non-empty" "$SITE_A" ""

# Self-hosted is unlimited — a 2nd site must succeed (no cap).
SITE_A2=$(curl -fsS -b "$USER_A_COOKIES" -X POST "$BASE/api/sites" -H 'Content-Type: application/json' \
  -d '{"url":"https://a2.com","cms":"wordpress","wp_username":"u","wp_app_password":"a b c d e f"}' | jq -r '.id')
assert_ne "A second site created (unlimited)" "$SITE_A2" "null"

# B reads A's site — must return 404 (not exists in their scope).
SCOPE=$(status -b "$USER_B_COOKIES" "$BASE/api/sites/$SITE_A/orphans")
assert_eq "B reading A's orphans = 404" "$SCOPE" "404"

# Verify B's sites list does NOT include A's site.
B_SITES_COUNT=$(curl -fsS -b "$USER_B_COOKIES" "$BASE/api/sites" | jq '.sites | length')
assert_eq "B sees 0 sites" "$B_SITES_COUNT" "0"

# Duplicate connect returns 409.
SITE_B=$(curl -fsS -b "$USER_B_COOKIES" -X POST "$BASE/api/sites" -H 'Content-Type: application/json' \
  -d '{"url":"https://b.com","cms":"wordpress","wp_username":"u","wp_app_password":"a b c d e f"}' | jq -r '.id')
assert_ne "B site created" "$SITE_B" "null"

DUPE=$(status -b "$USER_B_COOKIES" -X POST "$BASE/api/sites" -H 'Content-Type: application/json' \
  -d '{"url":"https://b.com","cms":"wordpress","wp_username":"u","wp_app_password":"a b c d e f"}')
assert_eq "B duplicate site = 409 (not 500)" "$DUPE" "409"

# ── ERROR MESSAGES ───────────────────────────────────────────────────
step "Error catalog"
ERR_PUBLIC=$(status "$BASE/api/errors/messages")
assert_eq "error map is public" "$ERR_PUBLIC" "200"
HAS_KEY=$(curl -fsS "$BASE/api/errors/messages" | jq -r '.messages.wp_auth_failed.fix')
assert_ne "wp_auth_failed has a fix" "$HAS_KEY" ""

# ── PUSHES AUDIT (empty + filter) ─────────────────────────────────────
step "Audit log shapes"
PUSHES=$(curl -fsS -b "$USER_A_COOKIES" "$BASE/api/pushes?status=verified" | jq '.pushes | length')
assert_eq "filter by status returns 0 for empty user" "$PUSHES" "0"

INVALID_RETRY=$(status -b "$USER_A_COOKIES" -X POST "$BASE/api/pushes/does-not-exist/retry")
assert_eq "retry non-existent = 404" "$INVALID_RETRY" "404"

# ── LOGOUT ───────────────────────────────────────────────────────────
step "Logout invalidates session"
LO=$(status -b "$USER_A_COOKIES" -X POST "$BASE/api/auth/logout")
assert_eq "logout ok" "$LO" "200"
POST_LO=$(status -b "$USER_A_COOKIES" "$BASE/api/auth/me")
assert_eq "session invalidated" "$POST_LO" "401"

# ── SUMMARY ──────────────────────────────────────────────────────────
printf '\n'
if [ "$FAIL" -gt 0 ]; then
  printf '\033[31mINTEGRATION FAIL — %d assertion(s) failed\033[0m\n' "$FAIL"
  printf '\n--- wrangler log tail ---\n'
  tail -60 "$LOG"
  exit 1
fi
printf '\033[32mINTEGRATION PASS\033[0m\n'

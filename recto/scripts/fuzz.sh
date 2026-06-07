#!/usr/bin/env bash
# Targeted endpoint fuzzer. Pounds each route with deliberately bad inputs.
# The contract: never crash to 500. All rejections must be 4xx with a
# typed error code.
#
# Categories of bad input we throw:
#   - empty body
#   - non-JSON body
#   - missing required field
#   - wrong type (number where string)
#   - oversized payload (~64KB)
#   - path traversal in IDs (../, %2e%2e)
#   - SQL injection attempts in slug params
#   - control chars + null bytes

set -euo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$HERE/.."
API="$ROOT/apps/workers/api"
BASE="http://localhost:8787"
PORT=8787
COOKIES="$(mktemp)"
LOG="${WRANGLER_LOG:-/tmp/recto-fuzz-wrangler.log}"
: > "$LOG"
PID=""
FAIL=0
TOTAL=0

cleanup() {
  if [ -n "$PID" ]; then kill "$PID" 2>/dev/null || true; wait "$PID" 2>/dev/null || true; fi
  rm -f "$COOKIES"
}
trap cleanup EXIT

step() { printf '\n\033[36m== %s\033[0m\n' "$*"; }
ok()   { printf '\033[32m  ✓\033[0m %s\n' "$*"; }
ng()   { printf '\033[31m  ✗\033[0m %s\n' "$*" >&2; FAIL=$((FAIL+1)); }
status() { curl -s -o /dev/null -w '%{http_code}' "$@"; }

assert_not_5xx() {
  TOTAL=$((TOTAL+1))
  local label="$1" code="$2"
  if [ "$code" -ge 500 ] 2>/dev/null && [ "$code" -lt 600 ]; then
    ng "$label: returned $code (must never 5xx)"
  else
    ok "$label: $code"
  fi
}

if lsof -i ":$PORT" >/dev/null 2>&1; then echo "port $PORT busy" >&2; exit 1; fi

step "Boot worker"
rm -rf "$API/.miniflare"
( cd "$API" && pnpm db:migrate:local >/dev/null 2>&1 )
( cd "$API" && pnpm wrangler dev --local --port "$PORT" --persist-to .miniflare >"$LOG" 2>&1 ) &
PID=$!
for i in $(seq 1 40); do
  if curl -fsS "$BASE/api/health" >/dev/null 2>&1; then break; fi
  sleep 0.5
  if [ "$i" = 40 ]; then tail -40 "$LOG"; exit 1; fi
done

step "Seed user"
( cd "$API" && pnpm wrangler d1 execute recto --local --persist-to .miniflare --command \
  "INSERT INTO users (id, email, created_at, digest_opt_in) VALUES ('fuzz-user','fuzz@example.com', strftime('%s','now')*1000, 1);" >/dev/null 2>&1 )

TOK=$(curl -fsS -X POST "$BASE/api/auth/magic" -H 'Content-Type: application/json' \
  -d '{"email":"fuzz@example.com"}' | jq -r '.devToken')
curl -fsS -c "$COOKIES" "$BASE/api/auth/callback?token=$TOK" -o /dev/null

# Construct a valid site to fuzz site-scoped endpoints.
SITE_ID=$(curl -fsS -b "$COOKIES" -X POST "$BASE/api/sites" -H 'Content-Type: application/json' \
  -d '{"url":"https://fuzz.example.com","cms":"wordpress","wp_username":"u","wp_app_password":"a b c d e f"}' | jq -r '.id')

# ── AUTH ───────────────────────────────────────────────────────────────
step "auth: bad inputs"
assert_not_5xx "empty body magic" $(status -X POST "$BASE/api/auth/magic" -H 'Content-Type: application/json' -d '')
assert_not_5xx "non-JSON magic" $(status -X POST "$BASE/api/auth/magic" -H 'Content-Type: application/json' -d 'not-json-at-all')
assert_not_5xx "missing email" $(status -X POST "$BASE/api/auth/magic" -H 'Content-Type: application/json' -d '{}')
assert_not_5xx "email wrong type" $(status -X POST "$BASE/api/auth/magic" -H 'Content-Type: application/json' -d '{"email": 42}')
assert_not_5xx "email garbage" $(status -X POST "$BASE/api/auth/magic" -H 'Content-Type: application/json' -d '{"email":"not-an-email"}')
assert_not_5xx "email injection" $(status -X POST "$BASE/api/auth/magic" -H 'Content-Type: application/json' -d "{\"email\":\"a@b'); DROP TABLE users; --\"}")
assert_not_5xx "callback no token" $(status "$BASE/api/auth/callback")
assert_not_5xx "callback garbage token" $(status "$BASE/api/auth/callback?token=$(printf 'A%.0s' {1..256})")
assert_not_5xx "callback with control chars" $(status "$BASE/api/auth/callback?token=%00%01%02")

# ── SITES ─────────────────────────────────────────────────────────────
step "sites: bad inputs"
assert_not_5xx "POST empty body" $(status -b "$COOKIES" -X POST "$BASE/api/sites" -H 'Content-Type: application/json' -d '')
assert_not_5xx "POST malformed JSON" $(status -b "$COOKIES" -X POST "$BASE/api/sites" -H 'Content-Type: application/json' -d '{not:valid')
assert_not_5xx "POST missing url" $(status -b "$COOKIES" -X POST "$BASE/api/sites" -H 'Content-Type: application/json' -d '{"cms":"wordpress"}')
assert_not_5xx "POST bad cms enum" $(status -b "$COOKIES" -X POST "$BASE/api/sites" -H 'Content-Type: application/json' -d '{"url":"https://x.com","cms":"shopify"}')
# javascript: scheme must be rejected with 400 (security: prevents XSS via dashboard link rendering)
JAVASCRIPT_CODE=$(status -b "$COOKIES" -X POST "$BASE/api/sites" -H 'Content-Type: application/json' -d '{"url":"javascript:alert(1)","cms":"wordpress","wp_username":"u","wp_app_password":"a b c d e f"}')
assert_not_5xx "POST javascript: url" "$JAVASCRIPT_CODE"
if [ "$JAVASCRIPT_CODE" != "400" ]; then ng "javascript: url should be 400 not $JAVASCRIPT_CODE"; else ok "javascript: url rejected with 400"; fi
assert_not_5xx "DELETE path traversal" $(status -b "$COOKIES" -X DELETE "$BASE/api/sites/..%2f..%2fetc%2fpasswd")
assert_not_5xx "DELETE non-existent" $(status -b "$COOKIES" -X DELETE "$BASE/api/sites/does-not-exist-id-9999")
assert_not_5xx "recrawl bad id" $(status -b "$COOKIES" -X POST "$BASE/api/sites/does-not-exist/recrawl")
BIG=$(printf 'A%.0s' {1..65536})
assert_not_5xx "POST oversized body" $(status -b "$COOKIES" -X POST "$BASE/api/sites" -H 'Content-Type: application/json' -d "{\"url\":\"https://x.com\",\"cms\":\"wordpress\",\"wp_username\":\"$BIG\",\"wp_app_password\":\"a b c d e f\"}")

# ── ORPHANS ───────────────────────────────────────────────────────────
step "orphans: bad inputs"
assert_not_5xx "orphans path traversal" $(status -b "$COOKIES" "$BASE/api/sites/..%2f..%2fetc/orphans")
assert_not_5xx "orphans wrong site" $(status -b "$COOKIES" "$BASE/api/sites/not-mine/orphans")
assert_not_5xx "orphans bad limit" $(status -b "$COOKIES" "$BASE/api/sites/$SITE_ID/orphans?limit=abc")
assert_not_5xx "orphans huge limit" $(status -b "$COOKIES" "$BASE/api/sites/$SITE_ID/orphans?limit=999999")
assert_not_5xx "orphans negative limit" $(status -b "$COOKIES" "$BASE/api/sites/$SITE_ID/orphans?limit=-5")

# ── PUSHES ────────────────────────────────────────────────────────────
step "pushes: bad inputs"
assert_not_5xx "push missing candidate" $(status -b "$COOKIES" -X POST "$BASE/api/pushes" -H 'Content-Type: application/json' -d '{}')
assert_not_5xx "push id with quotes" $(status -b "$COOKIES" -X POST "$BASE/api/pushes" -H 'Content-Type: application/json' -d '{"candidateId":"a\"; DROP TABLE pushes; --"}')
assert_not_5xx "retry non-existent" $(status -b "$COOKIES" -X POST "$BASE/api/pushes/12345/retry")
assert_not_5xx "list pushes bad status" $(status -b "$COOKIES" "$BASE/api/pushes?status=blah")
assert_not_5xx "list pushes bad limit" $(status -b "$COOKIES" "$BASE/api/pushes?limit=NaN")

# ── WORKBENCH ────────────────────────────────────────────────────────
step "workbench: bad inputs"
assert_not_5xx "publishing-gap missing siteId" $(status -b "$COOKIES" "$BASE/api/workbench/publishing-gap")
assert_not_5xx "publishing-gap nonexistent site" $(status -b "$COOKIES" "$BASE/api/workbench/publishing-gap?siteId=nope")
assert_not_5xx "publishing-gap injection" $(status -b "$COOKIES" "$BASE/api/workbench/publishing-gap?siteId=x%27%3B%20DROP%20TABLE%20sites%3B%20--")

# ── GSC ─────────────────────────────────────────────────────────────
step "gsc: bad inputs"
assert_not_5xx "connect bad siteId" $(status -b "$COOKIES" "$BASE/api/gsc/connect?siteId=garbage")
assert_not_5xx "select empty body" $(status -b "$COOKIES" -X POST "$BASE/api/gsc/select" -H 'Content-Type: application/json' -d '{}')
assert_not_5xx "disconnect missing siteId" $(status -b "$COOKIES" -X DELETE "$BASE/api/gsc/disconnect")

# ── CANDIDATES ───────────────────────────────────────────────────────
step "candidates: bad inputs"
assert_not_5xx "list with bad orphan" $(status -b "$COOKIES" "$BASE/api/sites/$SITE_ID/orphans/00000/candidates")
assert_not_5xx "regenerate nonexistent" $(status -b "$COOKIES" -X POST "$BASE/api/candidates/00000/regenerate-anchor")

# ── SUMMARY ──────────────────────────────────────────────────────────
printf '\n'
if [ "$FAIL" -gt 0 ]; then
  printf '\033[31mFUZZ FAIL — %d/%d assertions failed\033[0m\n' "$FAIL" "$TOTAL"
  printf '\n--- wrangler log tail (5xx errors) ---\n'
  grep -E "ERROR|500" "$LOG" | tail -30
  exit 1
fi
printf '\033[32mFUZZ PASS — %d/%d (no 5xx anywhere)\033[0m\n' "$TOTAL" "$TOTAL"

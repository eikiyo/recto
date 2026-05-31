#!/usr/bin/env bash
# Load harness. Boots wrangler dev, seeds a session, runs k6 scenarios.
#
# Honest caveat: wrangler dev is a local dev server, not a production
# Workers runtime. The numbers we get here are an UPPER BOUND on local
# bottlenecks (Node single-threaded). Production Workers is multi-isolate
# on Cloudflare's edge — it scales harder. Use these results as
# regression detection, not as "we will hit p95 < Xms in prod."

set -euo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$HERE/.."
API="$ROOT/apps/workers/api"
BASE="http://localhost:8787"
PORT=8787
COOKIES="$(mktemp)"
LOG="${WRANGLER_LOG:-/tmp/recto-load-wrangler.log}"
: > "$LOG"
PID=""
SCENARIO="${1:-read}"   # read | write | webhook | all

cleanup() {
  if [ -n "$PID" ]; then kill "$PID" 2>/dev/null || true; wait "$PID" 2>/dev/null || true; fi
  rm -f "$COOKIES"
}
trap cleanup EXIT

step() { printf '\n\033[36m== %s\033[0m\n' "$*"; }
require() { command -v "$1" >/dev/null || { echo "missing: $1" >&2; exit 1; }; }

require k6
require jq
require curl
require lsof

if lsof -i ":$PORT" >/dev/null 2>&1; then
  echo "port $PORT busy. kill the running worker first." >&2
  exit 1
fi

step "Reset + boot worker"
rm -rf "$API/.miniflare"
( cd "$API" && pnpm db:migrate:local >/dev/null 2>&1 )
( cd "$API" && pnpm wrangler dev --local --port "$PORT" --persist-to .miniflare >"$LOG" 2>&1 ) &
PID=$!
for i in $(seq 1 40); do
  if curl -fsS "$BASE/api/health" >/dev/null 2>&1; then break; fi
  sleep 0.5
  if [ "$i" = 40 ]; then tail -40 "$LOG"; exit 1; fi
done
echo "worker pid=$PID up"

step "Seed test user + license"
( cd "$API" && pnpm wrangler d1 execute recto --local --persist-to .miniflare --command \
  "INSERT INTO users (id, email, created_at, digest_opt_in, anchor_credits) VALUES ('load-user','load@example.com', strftime('%s','now')*1000, 1, 100); \
   INSERT INTO licenses (id, user_id, appsumo_code, tier, redeemed_at) VALUES ('load-lic','load-user','LOAD-CODE',3, strftime('%s','now')*1000);" >/dev/null 2>&1 )

step "Authenticate and grab session cookie"
TOK=$(curl -fsS -X POST "$BASE/api/auth/magic" -H 'Content-Type: application/json' \
  -d '{"email":"load@example.com"}' | jq -r '.devToken')
curl -fsS -c "$COOKIES" "$BASE/api/auth/callback?token=$TOK" -o /dev/null
COOKIE_HEADER="$(grep recto_session "$COOKIES" | awk '{print $6"="$7}')"
[ -n "$COOKIE_HEADER" ] || { echo "failed to get cookie" >&2; exit 1; }
echo "cookie header acquired"

step "Connect a site (for write/recrawl scenarios)"
SITE_ID=$(curl -fsS -b "$COOKIES" -X POST "$BASE/api/sites" -H 'Content-Type: application/json' \
  -d '{"url":"https://load.example.com","cms":"wordpress","wp_username":"u","wp_app_password":"a b c d e f"}' | jq -r '.id')
echo "site id=$SITE_ID"

WEBHOOK_SECRET=$(grep '^APPSUMO_WEBHOOK_SECRET=' "$API/.dev.vars" | sed 's/.*="\(.*\)"/\1/')

# Match scenario.
case "$SCENARIO" in
  read)
    step "k6 read-heavy"
    BASE="$BASE" COOKIE_HEADER="$COOKIE_HEADER" k6 run "$ROOT/load/k6-read-heavy.js"
    ;;
  write)
    step "k6 write burst"
    BASE="$BASE" COOKIE_HEADER="$COOKIE_HEADER" SITE_ID="$SITE_ID" k6 run "$ROOT/load/k6-write-burst.js"
    ;;
  webhook)
    step "k6 webhook flood"
    BASE="$BASE" WEBHOOK_SECRET="$WEBHOOK_SECRET" k6 run "$ROOT/load/k6-webhook-flood.js"
    ;;
  all)
    step "k6 read-heavy"
    BASE="$BASE" COOKIE_HEADER="$COOKIE_HEADER" k6 run "$ROOT/load/k6-read-heavy.js"
    step "k6 write burst"
    BASE="$BASE" COOKIE_HEADER="$COOKIE_HEADER" SITE_ID="$SITE_ID" k6 run "$ROOT/load/k6-write-burst.js"
    step "k6 webhook flood"
    BASE="$BASE" WEBHOOK_SECRET="$WEBHOOK_SECRET" k6 run "$ROOT/load/k6-webhook-flood.js"
    ;;
  *)
    echo "Unknown scenario: $SCENARIO (use: read | write | webhook | all)" >&2
    exit 1
    ;;
esac

#!/usr/bin/env bash
# Idempotent Cloudflare deploy. Run after `wrangler login` once on this machine.
#
# What this does (all idempotent — re-runs safely):
#   1. Provision: D1 database, KV namespace, Vectorize index, R2 bucket, 6 queues.
#   2. Patch wrangler.toml with the provisioned IDs (you can commit the result).
#   3. Apply D1 migrations to prod.
#   4. Prompt for 5 secrets if missing (we never echo them).
#   5. Deploy the worker.
#
# Phases are independent; if step N fails, re-run and only steps ≥N execute.

set -euo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$HERE/.."
API="$ROOT/apps/workers/api"
TOML="$API/wrangler.toml"
STATE="$ROOT/.deploy-state.json"   # gitignored — record of what's provisioned

cd "$API"

step()  { printf '\n\033[36m== %s\033[0m\n' "$*"; }
ok()    { printf '\033[32m  ✓\033[0m %s\n' "$*"; }
warn()  { printf '\033[33m  !\033[0m %s\n' "$*"; }
die()   { printf '\033[31m  ✗ %s\033[0m\n' "$*" >&2; exit 1; }

require() { command -v "$1" >/dev/null || die "missing: $1"; }
require pnpm
require jq
require wrangler || true  # we use pnpm wrangler

wr() { pnpm wrangler "$@"; }

# Authoritative login check.
step "Verify wrangler is logged in"
if ! wr whoami 2>/dev/null | grep -q '@'; then
  die "Run \`pnpm --filter @recto/api wrangler login\` first."
fi
ok "logged in as $(wr whoami | grep '@')"

state_get() { [ -f "$STATE" ] && jq -r ".$1 // empty" "$STATE" || true; }
state_set() {
  [ -f "$STATE" ] || echo '{}' > "$STATE"
  tmp=$(mktemp); jq ".$1 = \"$2\"" "$STATE" > "$tmp" && mv "$tmp" "$STATE"
}

# Patch a TOML key inside a block. Crude — works because wrangler.toml has
# stable, single-line `id = "..."` and `database_id = "..."` patterns.
patch_toml() {
  local key="$1" value="$2" sentinel="$3"
  # Replace only within the next block starting from the sentinel.
  perl -i -pe "
    BEGIN { \$state = 0; }
    if (/\\Q$sentinel\\E/) { \$state = 1; }
    if (\$state == 1 && /^\\s*${key}\\s*=/) { s/=\\s*\"[^\"]*\"/= \"$value\"/; \$state = 0; }
  " "$TOML"
}

# ── 1. D1 ───────────────────────────────────────────────────────────────
step "Provision D1 database 'recto'"
DB_ID=$(state_get d1_id)
if [ -z "$DB_ID" ]; then
  EXISTING=$(wr d1 list --json 2>/dev/null | jq -r '.[] | select(.name=="recto") | .uuid' || true)
  if [ -n "$EXISTING" ]; then
    DB_ID="$EXISTING"
    ok "found existing D1 'recto' ($DB_ID)"
  else
    DB_ID=$(wr d1 create recto 2>&1 | grep -oE 'database_id = "[^"]+' | sed 's/database_id = "//' | head -1)
    [ -n "$DB_ID" ] || die "D1 create failed"
    ok "created D1 'recto' ($DB_ID)"
  fi
  state_set d1_id "$DB_ID"
fi
patch_toml database_id "$DB_ID" 'binding = "DB"'
ok "wrangler.toml DB id patched"

# ── 2. KV ───────────────────────────────────────────────────────────────
step "Provision KV namespace 'RECTO_KV'"
KV_ID=$(state_get kv_id)
if [ -z "$KV_ID" ]; then
  KV_ID=$(wr kv namespace create RECTO_KV 2>&1 | grep -oE 'id = "[^"]+' | sed 's/id = "//' | head -1)
  if [ -z "$KV_ID" ]; then
    EXISTING=$(wr kv namespace list --json 2>/dev/null | jq -r '.[] | select(.title|test("RECTO_KV"))| .id' | head -1)
    KV_ID="$EXISTING"
  fi
  [ -n "$KV_ID" ] || die "KV create failed"
  state_set kv_id "$KV_ID"
fi
patch_toml id "$KV_ID" 'binding = "KV"'
ok "KV id=$KV_ID"

# ── 3. Vectorize ────────────────────────────────────────────────────────
step "Provision Vectorize index 'recto-embeddings'"
if ! wr vectorize list 2>/dev/null | grep -q 'recto-embeddings'; then
  wr vectorize create recto-embeddings --dimensions=768 --metric=cosine >/dev/null
  ok "created"
else
  ok "exists"
fi

# ── 4. R2 ───────────────────────────────────────────────────────────────
step "Provision R2 bucket 'recto-archive'"
if ! wr r2 bucket list 2>/dev/null | grep -q 'recto-archive'; then
  wr r2 bucket create recto-archive >/dev/null
  ok "created"
else
  ok "exists"
fi

# ── 5. Queues ───────────────────────────────────────────────────────────
step "Provision queues"
for Q in q-crawl q-embed q-push q-verify q-email q-gsc-backfill; do
  if ! wr queues list 2>/dev/null | grep -q "^$Q\\b"; then
    wr queues create "$Q" >/dev/null
    ok "created $Q"
  else
    ok "exists $Q"
  fi
done

# ── 6. D1 migrations ────────────────────────────────────────────────────
step "Apply D1 migrations (prod)"
wr d1 migrations apply recto --remote
ok "migrations applied"

# ── 7. Secrets ──────────────────────────────────────────────────────────
step "Secrets — set any that are missing"
declare -a NEEDED=("RECTO_KEK" "MAGIC_LINK_SECRET" "APPSUMO_WEBHOOK_SECRET" "GSC_CLIENT_ID" "GSC_CLIENT_SECRET")
EXISTING_SECRETS=$(wr secret list --json 2>/dev/null | jq -r '.[].name' || true)
for SEC in "${NEEDED[@]}"; do
  if echo "$EXISTING_SECRETS" | grep -q "^$SEC\$"; then
    ok "$SEC already set"
  else
    warn "$SEC missing — paste value (input hidden):"
    printf '  > '
    read -rs VAL
    echo
    if [ -z "$VAL" ]; then warn "  empty input, skipping"; continue; fi
    printf '%s' "$VAL" | wr secret put "$SEC"
    ok "$SEC set"
    unset VAL
  fi
done

# ── 8. Deploy worker ────────────────────────────────────────────────────
step "Deploy worker"
wr deploy
ok "worker deployed"

# ── 9. Quick prod sanity ────────────────────────────────────────────────
step "Sanity probe /api/health"
HOST=$(wr deployments list --json 2>/dev/null | jq -r '.[0].route // empty' | head -1)
if [ -n "$HOST" ]; then
  if curl -fsS "https://$HOST/api/health" | jq -e '.status == "ok"' >/dev/null; then
    ok "live health check ok"
  else
    warn "health check did not return ok; check the route binding"
  fi
fi

printf '\n\033[32mDEPLOY COMPLETE\033[0m\n'
printf '\nNext steps (manual):\n'
printf '  1. Add DNS: recto.so (Pages) + api.recto.so (Workers route)\n'
printf '  2. Add MailChannels TXT record: _mailchannels.recto.so → "v=mc1 cfid=<your-cf-account-id>"\n'
printf '  3. Add OAuth redirect URI in Google Cloud Console: https://api.recto.so/api/oauth/gsc/callback\n'
printf '  4. Update AppSumo partner dashboard webhook URL: https://api.recto.so/api/webhooks/appsumo/webhook\n'
printf '  5. Run scripts/smoke.sh against the prod base URL to verify end-to-end.\n'

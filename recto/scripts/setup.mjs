#!/usr/bin/env node
// Location: recto/scripts/setup.mjs
// Purpose: one-command clone-and-go. Installs everything, auto-generates local
//          dev secrets so the app boots with ZERO pasting, creates+migrates the
//          local DB, opens .dev.vars for optional real keys, then launches the
//          full stack (API + UI) on localhost.
// Functions: run(), gen(), seedEnv(), openInEditor(), main()
// Calls: pnpm install / db:migrate:local / dev (db:generate is maintainer-only)
// Imports: node:child_process, node:fs, node:os, node:crypto
import { execSync, spawnSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync, copyFileSync } from 'node:fs';
import { platform } from 'node:os';
import { randomBytes } from 'node:crypto';

const run = (cmd) => { console.log(`\n$ ${cmd}`); execSync(cmd, { stdio: 'inherit' }); };

const ENV_SRC = 'apps/workers/api/.dev.vars.example';
const ENV_DST = 'apps/workers/api/.dev.vars';

// Dev-only secrets we can safely generate so the app boots with no human input.
// (Real GSC/Emailit keys are optional and only needed for those integrations.)
function seedEnv() {
  if (existsSync(ENV_DST)) {
    console.log(`• ${ENV_DST} exists — leaving your values untouched`);
    return;
  }
  let body = readFileSync(ENV_SRC, 'utf8');
  const fill = {
    RECTO_KEK: randomBytes(32).toString('base64'),
    MAGIC_LINK_SECRET: randomBytes(32).toString('hex'),
  };
  for (const [k, v] of Object.entries(fill)) {
    body = body.replace(new RegExp(`^${k}=.*$`, 'm'), `${k}="${v}"`);
  }
  writeFileSync(ENV_DST, body);
  console.log(`✓ created ${ENV_DST} with auto-generated dev secrets (no pasting needed to boot)`);
}

function openInEditor(file) {
  const opener = platform() === 'darwin' ? 'open' : platform() === 'win32' ? 'cmd' : 'xdg-open';
  const args = platform() === 'win32' ? ['/c', 'start', '', file] : [file];
  try { spawnSync(opener, args, { stdio: 'ignore' }); } catch { /* editor optional */ }
}

async function main() {
  console.log('▸ recto setup — one command to a running localhost\n');

  // 1. Secrets FIRST so it pops open while the slow install runs. Auto-filled,
  //    so the app boots even if you never touch it.
  seedEnv();
  openInEditor(ENV_DST);
  console.log(`✎ Opened ${ENV_DST}. Optional: paste real GSC/Emailit keys for those`);
  console.log('  features. The app runs locally without them.\n');

  // 2. Install the whole workspace (API + UI + packages). wrangler ships with it.
  //    NOTE: first run downloads the toolchain — this is the slow step, not boot.
  run('pnpm install');

  // 3. Create + migrate the local D1 database by applying the committed
  //    migrations. Do NOT run db:generate here — the repo ships curated,
  //    incremental migrations (0001+); regenerating from the schema would
  //    fabricate a competing 0000_*.sql and collide ("table already exists").
  //    db:generate is a maintainer step, only when you change schema.ts.
  run('pnpm --filter @recto/api db:migrate:local');

  // 4. Launch both servers. One Ctrl-C stops both.
  console.log('\n▸ Live: API → http://localhost:8787 · UI → http://localhost:8765');
  console.log('  (edit .dev.vars and re-run `pnpm dev` to pick up real keys)\n');
  run('pnpm dev');
}

main().catch((e) => { console.error('\nsetup failed:', e.message); process.exit(1); });

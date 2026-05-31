#!/usr/bin/env node
// Location: recto/scripts/setup.mjs
// Purpose: one-command clone-and-go. Installs deps, creates the local DB,
//          opens the secrets file for the user to paste into, then launches
//          the API + UI together. Zero extra dependencies (Node built-ins only).
// Functions: run(), main()
// Calls: pnpm install / db:generate / db:migrate:local / dev; opens .dev.vars
// Imports: node:child_process, node:fs, node:readline, node:os
import { execSync, spawnSync } from 'node:child_process';
import { existsSync, copyFileSync } from 'node:fs';
import { createInterface } from 'node:readline';
import { platform } from 'node:os';

const run = (cmd) => { console.log(`\n$ ${cmd}`); execSync(cmd, { stdio: 'inherit' }); };

const ENV_SRC = 'apps/workers/api/.dev.vars.example';
const ENV_DST = 'apps/workers/api/.dev.vars';

async function main() {
  console.log('▸ recto setup — install, database, secrets, run (one shot)\n');

  // 1. Install the whole workspace (API + web + packages). wrangler comes with it.
  run('pnpm install');

  // 2. Seed the local secrets file from the template (never overwrite an existing one).
  if (!existsSync(ENV_DST)) {
    copyFileSync(ENV_SRC, ENV_DST);
    console.log(`\n✓ created ${ENV_DST} from the template`);
  } else {
    console.log(`\n• ${ENV_DST} already exists — leaving your values untouched`);
  }

  // 3. Create the local D1 database and apply migrations (no secrets needed yet).
  run('pnpm --filter @recto/api db:generate');
  run('pnpm --filter @recto/api db:migrate:local');

  // 4. Pop the secrets file open in the default editor so the user can paste values.
  const opener = platform() === 'darwin' ? 'open'
    : platform() === 'win32' ? 'cmd'
    : 'xdg-open';
  const args = platform() === 'win32' ? ['/c', 'start', '', ENV_DST] : [ENV_DST];
  try { spawnSync(opener, args, { stdio: 'ignore' }); } catch { /* editor optional */ }
  console.log(`\n✎ Opened ${ENV_DST}. Paste your values and save.`);
  console.log('  For pure local dev the placeholders are enough to boot — fill real');
  console.log('  keys (RECTO_KEK, GSC_*, EMAILIT_API_KEY) only for the features you use.');

  // 5. Wait for the human, then launch both servers.
  await new Promise((resolve) => {
    const rl = createInterface({ input: process.stdin, output: process.stdout });
    rl.question('\n⏎ Press Enter once .dev.vars is saved to launch the app… ', () => {
      rl.close();
      resolve();
    });
  });

  console.log('\n▸ Starting API (:8787) + UI (:8765). Ctrl-C stops both.\n');
  run('pnpm dev');
}

main().catch((e) => { console.error('\nsetup failed:', e.message); process.exit(1); });

import type { Config } from 'drizzle-kit';

export default {
  schema: './src/db/schema.ts',
  out: './src/db/migrations',
  dialect: 'sqlite',
  driver: 'd1-http',
  // Drizzle-Kit only uses these when running drizzle-kit push directly; we don't push to remote D1
  // from local. Migrations are applied via `wrangler d1 migrations apply`.
} satisfies Config;

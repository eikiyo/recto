// Drizzle client bound to D1. Single place to attach the ORM to the binding.
// Schema lives at apps/workers/api/src/db/schema.ts so wrangler can colocate migrations.

import { drizzle } from 'drizzle-orm/d1';
import type { DrizzleD1Database } from 'drizzle-orm/d1';

export function client(db: D1Database): DrizzleD1Database {
  return drizzle(db);
}

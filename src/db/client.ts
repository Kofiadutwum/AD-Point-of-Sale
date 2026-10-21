import 'server-only';
import { mkdirSync } from 'node:fs';
import { PGlite } from '@electric-sql/pglite';
import type { PgDatabase, PgQueryResultHKT } from 'drizzle-orm/pg-core';
import { drizzle as drizzlePglite } from 'drizzle-orm/pglite';
import { migrate as migratePglite } from 'drizzle-orm/pglite/migrator';
import { drizzle as drizzlePostgres } from 'drizzle-orm/postgres-js';
import { migrate as migratePostgres } from 'drizzle-orm/postgres-js/migrator';
import postgres from 'postgres';
import * as schema from './schema';

// common base of the PGlite and postgres.js drivers
export type Db = PgDatabase<PgQueryResultHKT, typeof schema>;
export type Tx = Parameters<Parameters<Db['transaction']>[0]>[0];
export type Driver = 'pglite' | 'postgres';

const MIGRATIONS_FOLDER = './drizzle';
// on globalThis: `next start` loads this module once per bundle (pages, actions, route handlers), and two PGlite
// instances on one folder never see each other's writes
const shared = globalThis as typeof globalThis & { __posDb?: Db };

/** DATABASE_URL → postgres.js (Supabase pooler, so no prepared statements); empty → local PGlite. */
export function getDb(): Db {
  let instance = shared.__posDb;
  if (!instance) {
    const url = process.env.DATABASE_URL;
    if (url) {
      instance = drizzlePostgres(postgres(url, { prepare: false }), { schema }) as unknown as Db;
    } else {
      mkdirSync('.data', { recursive: true });
      instance = drizzlePglite(new PGlite('.data/pglite'), { schema }) as unknown as Db;
    }
    shared.__posDb = instance;
  }
  return instance;
}

export async function runMigrations(db: Db, driver: Driver): Promise<void> {
  const config = { migrationsFolder: MIGRATIONS_FOLDER };
  if (driver === 'pglite') await migratePglite(db as never, config);
  else await migratePostgres(db as never, config);
}

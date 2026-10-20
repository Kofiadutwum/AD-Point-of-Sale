import { PGlite } from '@electric-sql/pglite';
import { drizzle } from 'drizzle-orm/pglite';
import { type Db, runMigrations } from '@/db/client';
import * as schema from '@/db/schema';

// Migrating a fresh PGlite takes seconds; cloning a migrated template takes about half a second.
let template: Promise<PGlite> | undefined;
function migratedTemplate(): Promise<PGlite> {
  template ??= (async () => {
    const client = new PGlite();
    await runMigrations(drizzle(client, { schema }) as unknown as Db, 'pglite');
    return client;
  })();
  return template;
}

/** Fresh in-memory Postgres with all migrations applied. */
export async function createTestDb(): Promise<{ db: Db; close: () => Promise<void> }> {
  const client = (await (await migratedTemplate()).clone()) as PGlite;
  const db = drizzle(client, { schema }) as unknown as Db;
  return { db, close: () => client.close() };
}

/** Awaits a rejection and returns its message plus the driver error underneath (Drizzle wraps query errors). */
export async function dbError(p: Promise<unknown>): Promise<string> {
  try {
    await p;
  } catch (e) {
    const err = e as Error & { cause?: Error };
    return `${err.message} | ${err.cause?.message ?? ''}`;
  }
  throw new Error('expected the database call to fail');
}

/** Rows of a raw tx.execute() result. Tests run on PGlite, whose results carry .rows. */
export function rows<T = Record<string, unknown>>(result: unknown): T[] {
  return (result as { rows: T[] }).rows;
}

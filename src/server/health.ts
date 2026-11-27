import 'server-only';
import { sql } from 'drizzle-orm';
import journal from '../../drizzle/meta/_journal.json';
import type { Db } from '@/db/client';
import { asPlatform } from '@/db/tenant';

export type Health = { ok: boolean; database: 'ok' | 'down'; migrations: { applied: number; expected: number }; at: string };

/** Phase 8: for an uptime monitor. The database answers and every migration in this build has been applied; no secrets or shop data. */
export async function health(db: Db, now: Date): Promise<Health> {
  const expected = journal.entries.length;
  try {
    const applied = await asPlatform(db, async (tx) => {
      const rows = await tx.execute(sql`select count(*)::int as n from drizzle.__drizzle_migrations`) as unknown as Array<{ n: number }> | { rows: Array<{ n: number }> };
      return (Array.isArray(rows) ? rows : rows.rows)[0]?.n ?? 0;
    });
    return { ok: applied >= expected, database: 'ok', migrations: { applied, expected }, at: now.toISOString() };
  } catch {
    return { ok: false, database: 'down', migrations: { applied: 0, expected }, at: now.toISOString() };
  }
}

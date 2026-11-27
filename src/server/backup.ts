import { sql } from 'drizzle-orm';
import type { Db, Tx } from '@/db/client';

// Phase 8 (launch readiness): a logical backup of every table, and a restore into a freshly migrated, empty database.
// The host's point-in-time recovery (e.g. Neon) is the first line; this file is the copy kept elsewhere, and the restore drill.
// A backup holds password hashes and sealed secrets (opened only with MFA_SECRET_KEY): store it encrypted, never in the repository.

export type Backup = { format: 'multishop-pos-backup'; version: 1; takenAt: string; migrations: number; tables: Record<string, unknown[]> };
export type RestoreReport = { tables: number; rows: number };

const q = (name: string) => `"${name.replace(/"/g, '""')}"`;
const lit = (s: string) => `'${s.replace(/'/g, "''")}'`;
const rowsOf = <T>(r: unknown): T[] => (Array.isArray(r) ? r : (r as { rows: T[] }).rows) as T[];
const run = async <T>(tx: Tx, text: string): Promise<T[]> => rowsOf<T>(await tx.execute(sql.raw(text)));

async function tables(tx: Tx): Promise<string[]> {
  return (await run<{ name: string }>(tx, `select table_name as name from information_schema.tables where table_schema = 'public' and table_type = 'BASE TABLE' order by table_name`)).map((r) => r.name);
}

/** Tables ordered so every table comes after the tables its foreign keys point to (a self-reference is ignored). */
export async function dependencyOrder(tx: Tx): Promise<string[]> {
  const names = await tables(tx);
  const edges = await run<{ child: string; parent: string }>(tx, `
    select c.relname as child, p.relname as parent from pg_constraint k
    join pg_class c on c.oid = k.conrelid join pg_class p on p.oid = k.confrelid
    join pg_namespace n on n.oid = c.relnamespace
    where k.contype = 'f' and n.nspname = 'public'`);
  const needs = new Map(names.map((n) => [n, new Set<string>()]));
  for (const e of edges) if (e.child !== e.parent && needs.has(e.child) && needs.has(e.parent)) needs.get(e.child)!.add(e.parent);
  const order: string[] = [];
  const done = new Set<string>();
  while (order.length < names.length) {
    const ready = names.filter((n) => !done.has(n) && [...needs.get(n)!].every((p) => done.has(p)));
    if (!ready.length) throw new Error(`foreign keys form a cycle among: ${names.filter((n) => !done.has(n)).join(', ')}`);
    for (const n of ready) { order.push(n); done.add(n); }
  }
  return order;
}

/** Every public table as JSON rows, in one consistent snapshot (a single read-only transaction). */
export async function takeBackup(db: Db, now: Date): Promise<Backup> {
  return db.transaction(async (tx) => {
    await tx.execute(sql`set transaction isolation level repeatable read read only`);
    const out: Record<string, unknown[]> = {};
    for (const t of await dependencyOrder(tx)) {
      const [r] = await run<{ rows: unknown[] | string }>(tx, `select coalesce(json_agg(t), '[]'::json) as rows from ${q(t)} t`);
      out[t] = typeof r.rows === 'string' ? JSON.parse(r.rows) : r.rows;
    }
    const [m] = await run<{ n: number }>(tx, `select count(*)::int as n from drizzle.__drizzle_migrations`);
    return { format: 'multishop-pos-backup', version: 1, takenAt: now.toISOString(), migrations: m.n, tables: out };
  });
}

/**
 * Restores into a database migrated to the same version that holds no shops yet (it refuses otherwise), in one transaction.
 * Rows the migrations seeded (plans) give way to the backup's. Postgres converts the JSON back to each column's type.
 */
export async function restoreBackup(db: Db, backup: Backup): Promise<RestoreReport> {
  if (backup?.format !== 'multishop-pos-backup' || backup.version !== 1) throw new Error('not a backup file');
  return db.transaction(async (tx) => {
    const [m] = await run<{ n: number }>(tx, `select count(*)::int as n from drizzle.__drizzle_migrations`);
    if (m.n !== backup.migrations) throw new Error(`run the migrations first: this database has ${m.n}, the backup was taken at ${backup.migrations}`);
    const [shops] = await run<{ n: number }>(tx, `select count(*)::int as n from tenants`);
    if (shops.n > 0) throw new Error('this database already holds shops; restore only into an empty database');
    const order = (await dependencyOrder(tx)).filter((t) => t in backup.tables);
    for (const t of [...order].reverse()) await tx.execute(sql.raw(`delete from ${q(t)}`));
    let rows = 0;
    for (const t of order) {
      const data = backup.tables[t];
      if (!data.length) continue;
      const identity = (await run<{ c: string }>(tx, `select column_name as c from information_schema.columns where table_schema = 'public' and table_name = ${lit(t)} and is_identity = 'YES'`)).map((r) => r.c);
      for (let i = 0; i < data.length; i += 500) { // batches keep each statement small
        await tx.execute(sql`${sql.raw(`insert into ${q(t)} ${identity.length ? 'overriding system value ' : ''}select * from json_populate_recordset(null::${q(t)}, `)}${JSON.stringify(data.slice(i, i + 500))}::json) on conflict do nothing`);
      }
      for (const c of identity) await tx.execute(sql.raw(`select setval(pg_get_serial_sequence(${lit(q(t))}, ${lit(c)}), greatest((select max(${q(c)}) from ${q(t)}), 1))`));
      rows += data.length;
    }
    // triggers may add rows during the restore (device cache versions); a table short of its backup count means lost data
    const short: string[] = [];
    for (const t of order) {
      const [c] = await run<{ n: number }>(tx, `select count(*)::int as n from ${q(t)}`);
      if (c.n < backup.tables[t].length) short.push(`${t} ${c.n}/${backup.tables[t].length}`);
    }
    if (short.length) throw new Error(`restore incomplete, nothing was saved: ${short.join(', ')}`);
    return { tables: order.length, rows };
  });
}

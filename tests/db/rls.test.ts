import { getTableName, sql } from 'drizzle-orm';
import { afterEach, beforeEach, expect, it } from 'vitest';
import type { Db } from '@/db/client';
import {
  adminSessions, auditLog, authAttempts, branches, plans, platformAdmins, registers, subscriptions, tenants, users,
} from '@/db/schema';
import { asPlatform, withTenant } from '@/db/tenant';
import { type SeededShop, seedShop } from '../helpers/fixtures';
import { createTestDb, dbError, rows } from '../helpers/test-db';

let db: Db;
let close: () => Promise<void>;
let a: SeededShop;
let b: SeededShop;
beforeEach(async () => {
  ({ db, close } = await createTestDb());
  a = await seedShop(db, { slug: 'shop-a' });
  b = await seedShop(db, { slug: 'shop-b' });
});
afterEach(async () => { await close(); });

it('tenant A sees only its own rows', async () => {
  for (const t of [tenants, subscriptions, branches, registers, users, auditLog]) {
    const seen = await withTenant(db, a.tenantId, (tx) => tx.select().from(t));
    expect(seen, getTableName(t)).toHaveLength(1);
  }
});

it('returns no rows when no tenant is set', async () => {
  const seen = await db.transaction(async (tx) => {
    await tx.execute(sql`set local role pos_app`);
    return tx.select().from(users);
  });
  expect(seen).toEqual([]);
});

it('blocks writing a row for another tenant', async () => {
  expect(await dbError(withTenant(db, a.tenantId, (tx) =>
    tx.insert(branches).values({ tenantId: b.tenantId, name: 'X', branchCode: 'X1' })))).toMatch(/row-level security/);
});

it('audit_log is append-only for pos_app', async () => {
  expect(await dbError(withTenant(db, a.tenantId, (tx) => tx.update(auditLog).set({ action: 'changed' })))).toMatch(/permission denied/);
});

it('pos_app cannot read platform tables', async () => {
  for (const t of [platformAdmins, adminSessions, authAttempts])
    expect(await dbError(withTenant(db, a.tenantId, (tx) => tx.select().from(t)))).toMatch(/permission denied/);
});

it('every table with a tenant_id column has RLS enabled', async () => {
  const found = rows<{ relname: string; relrowsecurity: boolean }>(await asPlatform(db, (tx) => tx.execute(sql`
    select c.relname, c.relrowsecurity from pg_class c
    join pg_namespace n on n.oid = c.relnamespace and n.nspname = 'public'
    join information_schema.columns col on col.table_schema = 'public' and col.table_name = c.relname and col.column_name = 'tenant_id'
    where c.relkind = 'r'`)));
  expect(found.length).toBeGreaterThanOrEqual(8);
  expect(found.filter((r) => !r.relrowsecurity)).toEqual([]);
});

it('seeds the trial and standard plans', async () => {
  const p = await asPlatform(db, (tx) => tx.select().from(plans));
  expect(p.map((x) => x.id).sort()).toEqual(['standard', 'trial']);
  expect(p.find((x) => x.id === 'trial')!.limits).toEqual({ branches: 1, registers: 2, staff: 5, products: 500, sms_per_month: 50 });
});

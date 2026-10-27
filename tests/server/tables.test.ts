import { eq } from 'drizzle-orm';
import { afterEach, beforeEach, expect, it } from 'vitest';
import type { Db } from '@/db/client';
import { tenants } from '@/db/schema';
import { asPlatform } from '@/db/tenant';
import type { Ctx } from '@/server/context';
import { listTables, saveServiceCharge, saveTable } from '@/server/tables';
import { ctxFor, expectAccess, foodShop, type SeededShop } from '../helpers/fixtures';
import { createTestDb } from '../helpers/test-db';

const t0 = new Date('2026-10-27T10:00:00Z');
let db: Db;
let close: () => Promise<void>;
let shop: SeededShop;
let owner: Ctx;
beforeEach(async () => {
  ({ db, close } = await createTestDb());
  shop = await foodShop(db, t0, { users: [{ key: 'owner', email: 'o@x.test', rolePreset: 'owner' }, { key: 'cashier', email: 'c@x.test', rolePreset: 'cashier' }] });
  owner = await ctxFor(db, shop, 'owner', t0);
});
afterEach(async () => { await close(); });

it('adds tables and refuses a duplicate name', async () => {
  const r = await saveTable(db, owner, { branchId: shop.branchId, name: 'Table 1', active: true });
  expect(r).toMatchObject({ ok: true });
  expect(await saveTable(db, owner, { branchId: shop.branchId, name: ' table 1 ', active: true })).toMatchObject({ ok: false, error: 'duplicate_name' });
  expect(await listTables(db, owner, shop.branchId)).toEqual([{ id: (r as { tableId: string }).tableId, name: 'Table 1', status: 'free', active: true, openTicketId: null }]);
});

it('saves a 10% service charge and refuses over 25%', async () => {
  expect(await saveServiceCharge(db, owner, 1000)).toEqual({ ok: true });
  const [s] = await asPlatform(db, (tx) => tx.select({ bp: tenants.serviceChargeBp }).from(tenants).where(eq(tenants.id, shop.tenantId)));
  expect(s.bp).toBe(1000);
  expect(await saveServiceCharge(db, owner, 2600)).toEqual({ ok: false, error: 'invalid_input' });
});

it('a cashier cannot set up tables', async () => {
  await expectAccess(saveTable(db, await ctxFor(db, shop, 'cashier', t0), { branchId: shop.branchId, name: 'Table 9', active: true }), 'forbidden');
});

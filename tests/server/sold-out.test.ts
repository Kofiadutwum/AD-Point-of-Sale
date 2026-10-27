import { eq } from 'drizzle-orm';
import { afterEach, beforeEach, expect, it } from 'vitest';
import type { Db } from '@/db/client';
import { soldOut, tenants } from '@/db/schema';
import { asPlatform, withTenant } from '@/db/tenant';
import { isSoldOut, listSoldOut, markAvailable, markSoldOut } from '@/server/sold-out';
import { ctxFor, productFor, type SeededShop, seedShop, tillCtxFor } from '../helpers/fixtures';
import { createTestDb } from '../helpers/test-db';

const at = (iso: string) => new Date(iso);
let db: Db;
let close: () => Promise<void>;
let shop: SeededShop;
let branchId: string;
let variantId: string;
beforeEach(async () => {
  ({ db, close } = await createTestDb());
  shop = await seedShop(db, { shopType: 'food', users: [
    { key: 'owner', email: 'o@x.test', rolePreset: 'owner' }, { key: 'cashier', email: 'c@x.test', rolePreset: 'cashier', pin: '2468' },
  ] });
  branchId = shop.branchId;
  variantId = (await productFor(db, await ctxFor(db, shop, 'owner', at('2026-10-26T08:00:00Z')), { name: 'Jollof' })).variantId;
});
afterEach(async () => { await close(); });

it('a cashier PIN marks an item sold out for today only', async () => {
  const till = await tillCtxFor(db, shop, 'cashier', at('2026-10-26T12:00:00Z'));
  expect(await markSoldOut(db, till, { branchId, variantId }, at('2026-10-26T12:00:00Z'))).toEqual({ ok: true });
  expect((await listSoldOut(db, till, branchId, at('2026-10-26T18:00:00Z'))).map((r) => r.variantId)).toEqual([variantId]);
  expect(await withTenant(db, shop.tenantId, (tx) => isSoldOut(tx, branchId, [variantId], '2026-10-26'))).toEqual(new Set([variantId]));
});

it('sold out clears on the next business day', async () => {
  const till = await tillCtxFor(db, shop, 'cashier', at('2026-10-26T12:00:00Z'));
  await markSoldOut(db, till, { branchId, variantId }, at('2026-10-26T12:00:00Z'));
  const nextDay = await tillCtxFor(db, shop, 'cashier', at('2026-10-27T08:00:00Z'));
  expect(await listSoldOut(db, nextDay, branchId, at('2026-10-27T08:00:00Z'))).toEqual([]);
});

it('respects the business-day cutoff', async () => {
  await asPlatform(db, (tx) => tx.update(tenants).set({ businessDayCutoff: '03:00' }).where(eq(tenants.id, shop.tenantId)));
  const till = await tillCtxFor(db, shop, 'cashier', at('2026-10-27T01:00:00Z'));
  await markSoldOut(db, till, { branchId, variantId }, at('2026-10-27T01:00:00Z')); // still the 26th
  expect(await listSoldOut(db, till, branchId, at('2026-10-27T02:30:00Z'))).toHaveLength(1);
  expect(await listSoldOut(db, till, branchId, at('2026-10-27T03:30:00Z'))).toEqual([]);
});

it('refuses a branch the user is not assigned to', async () => {
  const other = await seedShop(db, { shopType: 'food' });
  const till = await tillCtxFor(db, shop, 'cashier', at('2026-10-26T12:00:00Z'));
  expect(await markSoldOut(db, till, { branchId: other.branchId, variantId }, at('2026-10-26T12:00:00Z'))).toMatchObject({ ok: false, error: 'not_assigned' });
  expect(await markAvailable(db, till, { branchId: other.branchId, variantId }, at('2026-10-26T12:00:00Z'))).toMatchObject({ ok: false, error: 'not_assigned' });
});

it('marking twice keeps one row; available again removes it', async () => {
  const till = await tillCtxFor(db, shop, 'cashier', at('2026-10-26T12:00:00Z'));
  await markSoldOut(db, till, { branchId, variantId }, at('2026-10-26T12:00:00Z'));
  expect(await markSoldOut(db, till, { branchId, variantId }, at('2026-10-26T12:05:00Z'))).toEqual({ ok: true });
  expect(await asPlatform(db, (tx) => tx.select().from(soldOut))).toHaveLength(1);
  expect(await markAvailable(db, till, { branchId, variantId }, at('2026-10-26T13:00:00Z'))).toEqual({ ok: true });
  expect(await listSoldOut(db, till, branchId, at('2026-10-26T13:00:00Z'))).toEqual([]);
});

it("refuses another shop's item", async () => {
  const other = await seedShop(db, { shopType: 'food' });
  const foreign = (await productFor(db, await ctxFor(db, other, 'owner', at('2026-10-26T08:00:00Z')))).variantId;
  const till = await tillCtxFor(db, shop, 'cashier', at('2026-10-26T12:00:00Z'));
  expect(await markSoldOut(db, till, { branchId, variantId: foreign }, at('2026-10-26T12:00:00Z'))).toMatchObject({ ok: false, error: 'unknown_item' });
});

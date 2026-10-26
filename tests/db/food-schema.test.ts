import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { afterEach, beforeEach, expect, it } from 'vitest';
import type { Db } from '@/db/client';
import { branches, deviceCacheVersions, kitchenOrders, sales, soldOut } from '@/db/schema';
import { asPlatform } from '@/db/tenant';
import { ctxFor, productFor, type SeededShop, seedShop } from '../helpers/fixtures';
import { createTestDb, dbError } from '../helpers/test-db';

const t0 = new Date('2026-10-26T10:00:00Z');
let db: Db;
let close: () => Promise<void>;
let a: SeededShop;
let b: SeededShop;
let variantA: string;
let saleA: string;
let saleOfB: string;
beforeEach(async () => {
  ({ db, close } = await createTestDb());
  a = await seedShop(db, { slug: 'shop-a' });
  b = await seedShop(db, { slug: 'shop-b' });
  variantA = (await productFor(db, await ctxFor(db, a, 'owner', t0))).variantId;
  saleA = await insertSale(a);
  saleOfB = await insertSale(b);
});
afterEach(async () => { await close(); });

async function insertSale(shop: SeededShop): Promise<string> {
  const id = randomUUID();
  await asPlatform(db, (tx) => tx.insert(sales).values({
    id, tenantId: shop.tenantId, branchId: shop.branchId, registerId: shop.registerId, cashierId: shop.users.owner.id,
    receiptNumber: `B1-T1-${String(Math.floor(Math.random() * 1e6)).padStart(6, '0')}`, status: 'completed', taxMode: 'inclusive',
    subtotalPesewas: 500, discountPesewas: 0, taxPesewas: 0, totalPesewas: 500, paidPesewas: 500, changeDuePesewas: 0,
    deviceCreatedAt: t0, receivedAt: t0, businessDate: '2026-10-26', shareCode: randomUUID(),
  }));
  return id;
}

const insertSoldOut = (shop: SeededShop, variantId: string, businessDate: string) => asPlatform(db, (tx) => tx.insert(soldOut).values({
  tenantId: shop.tenantId, branchId: shop.branchId, variantId, businessDate, setBy: shop.users.owner.id, setAt: t0,
}).returning());

const insertKitchenOrder = (shop: SeededShop, extra: { saleId: string }) => asPlatform(db, (tx) => tx.insert(kitchenOrders).values({
  tenantId: shop.tenantId, branchId: shop.branchId, orderNumber: '001', businessDate: '2026-10-26', diningOption: 'eat_in',
  needsPacking: false, sentAt: t0, ...extra,
}).returning());

const cacheVersion = async (tenantId: string) => (await asPlatform(db, (tx) => tx.select().from(deviceCacheVersions)
  .where(eq(deviceCacheVersions.tenantId, tenantId))))[0]?.version ?? 0;

it('refuses a service mode that does not exist', async () => {
  expect(await dbError(asPlatform(db, (tx) => tx.update(branches).set({ serviceModes: ['counter', 'drive_thru'] })))).toMatch(/branches_service_modes/);
});

it('one sold-out row per branch, item, and day', async () => {
  await insertSoldOut(a, variantA, '2026-10-26');
  expect(await dbError(insertSoldOut(a, variantA, '2026-10-26'))).toMatch(/sold_out_pk|duplicate key/);
  await expect(insertSoldOut(a, variantA, '2026-10-27')).resolves.toBeDefined();
});

it("a kitchen order cannot point at another shop's sale", async () => {
  expect(await dbError(insertKitchenOrder(a, { saleId: saleOfB }))).toMatch(/foreign key/);
});

it('a sale has at most one kitchen order', async () => {
  await insertKitchenOrder(a, { saleId: saleA });
  expect(await dbError(insertKitchenOrder(a, { saleId: saleA }))).toMatch(/kitchen_orders_sale/);
});

it('marking an item sold out bumps the device cache version', async () => {
  const before = await cacheVersion(a.tenantId);
  await insertSoldOut(a, variantA, '2026-10-26');
  expect(await cacheVersion(a.tenantId)).toBeGreaterThan(before);
});

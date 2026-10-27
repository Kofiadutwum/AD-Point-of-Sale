import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Db } from '@/db/client';
import { branches, comboChoices, comboSlots, deviceCacheVersions, kitchenOrders, payments, potRecords, sales, salesChannels, soldOut, variants, wastageEntries } from '@/db/schema';
import { asPlatform, withTenant } from '@/db/tenant';
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

describe('menu', () => {
  const insertSlot = (min: number, max: number) => asPlatform(db, (tx) => tx.insert(comboSlots).values({
    tenantId: a.tenantId, comboVariantId: variantA, name: 'Drink', minChoices: min, maxChoices: max, sortOrder: 0,
  }).returning().then((r) => r[0]));

  it('a sell-by-amount variant needs a minimum', async () => {
    expect(await dbError(asPlatform(db, (tx) => tx.update(variants).set({ sellByAmount: true }).where(eq(variants.id, variantA))))).toMatch(/variants_by_amount/);
    await asPlatform(db, (tx) => tx.update(variants).set({ sellByAmount: true, minAmountPesewas: 500 }).where(eq(variants.id, variantA)));
  });

  it('a combo cannot be sold by amount', async () => {
    expect(await dbError(asPlatform(db, (tx) => tx.update(variants).set({ kind: 'combo', sellByAmount: true, minAmountPesewas: 500 }).where(eq(variants.id, variantA)))))
      .toMatch(/variants_by_amount/);
  });

  it('a slot needs max at least 1 and min not above max', async () => {
    expect(await dbError(insertSlot(2, 1))).toMatch(/combo_slots_choices/);
    expect(await dbError(insertSlot(0, 0))).toMatch(/combo_slots_choices/);
    await expect(insertSlot(0, 2)).resolves.toBeDefined();
  });

  it('a choice appears once per slot', async () => {
    const slot = await insertSlot(1, 1);
    const add = () => asPlatform(db, (tx) => tx.insert(comboChoices).values({ tenantId: a.tenantId, slotId: slot.id, variantId: variantA }));
    await add();
    expect(await dbError(add())).toMatch(/combo_choices_slot_variant/);
  });

  it('a leftover cannot exceed the pots cooked', async () => {
    expect(await dbError(asPlatform(db, (tx) => tx.insert(potRecords).values({
      tenantId: a.tenantId, branchId: a.branchId, variantId: variantA, businessDate: '2026-10-26', cooked: '1.000', leftover: '2.000',
    })))).toMatch(/pot_records_leftover/);
  });

  it('wastage entries are append-only for pos_app', async () => {
    await asPlatform(db, (tx) => tx.insert(wastageEntries).values({
      tenantId: a.tenantId, branchId: a.branchId, variantId: variantA, businessDate: '2026-10-26', quantity: '1.000', reason: 'spoiled', costPesewas: 100, userId: a.users.owner.id,
    }));
    expect(await dbError(withTenant(db, a.tenantId, (tx) => tx.update(wastageEntries).set({ costPesewas: 0 })))).toMatch(/permission denied/);
  });

  it('changing a combo slot bumps the device cache version', async () => {
    const before = await cacheVersion(a.tenantId);
    await insertSlot(0, 1);
    expect(await cacheVersion(a.tenantId)).toBeGreaterThan(before);
  });
});

describe('channels', () => {
  const insertChannel = (shop: SeededShop, extra: Partial<typeof salesChannels.$inferInsert> = {}) => asPlatform(db, (tx) => tx.insert(salesChannels).values({
    tenantId: shop.tenantId, name: `Bolt ${randomUUID().slice(0, 4)}`, kind: 'delivery_app', commissionBp: 2000, collectedBy: 'app', ...extra,
  }).returning().then((r) => r[0]));
  const setOrder = (saleId: string, channelId: string, externalOrderId: string) => asPlatform(db, (tx) => tx.update(sales)
    .set({ channelId, externalOrderId }).where(eq(sales.id, saleId)));

  it('a platform order ID is unique per channel', async () => {
    const bolt = await insertChannel(a);
    await setOrder(saleA, bolt.id, 'BOLT-1');
    const second = await insertSale(a);
    expect(await dbError(setOrder(second, bolt.id, 'BOLT-1'))).toMatch(/sales_channel_order/);
  });

  it('the same order ID on two channels is allowed at the database', async () => {
    const bolt = await insertChannel(a);
    const chow = await insertChannel(a, { name: 'Chowdeck' });
    await setOrder(saleA, bolt.id, 'X-9');
    await expect(setOrder(await insertSale(a), chow.id, 'X-9')).resolves.toBeDefined();
  });

  it('a phone channel cannot be collected by the app', async () => {
    expect(await dbError(insertChannel(a, { name: 'Phone', kind: 'phone', collectedBy: 'app' }))).toMatch(/sales_channels_collected_by/);
  });

  it('a paid kitchen order needs its sale; an unpaid one needs its lines', async () => {
    const base = { tenantId: a.tenantId, branchId: a.branchId, orderNumber: '001', businessDate: '2026-10-26', diningOption: 'takeaway' as const, needsPacking: true, sentAt: t0 };
    expect(await dbError(asPlatform(db, (tx) => tx.insert(kitchenOrders).values({ ...base, saleId: null })))).toMatch(/kitchen_orders_paid/);
    expect(await dbError(asPlatform(db, (tx) => tx.insert(kitchenOrders).values({ ...base, saleId: null, payOnCollect: true })))).toMatch(/kitchen_orders_pending_lines/);
    await expect(asPlatform(db, (tx) => tx.insert(kitchenOrders).values({ ...base, saleId: null, payOnCollect: true, pendingLines: [] }))).resolves.toBeDefined();
  });

  it('channel_settlement needs a reference', async () => {
    expect(await dbError(asPlatform(db, (tx) => tx.insert(payments).values({ id: randomUUID(), tenantId: a.tenantId, saleId: saleA, method: 'channel_settlement', amountPesewas: 500 }))))
      .toMatch(/payments_reference/);
  });
});

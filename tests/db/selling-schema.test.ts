import { randomUUID } from 'node:crypto';
import { afterEach, beforeEach, expect, it } from 'vitest';
import type { Db } from '@/db/client';
import { customers, payments, saleLines, sales, stockMovements, storeCreditEntries } from '@/db/schema';
import { asPlatform, withTenant } from '@/db/tenant';
import { ctxFor, productFor, type SeededShop, seedShop } from '../helpers/fixtures';
import { createTestDb, dbError } from '../helpers/test-db';

const t0 = new Date('2026-10-20T10:00:00Z');
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

const insertSale = (shop: SeededShop, extra: Partial<typeof sales.$inferInsert> = {}) => asPlatform(db, (tx) => tx.insert(sales).values({
  id: randomUUID(), tenantId: shop.tenantId, branchId: shop.branchId, registerId: shop.registerId, cashierId: shop.users.owner.id,
  receiptNumber: `B1-T1-${String(Math.floor(Math.random() * 1e6)).padStart(6, '0')}`, status: 'pending', taxMode: 'inclusive',
  subtotalPesewas: 500, discountPesewas: 0, taxPesewas: 0, totalPesewas: 500, paidPesewas: 500, changeDuePesewas: 0,
  deviceCreatedAt: t0, receivedAt: t0, businessDate: '2026-10-20', shareCode: randomUUID(), ...extra,
}).returning().then((r) => r[0]));

const insertLine = (shop: SeededShop, saleId: string, variantId: string) => asPlatform(db, (tx) => tx.insert(saleLines).values({
  tenantId: shop.tenantId, saleId, lineNo: 1, variantId, unitId: randomUUID(), name: 'x', unitName: 'piece', quantity: '1', baseQuantity: '1',
  unitPricePesewas: 500, currentPricePesewas: 500, discountPesewas: 0, grossPesewas: 500, taxRateBp: 0, taxPesewas: 0, totalPesewas: 500,
}));

const insertPayment = (shop: SeededShop, saleId: string, extra: Partial<typeof payments.$inferInsert> = {}) => asPlatform(db, (tx) =>
  tx.insert(payments).values({ id: randomUUID(), tenantId: shop.tenantId, saleId, method: 'cash', amountPesewas: 500, ...extra }));

it('composite keys stop a sale line or payment pointing at another shop', async () => {
  const saleA = await insertSale(a);
  const ownerB = await ctxFor(db, b, 'owner', t0);
  const variantOfB = (await productFor(db, ownerB)).variantId;
  expect(await dbError(insertLine(a, saleA.id, variantOfB))).toMatch(/foreign key/);
  expect(await dbError(insertPayment(b, saleA.id))).toMatch(/foreign key/);
});

it('receipt numbers are unique per shop but may repeat across shops', async () => {
  await insertSale(a, { receiptNumber: 'B1-T1-000001' });
  expect(await dbError(insertSale(a, { receiptNumber: 'B1-T1-000001' }))).toMatch(/sales_receipt_number/);
  await expect(insertSale(b, { receiptNumber: 'B1-T1-000001' })).resolves.toBeDefined();
});

it('store credit cannot go below zero', async () => {
  await asPlatform(db, (tx) => tx.insert(customers).values({ tenantId: a.tenantId, name: 'Esi', phone: '233241234567' }));
  expect(await dbError(asPlatform(db, (tx) => tx.update(customers).set({ storeCreditPesewas: -1 })))).toMatch(/customers_store_credit/);
});

it('non-cash payments need a reference', async () => {
  const saleA = await insertSale(a);
  expect(await dbError(insertPayment(a, saleA.id, { method: 'momo_manual', reference: null }))).toMatch(/payments_reference/);
});

it('stock movements and store credit entries are append-only for pos_app', async () => {
  expect(await dbError(withTenant(db, a.tenantId, (tx) => tx.update(stockMovements).set({ quantity: '1' })))).toMatch(/permission denied/);
  expect(await dbError(withTenant(db, a.tenantId, (tx) => tx.delete(storeCreditEntries)))).toMatch(/permission denied/);
});

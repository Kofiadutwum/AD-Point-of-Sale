import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { afterEach, beforeEach, expect, it } from 'vitest';
import type { Db } from '@/db/client';
import { auditLog, serials, stockBatches, stockMovements } from '@/db/schema';
import { asPlatform, withTenant } from '@/db/tenant';
import type { Ctx } from '@/server/context';
import { deductStockForLine, stockOnHand } from '@/server/stock';
import { addComponent } from '@/server/variants';
import { ctxFor, productFor, type SeededShop, seedShop, stockFor } from '../helpers/fixtures';
import { createTestDb } from '../helpers/test-db';

const t0 = new Date('2026-10-20T10:00:00Z');
const earlier = new Date('2026-09-01T10:00:00Z');
let db: Db;
let close: () => Promise<void>;
let shop: SeededShop;
let owner: Ctx;
beforeEach(async () => {
  ({ db, close } = await createTestDb());
  shop = await seedShop(db);
  owner = await ctxFor(db, shop, 'owner', t0);
});
afterEach(async () => { await close(); });

const deduct = (variantId: string, baseQty: string, serialList: string[] = []) => withTenant(db, shop.tenantId, (tx) => deductStockForLine(tx, {
  tenantId: shop.tenantId, branchId: shop.branchId, saleId: randomUUID(), saleLineId: randomUUID(), userId: shop.users.owner.id, today: '2026-10-20',
}, { variantId, baseQty, serials: serialList }));
const onHand = (variantId: string) => withTenant(db, shop.tenantId, (tx) => stockOnHand(tx, shop.branchId, variantId));
const batchStock = async (variantId: string) => Object.fromEntries((await asPlatform(db, (tx) => tx.select().from(stockBatches)
  .where(eq(stockBatches.variantId, variantId)))).map((b) => [b.batchNumber, b.onHand]));
const fresh = { negative: false, onlyExpired: false, serialsMissing: false };

it('selling one strip of 10 tablets reduces stock by 10 tablets', async () => {
  const p = await productFor(db, owner, { baseUnit: 'tablet' });
  await stockFor(db, owner, shop.branchId, { variantId: p.variantId, unitId: p.baseUnitId, quantity: '30', totalCostPesewas: 3000 }, t0);
  expect(await deduct(p.variantId, '10.000')).toEqual(fresh);
  expect(await onHand(p.variantId)).toBe('20.000');
  expect((await asPlatform(db, (tx) => tx.select().from(stockMovements).where(eq(stockMovements.type, 'sale'))))[0]).toMatchObject({ quantity: '-10.000', referenceType: 'sale' });
});

it('selling a recipe reduces each ingredient by the recipe amount', async () => {
  const rice = await productFor(db, owner, { baseUnit: 'kg', allowsFractions: true, variants: [{ sku: 'RICE', basePricePesewas: 1200, costPesewas: 1000 }] });
  const oil = await productFor(db, owner, { baseUnit: 'litre', allowsFractions: true, variants: [{ sku: 'OIL', basePricePesewas: 3000, costPesewas: 2500 }] });
  const jollof = await productFor(db, owner, { kind: 'recipe', variants: [{ sku: 'JOLLOF', basePricePesewas: 3500, costPesewas: 0 }] });
  await addComponent(db, owner, jollof.variantId, { code: 'RICE', quantity: '0.25' });
  await addComponent(db, owner, jollof.variantId, { code: 'OIL', quantity: '0.05' });
  await stockFor(db, owner, shop.branchId, { variantId: rice.variantId, unitId: rice.baseUnitId, quantity: '10', totalCostPesewas: 10000 }, t0);
  expect(await deduct(jollof.variantId, '2.000')).toEqual({ ...fresh, negative: true }); // oil had none
  expect(await onHand(rice.variantId)).toBe('9.500');
  expect(await onHand(oil.variantId)).toBe('-0.100');
  expect(await onHand(jollof.variantId)).toBe('0.000');
  expect(await asPlatform(db, (tx) => tx.select().from(stockMovements).where(eq(stockMovements.variantId, jollof.variantId)))).toEqual([]);
});

it('takes the earliest-expiring batch first and splits across batches', async () => {
  const p = await productFor(db, owner, { tracking: 'batch' });
  const line = { variantId: p.variantId, unitId: p.baseUnitId, totalCostPesewas: 0 };
  await stockFor(db, owner, shop.branchId, { ...line, quantity: '3', batchNumber: 'L1', expiryDate: '2026-12-01' }, t0);
  await stockFor(db, owner, shop.branchId, { ...line, quantity: '2', batchNumber: 'L2', expiryDate: '2026-11-15' }, t0);
  expect(await deduct(p.variantId, '4.000')).toEqual(fresh);
  expect(await batchStock(p.variantId)).toEqual({ L1: '1.000', L2: '0.000' });
  expect(await asPlatform(db, (tx) => tx.select().from(stockMovements).where(eq(stockMovements.type, 'sale')))).toHaveLength(2);
});

it('skips expired batches, including one that expires today', async () => {
  const p = await productFor(db, owner, { tracking: 'batch' });
  const line = { variantId: p.variantId, unitId: p.baseUnitId, totalCostPesewas: 0 };
  await stockFor(db, owner, shop.branchId, { ...line, quantity: '5', batchNumber: 'L0', expiryDate: '2026-10-20' }, earlier);
  await stockFor(db, owner, shop.branchId, { ...line, quantity: '5', batchNumber: 'L1', expiryDate: '2027-01-01' }, t0);
  expect(await deduct(p.variantId, '2.000')).toEqual(fresh);
  expect(await batchStock(p.variantId)).toEqual({ L0: '5.000', L1: '3.000' });
});

it('reports only-expired stock and records the sale without a batch', async () => {
  const p = await productFor(db, owner, { tracking: 'batch' });
  await stockFor(db, owner, shop.branchId, { variantId: p.variantId, unitId: p.baseUnitId, totalCostPesewas: 0, quantity: '5', batchNumber: 'L0', expiryDate: '2026-10-20' }, earlier);
  expect(await deduct(p.variantId, '1.000')).toEqual({ ...fresh, onlyExpired: true });
  expect(await onHand(p.variantId)).toBe('4.000');
  expect(await batchStock(p.variantId)).toEqual({ L0: '5.000' });
  expect((await asPlatform(db, (tx) => tx.select().from(stockMovements).where(eq(stockMovements.type, 'sale'))))[0].batchId).toBeNull();
});

it('a serial number can be sold only once', async () => {
  const p = await productFor(db, owner, { tracking: 'serial' });
  await stockFor(db, owner, shop.branchId, { variantId: p.variantId, unitId: p.baseUnitId, quantity: '2', totalCostPesewas: 0, serials: ['IMEI1', 'IMEI2'] }, t0);
  expect(await deduct(p.variantId, '1.000', ['IMEI1'])).toEqual(fresh);
  expect((await asPlatform(db, (tx) => tx.select().from(serials).where(eq(serials.serial, 'IMEI1'))))[0].status).toBe('sold');
  expect(await deduct(p.variantId, '1.000', ['IMEI1'])).toEqual({ ...fresh, serialsMissing: true });
  expect(await onHand(p.variantId)).toBe('0.000');
});

it('records a negative balance with one audit row', async () => {
  const p = await productFor(db, owner);
  expect(await deduct(p.variantId, '1.000')).toEqual({ ...fresh, negative: true });
  expect(await onHand(p.variantId)).toBe('-1.000');
  expect(await asPlatform(db, (tx) => tx.select().from(auditLog).where(eq(auditLog.action, 'negative_stock')))).toHaveLength(1);
});

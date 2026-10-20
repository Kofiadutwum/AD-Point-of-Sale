import { eq } from 'drizzle-orm';
import { afterEach, beforeEach, expect, it } from 'vitest';
import type { Db } from '@/db/client';
import { stockMovements, variants } from '@/db/schema';
import { asPlatform, withTenant } from '@/db/tenant';
import type { Ctx } from '@/server/context';
import { updateProduct } from '@/server/products';
import { type ReceiveLine, receiveStock, stockOnHand } from '@/server/stock';
import { addUnit, updateUnit, updateVariant } from '@/server/variants';
import { ctxFor, expectAccess, productFor, type SeededShop, seedShop, stockFor, tillCtxFor } from '../helpers/fixtures';
import { createTestDb } from '../helpers/test-db';

const t0 = new Date('2026-10-20T10:00:00Z');
let db: Db;
let close: () => Promise<void>;
let shop: SeededShop;
let owner: Ctx;
beforeEach(async () => {
  ({ db, close } = await createTestDb());
  shop = await seedShop(db, { users: [
    { key: 'owner', email: 'o@a.test', password: 'correct-horse-1', rolePreset: 'owner' },
    { key: 'cashier', phone: '0200000001', pin: '1234', rolePreset: 'cashier' },
  ] });
  owner = await ctxFor(db, shop, 'owner', t0);
});
afterEach(async () => { await close(); });

const receipt = (line: ReceiveLine) => ({ branchId: shop.branchId, kind: 'received' as const, lines: [line] });
const onHand = (variantId: string) => withTenant(db, shop.tenantId, (tx) => stockOnHand(tx, shop.branchId, variantId));
const cost = async (variantId: string) => (await asPlatform(db, (tx) => tx.select().from(variants).where(eq(variants.id, variantId))))[0].averageCost;
const piece = (p: { variantId: string; baseUnitId: string }, quantity: string, totalCostPesewas: number): ReceiveLine =>
  ({ variantId: p.variantId, unitId: p.baseUnitId, quantity, totalCostPesewas });

it('receiving one carton of 24 adds 24 pieces and records the movement', async () => {
  const p = await productFor(db, owner);
  const { unitId } = await addUnit(db, owner, p.variantId, { name: 'carton', factor: '24', pricePesewas: null, sellable: true, purchasable: true }) as { unitId: string };
  expect(await receiveStock(db, owner, receipt({ variantId: p.variantId, unitId, quantity: '1', totalCostPesewas: 9600 }), t0)).toMatchObject({ ok: true });
  expect(await onHand(p.variantId)).toBe('24.000');
  const moves = await asPlatform(db, (tx) => tx.select().from(stockMovements));
  expect(moves).toMatchObject([{ type: 'received', quantity: '24.000', unitCost: '400.0000', referenceType: 'stock_receipt' }]);
});

it('weighted average cost is correct after receiving at a new cost', async () => {
  const p = await productFor(db, owner); // cost 400, no stock
  await stockFor(db, owner, shop.branchId, piece(p, '10', 4000), t0);
  expect(await cost(p.variantId)).toBe('400.0000');
  await stockFor(db, owner, shop.branchId, piece(p, '10', 6000), t0);
  expect(await cost(p.variantId)).toBe('500.0000');
  const q = await productFor(db, owner);
  await stockFor(db, owner, shop.branchId, piece(q, '10', 4000), t0);
  await stockFor(db, owner, shop.branchId, piece(q, '10', 5000), t0);
  expect(await cost(q.variantId)).toBe('450.0000');
});

it('records opening stock as its own kind', async () => {
  const p = await productFor(db, owner);
  expect(await receiveStock(db, owner, { branchId: shop.branchId, kind: 'opening_stock', lines: [piece(p, '5', 2000)] }, t0)).toMatchObject({ ok: true });
  expect((await asPlatform(db, (tx) => tx.select().from(stockMovements)))[0].type).toBe('opening_stock');
});

it('needs a batch number and expiry for batch items, and refuses stock that expires today', async () => {
  const p = await productFor(db, owner, { tracking: 'batch' });
  const batchLine = piece(p, '5', 500);
  expect(await receiveStock(db, owner, receipt({ ...batchLine, expiryDate: '2027-01-31' }), t0)).toMatchObject({ ok: false, error: 'batch_required', detail: '0' });
  expect(await receiveStock(db, owner, receipt({ ...batchLine, batchNumber: 'L1', expiryDate: '2026-10-20' }), t0)).toMatchObject({ ok: false, error: 'expired_batch' });
  expect(await receiveStock(db, owner, receipt({ ...batchLine, batchNumber: 'L1', expiryDate: '2027-01-31' }), t0)).toMatchObject({ ok: true });
  expect(await receiveStock(db, owner, receipt({ ...batchLine, batchNumber: 'L1', expiryDate: '2027-02-28' }), t0)).toMatchObject({ ok: false, error: 'batch_expiry_mismatch' });
  expect(await receiveStock(db, owner, receipt({ ...batchLine, batchNumber: 'L1', expiryDate: '2027-01-31' }), t0)).toMatchObject({ ok: true });
  expect(await onHand(p.variantId)).toBe('10.000');
});

it('needs one new serial per unit for serial items', async () => {
  const p = await productFor(db, owner, { tracking: 'serial' });
  const serialLine = piece(p, '2', 200000);
  expect(await receiveStock(db, owner, receipt({ ...serialLine, serials: ['IMEI1'] }), t0)).toMatchObject({ ok: false, error: 'serials_mismatch' });
  expect(await receiveStock(db, owner, receipt({ ...serialLine, serials: ['IMEI1', 'IMEI1'] }), t0)).toMatchObject({ ok: false, error: 'duplicate_serial' });
  expect(await receiveStock(db, owner, receipt({ ...serialLine, serials: ['IMEI1', 'IMEI2'] }), t0)).toMatchObject({ ok: true });
  expect(await receiveStock(db, owner, receipt({ ...piece(p, '1', 100000), serials: ['IMEI2'] }), t0)).toMatchObject({ ok: false, error: 'duplicate_serial' });
  expect(await asPlatform(db, (tx) => tx.select().from(stockMovements))).toHaveLength(2);
});

it("refuses bundles, units that cannot be bought, and another shop's branch or item", async () => {
  const bundle = await productFor(db, owner, { kind: 'bundle' });
  expect(await receiveStock(db, owner, receipt(piece(bundle, '1', 0)), t0)).toMatchObject({ ok: false, error: 'not_stocked' });
  const p = await productFor(db, owner);
  const { unitId } = await addUnit(db, owner, p.variantId, { name: 'strip', factor: '10', pricePesewas: null, sellable: true, purchasable: false }) as { unitId: string };
  expect(await receiveStock(db, owner, receipt({ variantId: p.variantId, unitId, quantity: '1', totalCostPesewas: 0 }), t0)).toMatchObject({ ok: false, error: 'not_purchasable' });
  expect(await receiveStock(db, owner, receipt(piece(p, '0.5', 0)), t0)).toMatchObject({ ok: false, error: 'invalid_quantity' });
  const b = await seedShop(db, { slug: 'shop-b' });
  const ownerB = await ctxFor(db, b, 'owner', t0);
  const pb = await productFor(db, ownerB);
  expect(await receiveStock(db, owner, receipt(piece(pb, '1', 0)), t0)).toMatchObject({ ok: false, error: 'unknown_item' });
  expect(await receiveStock(db, owner, { ...receipt(piece(p, '1', 0)), branchId: b.branchId }, t0)).toEqual({ ok: false, error: 'unknown_branch' });
});

it('needs the receive_stock permission', async () => {
  const p = await productFor(db, owner);
  const cashier = await tillCtxFor(db, shop, 'cashier', t0);
  await expectAccess(receiveStock(db, cashier, receipt(piece(p, '1', 0)), t0), 'forbidden');
});

it('blocks changing tracking, fractions, or a unit factor once the item has stock', async () => {
  const p = await productFor(db, owner, { name: 'Soap' });
  const { unitId } = await addUnit(db, owner, p.variantId, { name: 'carton', factor: '24', pricePesewas: null, sellable: true, purchasable: true }) as { unitId: string };
  await stockFor(db, owner, shop.branchId, piece(p, '1', 400), t0);
  expect(await updateProduct(db, owner, p.productId, { name: 'Soap', tracking: 'batch' })).toEqual({ ok: false, error: 'in_use' });
  expect(await updateProduct(db, owner, p.productId, { name: 'Bar soap', tracking: 'none' })).toEqual({ ok: true });
  const fields = { name: '', sku: null, basePricePesewas: 500, costPesewas: null, reorderLevel: null, sellable: true };
  expect(await updateVariant(db, owner, p.variantId, { ...fields, allowsFractions: true })).toEqual({ ok: false, error: 'in_use' });
  expect(await updateVariant(db, owner, p.variantId, { ...fields, basePricePesewas: 550, allowsFractions: false })).toEqual({ ok: true });
  const unit = { name: 'carton', pricePesewas: null, sellable: true, purchasable: true };
  expect(await updateUnit(db, owner, unitId, { ...unit, factor: '12' })).toEqual({ ok: false, error: 'in_use' });
  expect(await updateUnit(db, owner, unitId, { ...unit, name: 'box', factor: '24' })).toEqual({ ok: true });
});

import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { afterEach, beforeEach, expect, it } from 'vitest';
import type { Db } from '@/db/client';
import { customers, returnLines, returns, stockBatches, tenants } from '@/db/schema';
import { asPlatform, withTenant } from '@/db/tenant';
import { requestApproval } from '@/server/approvals';
import type { Ctx } from '@/server/context';
import { addCustomer } from '@/server/customers';
import { findReturnableSale, processReturn, quoteReturn } from '@/server/returns';
import { completeSale, type SaleInput } from '@/server/sales';
import { addComponent } from '@/server/variants';
import { stockOnHand } from '@/server/stock';
import { ctxFor, productFor, saleInput, type SeededShop, seedShop, stockFor, tillCtxFor } from '../helpers/fixtures';
import { createTestDb } from '../helpers/test-db';

const t0 = new Date('2026-11-26T10:00:00Z');
let db: Db;
let close: () => Promise<void>;
let shop: SeededShop;
let owner: Ctx;
let cashier: Ctx;
let p: { productId: string; variantId: string; baseUnitId: string };
beforeEach(async () => {
  ({ db, close } = await createTestDb());
  shop = await seedShop(db, { users: [
    { key: 'owner', email: 'o@r.test', password: 'correct-horse-1', rolePreset: 'owner' },
    { key: 'manager', phone: '0200000009', pin: '4321', rolePreset: 'manager' },
    { key: 'cashier', phone: '0200000001', pin: '1234', rolePreset: 'cashier' },
  ] });
  owner = await ctxFor(db, shop, 'owner', t0);
  cashier = await tillCtxFor(db, shop, 'cashier', t0);
  p = await productFor(db, owner); // GHS 5.00 a piece, no tax
  await stockFor(db, owner, shop.branchId, { variantId: p.variantId, unitId: p.baseUnitId, quantity: '10', totalCostPesewas: 4000 }, t0);
});
afterEach(async () => { await close(); });

type Item = { variantId: string; baseUnitId: string };
const line = (item: Item, quantity: string, unitPricePesewas: number, extra: Partial<SaleInput['lines'][number]> = {}) =>
  ({ variantId: item.variantId, unitId: item.baseUnitId, quantity, unitPricePesewas, discountPesewas: 0, ...extra });
const sell = async (lines: SaleInput['lines'], extra: Partial<SaleInput> = {}, seller = cashier) => {
  const input = saleInput({ lines, ...extra });
  const r = await completeSale(db, seller, input, t0);
  if (!r.ok) throw new Error(`sale refused: ${r.error}`);
  const found = await findReturnableSale(db, owner, input.receiptNumber);
  if (!found) throw new Error('sale not found');
  return found;
};
const onHand = (variantId = p.variantId) => withTenant(db, shop.tenantId, (tx) => stockOnHand(tx, shop.branchId, variantId));
const setLimit = (pesewas: number) => asPlatform(db, (tx) => tx.update(tenants).set({ refundLimitPesewas: pesewas }).where(eq(tenants.id, shop.tenantId)));
const back = (saleId: string, saleLineId: string, quantity: string, extra: Partial<Parameters<typeof processReturn>[2]> = {}, ctx = owner) =>
  processReturn(db, ctx, { saleId, items: [{ saleLineId, quantity, condition: 'saleable' }], reason: 'changed mind', refundMethod: 'cash', ...extra }, t0);

it('refunds part of a line by its share of the line total', async () => {
  const sale = await sell([line(p, '3', 500, { discountPesewas: 100 })], {}, await tillCtxFor(db, shop, 'manager', t0)); // line total 1400
  expect(sale.lines[0]).toMatchObject({ sold: '3.000', returned: '0.000', returnable: '3.000' });
  expect(await back(sale.saleId, sale.lines[0].saleLineId, '1')).toEqual({ ok: true, returnId: expect.any(String), refundPesewas: 467 });
  expect(await back(sale.saleId, sale.lines[0].saleLineId, '2')).toEqual({ ok: true, returnId: expect.any(String), refundPesewas: 933 }); // the rest, exactly
  expect(await onHand()).toBe('10.000');
  const again = await findReturnableSale(db, owner, sale.receiptNumber);
  expect(again?.lines[0]).toMatchObject({ returned: '3.000', returnable: '0.000' });
});

it('saleable items go back on hand, into their batch', async () => {
  const med = await productFor(db, owner, { tracking: 'batch' });
  const recv = { variantId: med.variantId, unitId: med.baseUnitId, totalCostPesewas: 0 };
  await stockFor(db, owner, shop.branchId, { ...recv, quantity: '3', batchNumber: 'L1', expiryDate: '2027-06-01' }, t0);
  await stockFor(db, owner, shop.branchId, { ...recv, quantity: '2', batchNumber: 'L2', expiryDate: '2027-01-01' }, t0);
  const sale = await sell([line(med, '4', 500)]); // takes L2 (2) then L1 (2)
  expect(await back(sale.saleId, sale.lines[0].saleLineId, '3')).toMatchObject({ ok: true, refundPesewas: 1500 });
  const batches = await asPlatform(db, (tx) => tx.select().from(stockBatches).where(eq(stockBatches.variantId, med.variantId)));
  expect(Object.fromEntries(batches.map((b) => [b.batchNumber, b.onHand]))).toEqual({ L1: '2.000', L2: '2.000' });
  expect(await onHand(med.variantId)).toBe('4.000');
});

it('damaged items do not go back on hand', async () => {
  const sale = await sell([line(p, '2', 500)]);
  const r = await processReturn(db, owner, {
    saleId: sale.saleId, items: [{ saleLineId: sale.lines[0].saleLineId, quantity: '1', condition: 'damaged' }], reason: 'broken', refundMethod: 'cash',
  }, t0);
  expect(r).toMatchObject({ ok: true, refundPesewas: 500 });
  expect(await onHand()).toBe('8.000');
  expect(await asPlatform(db, (tx) => tx.select().from(returnLines))).toMatchObject([{ condition: 'damaged', quantity: '1.000', baseQuantity: '1.000' }]);
});

it('two returns at once never exceed what was sold', async () => {
  const sale = await sell([line(p, '2', 500)]);
  const results = await Promise.all([back(sale.saleId, sale.lines[0].saleLineId, '2'), back(sale.saleId, sale.lines[0].saleLineId, '2')]);
  expect(results.filter((r) => r.ok)).toHaveLength(1);
  expect(results.filter((r) => !r.ok)).toEqual([{ ok: false, error: 'too_many' }]);
  expect(await onHand()).toBe('10.000');
});

it('a refund by another method needs approval', async () => {
  await setLimit(100000);
  const sale = await sell([line(p, '1', 500)]);
  const items = [{ saleLineId: sale.lines[0].saleLineId, quantity: '1', condition: 'saleable' as const }];
  const quote = await quoteReturn(db, cashier, { saleId: sale.saleId, items, refundMethod: 'momo_manual' });
  expect(quote).toEqual({ ok: true, refundPesewas: 500, approval: { action: 'refund_other_method', contextKey: `${sale.saleId}:500` } });
  const momo = { refundMethod: 'momo_manual' as const, reference: 'MOMO-1' };
  expect(await back(sale.saleId, sale.lines[0].saleLineId, '1', momo, cashier)).toEqual({ ok: false, error: 'approval_required' });
  expect(await back(sale.saleId, sale.lines[0].saleLineId, '1', { refundMethod: 'momo_manual' }, owner)).toEqual({ ok: false, error: 'reference_required' });
  const a = await requestApproval(db, cashier, { action: 'refund_other_method', contextKey: `${sale.saleId}:500`, approverId: shop.users.manager.id, pin: '4321' }, t0);
  const r = await back(sale.saleId, sale.lines[0].saleLineId, '1', { ...momo, approvalToken: (a as { token: string }).token }, cashier);
  expect(r).toMatchObject({ ok: true, refundPesewas: 500 });
  expect(await asPlatform(db, (tx) => tx.select().from(returns))).toMatchObject([{ approvedBy: shop.users.manager.id, refundMethod: 'momo_manual', reference: 'MOMO-1' }]);
});

it('a refund over the limit needs approval', async () => {
  await setLimit(1000);
  const sale = await sell([line(p, '3', 500)]);
  const id = sale.lines[0].saleLineId;
  expect(await back(sale.saleId, id, '2', {}, cashier)).toMatchObject({ ok: true, refundPesewas: 1000 }); // at the limit
  const big = await sell([line(p, '3', 500)]);
  expect(await quoteReturn(db, cashier, { saleId: big.saleId, items: [{ saleLineId: big.lines[0].saleLineId, quantity: '3', condition: 'saleable' }], refundMethod: 'cash' }))
    .toEqual({ ok: true, refundPesewas: 1500, approval: { action: 'refund', contextKey: `${big.saleId}:1500` } });
  expect(await back(big.saleId, big.lines[0].saleLineId, '3', {}, cashier)).toEqual({ ok: false, error: 'approval_required' });
  expect(await back(big.saleId, big.lines[0].saleLineId, '3', {}, owner)).toMatchObject({ ok: true }); // owners refund freely
});

it("store credit goes to the sale's customer", async () => {
  const c = await addCustomer(db, owner, { name: 'Ama', phone: '0244000001' });
  const customerId = (c as { customerId: string }).customerId;
  const sale = await sell([line(p, '2', 500)], { customerId });
  expect(await back(sale.saleId, sale.lines[0].saleLineId, '1', { refundMethod: 'store_credit' })).toMatchObject({ ok: true, refundPesewas: 500 });
  const [row] = await asPlatform(db, (tx) => tx.select().from(customers).where(eq(customers.id, customerId)));
  expect(row.storeCreditPesewas).toBe(500);
  const anonymous = await sell([line(p, '1', 500)]);
  expect(await back(anonymous.saleId, anonymous.lines[0].saleLineId, '1', { refundMethod: 'store_credit' })).toEqual({ ok: false, error: 'needs_customer' });
});

it('bundles and serial items are not returnable yet', async () => {
  const phone = await productFor(db, owner, { tracking: 'serial', variants: [{ basePricePesewas: 100000, costPesewas: 80000 }] });
  await stockFor(db, owner, shop.branchId, { variantId: phone.variantId, unitId: phone.baseUnitId, quantity: '1', totalCostPesewas: 80000, serials: ['IMEI1'] }, t0);
  const meal = await productFor(db, owner, { kind: 'recipe', variants: [{ basePricePesewas: 3500, costPesewas: 0 }] });
  await productFor(db, owner, { variants: [{ sku: 'RICE-R', basePricePesewas: 100, costPesewas: 50 }] });
  await addComponent(db, owner, meal.variantId, { code: 'RICE-R', quantity: '1' });
  const sale = await sell([line(phone, '1', 100000, { serials: ['IMEI1'] }), line(meal, '1', 3500)], { tenders: [{ id: randomUUID(), method: 'cash', amountPesewas: 103500 }] });
  expect(sale.lines.map((l) => l.returnable)).toEqual(['0.000', '0.000']);
  for (const l of sale.lines) expect(await back(sale.saleId, l.saleLineId, '1')).toEqual({ ok: false, error: 'not_returnable' });
  expect(await back(sale.saleId, randomUUID(), '1')).toEqual({ ok: false, error: 'not_found' });
});

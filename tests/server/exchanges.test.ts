import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { afterEach, beforeEach, expect, it } from 'vitest';
import type { Db } from '@/db/client';
import { payments, returns, sales } from '@/db/schema';
import { asPlatform, withTenant } from '@/db/tenant';
import { requestApproval } from '@/server/approvals';
import type { Ctx } from '@/server/context';
import { findReturnableSale, processExchange, quoteExchange } from '@/server/returns';
import { completeSale, type SaleInput } from '@/server/sales';
import { stockOnHand } from '@/server/stock';
import { ctxFor, productFor, saleInput, type SeededShop, seedShop, stockFor, tillCtxFor } from '../helpers/fixtures';
import { createTestDb } from '../helpers/test-db';

const t0 = new Date('2026-11-26T10:00:00Z');
let db: Db;
let close: () => Promise<void>;
let shop: SeededShop;
let owner: Ctx;
let cashier: Ctx;
type Item = { variantId: string; baseUnitId: string };
let p: Item; // GHS 5.00
let q: Item; // GHS 8.00
let r: Item; // GHS 3.00
beforeEach(async () => {
  ({ db, close } = await createTestDb());
  shop = await seedShop(db, { users: [
    { key: 'owner', email: 'o@x.test', password: 'correct-horse-1', rolePreset: 'owner' },
    { key: 'manager', phone: '0200000009', pin: '4321', rolePreset: 'manager' },
    { key: 'cashier', phone: '0200000001', pin: '1234', rolePreset: 'cashier' },
  ] });
  owner = await ctxFor(db, shop, 'owner', t0);
  cashier = await tillCtxFor(db, shop, 'cashier', t0);
  p = await productFor(db, owner);
  q = await productFor(db, owner, { variants: [{ basePricePesewas: 800, costPesewas: 400 }] });
  r = await productFor(db, owner, { variants: [{ basePricePesewas: 300, costPesewas: 100 }] });
  for (const item of [p, q, r]) await stockFor(db, owner, shop.branchId, { variantId: item.variantId, unitId: item.baseUnitId, quantity: '5', totalCostPesewas: 500 }, t0);
});
afterEach(async () => { await close(); });

const line = (item: Item, quantity: string, unitPricePesewas: number): SaleInput['lines'][number] =>
  ({ variantId: item.variantId, unitId: item.baseUnitId, quantity, unitPricePesewas, discountPesewas: 0 });
const cash = (amountPesewas: number) => ({ id: randomUUID(), method: 'cash' as const, amountPesewas });
const sell = async (lines: SaleInput['lines']) => {
  const input = saleInput({ lines });
  const done = await completeSale(db, cashier, input, t0);
  if (!done.ok) throw new Error(done.error);
  return (await findReturnableSale(db, owner, input.receiptNumber))!;
};
const onHand = (item: Item) => withTenant(db, shop.tenantId, (tx) => stockOnHand(tx, shop.branchId, item.variantId));
const swap = (sale: { saleId: string; lines: Array<{ saleLineId: string }> }, quantity: string, newItem: Item, newQty: string) => ({
  saleId: sale.saleId, items: [{ saleLineId: sale.lines[0].saleLineId, quantity, condition: 'saleable' as const }], reason: 'wrong size',
  newLines: [{ variantId: newItem.variantId, unitId: newItem.baseUnitId, quantity: newQty }],
});

it('customer pays only the difference', async () => {
  const sale = await sell([line(p, '1', 500)]);
  expect(await quoteExchange(db, cashier, swap(sale, '1', q, '1'), t0)).toEqual({
    ok: true, returnPesewas: 500, newTotalPesewas: 800, creditPesewas: 500, toPayPesewas: 300, cashToPayPesewas: 300, refundPesewas: 0, approval: null,
  });
  const done = await processExchange(db, cashier, { ...swap(sale, '1', q, '1'), tenders: [cash(300)] }, t0);
  expect(done).toMatchObject({ ok: true, changeDuePesewas: 0, refundPesewas: 0 });
  const saleId = (done as { saleId: string }).saleId;
  const paid = await asPlatform(db, (tx) => tx.select().from(payments).where(eq(payments.saleId, saleId)));
  expect(paid.map((x) => [x.method, x.amountPesewas]).sort()).toEqual([['cash', 300], ['exchange_credit', 500]]);
  expect(await asPlatform(db, (tx) => tx.select().from(returns))).toMatchObject([{ exchangeSaleId: saleId, exchangeCreditPesewas: 500, refundMethod: 'exchange', refundPesewas: 500 }]);
  expect([await onHand(p), await onHand(q)]).toEqual(['5.000', '4.000']);
});

it('leftover credit is refunded and may need approval', async () => {
  const sale = await sell([line(p, '2', 500)]); // 10.00 back, 3.00 out: 7.00 left over
  const input = { ...swap(sale, '2', r, '1'), tenders: [], refundMethod: 'cash' as const };
  expect(await quoteExchange(db, cashier, input, t0)).toMatchObject({ ok: true, creditPesewas: 300, refundPesewas: 700, approval: { action: 'refund', contextKey: `${sale.saleId}:700` } });
  expect(await processExchange(db, cashier, input, t0)).toEqual({ ok: false, error: 'approval_required' });
  expect(await asPlatform(db, (tx) => tx.select().from(sales))).toHaveLength(1); // nothing kept
  const a = await requestApproval(db, cashier, { action: 'refund', contextKey: `${sale.saleId}:700`, approverId: shop.users.manager.id, pin: '4321' }, t0);
  const done = await processExchange(db, cashier, { ...input, approvalToken: (a as { token: string }).token }, t0);
  expect(done).toMatchObject({ ok: true, refundPesewas: 700 });
  expect(await asPlatform(db, (tx) => tx.select().from(returns))).toMatchObject([{ refundMethod: 'cash', approvedBy: shop.users.manager.id, exchangeCreditPesewas: 300 }]);
});

it('exchange is all or nothing', async () => {
  const sale = await sell([line(p, '1', 500)]);
  expect(await processExchange(db, cashier, { ...swap(sale, '1', q, '1'), tenders: [cash(100)] }, t0)).toEqual({ ok: false, error: 'payment_incomplete' });
  expect(await asPlatform(db, (tx) => tx.select().from(returns))).toEqual([]);
  expect(await asPlatform(db, (tx) => tx.select().from(sales))).toHaveLength(1);
  expect([await onHand(p), await onHand(q)]).toEqual(['4.000', '5.000']);
});

it('returned stock comes back before the new items go out', async () => {
  const sale = await sell([line(p, '5', 500)]); // none left
  expect(await onHand(p)).toBe('0.000');
  const done = await processExchange(db, cashier, { ...swap(sale, '1', p, '1'), tenders: [] }, t0); // same item, another one
  expect(done).toMatchObject({ ok: true });
  expect(await onHand(p)).toBe('0.000');
});

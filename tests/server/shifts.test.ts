import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { afterEach, beforeEach, expect, it } from 'vitest';
import type { Db } from '@/db/client';
import { sales, tenants } from '@/db/schema';
import { asPlatform } from '@/db/tenant';
import { requestApproval } from '@/server/approvals';
import type { Ctx } from '@/server/context';
import { findReturnableSale, processReturn } from '@/server/returns';
import { completeSale, type SaleInput } from '@/server/sales';
import { cashMovement, closeShift, currentShift, openShift, varianceKey } from '@/server/shifts';
import { ctxFor, productFor, saleInput, type SeededShop, seedShop, stockFor, tillCtxFor } from '../helpers/fixtures';
import { createTestDb } from '../helpers/test-db';

const t0 = new Date('2026-11-26T08:00:00Z');
let db: Db;
let close: () => Promise<void>;
let shop: SeededShop;
let owner: Ctx;
let manager: Ctx;
let cashier: Ctx;
let p: { variantId: string; baseUnitId: string };
beforeEach(async () => {
  ({ db, close } = await createTestDb());
  shop = await seedShop(db, { users: [
    { key: 'owner', email: 'o@s.test', password: 'correct-horse-1', rolePreset: 'owner' },
    { key: 'manager', phone: '0200000009', pin: '4321', rolePreset: 'manager' },
    { key: 'cashier', phone: '0200000001', pin: '1234', rolePreset: 'cashier' },
  ] });
  owner = await ctxFor(db, shop, 'owner', t0);
  manager = await tillCtxFor(db, shop, 'manager', t0);
  cashier = await tillCtxFor(db, shop, 'cashier', t0);
  p = await productFor(db, owner); // GHS 5.00
  await stockFor(db, owner, shop.branchId, { variantId: p.variantId, unitId: p.baseUnitId, quantity: '20', totalCostPesewas: 8000 }, t0);
});
afterEach(async () => { await close(); });

const line = (quantity: string): SaleInput['lines'][number] => ({ variantId: p.variantId, unitId: p.baseUnitId, quantity, unitPricePesewas: 500, discountPesewas: 0 });
const pay = (method: 'cash' | 'momo_manual', amountPesewas: number) => ({ id: randomUUID(), method, amountPesewas, ...(method === 'cash' ? {} : { reference: 'M1' }) });

it('one open shift per till', async () => {
  expect(await openShift(db, cashier, { openingCashPesewas: 10000 }, t0)).toEqual({ ok: true, shiftId: expect.any(String) });
  expect(await openShift(db, manager, { openingCashPesewas: 0 }, t0)).toEqual({ ok: false, error: 'shift_already_open' }); // same till
  expect(await openShift(db, owner, { openingCashPesewas: 0 }, t0)).toEqual({ ok: false, error: 'no_register' });
});

it('expected cash counts sales, change, paid in and out, and cash refunds', async () => {
  await openShift(db, cashier, { openingCashPesewas: 10000 }, t0);
  const cashSale = saleInput({ lines: [line('2')], tenders: [pay('cash', 2000)] }); // 10.00 paid with 20.00: 10.00 change
  expect(await completeSale(db, cashier, cashSale, t0)).toMatchObject({ ok: true, changeDuePesewas: 1000 });
  expect(await completeSale(db, cashier, saleInput({ lines: [line('1')], tenders: [pay('momo_manual', 500)] }), t0)).toMatchObject({ ok: true }); // not cash
  expect(await cashMovement(db, manager, { type: 'paid_in', amountPesewas: 500, reason: 'more change' }, t0)).toEqual({ ok: true });
  expect(await cashMovement(db, manager, { type: 'paid_out', amountPesewas: 300, reason: 'water for the shop' }, t0)).toEqual({ ok: true });
  expect(await cashMovement(db, cashier, { type: 'paid_out', amountPesewas: 300, reason: 'x' }, t0).catch(() => 'refused')).toBe('refused'); // no manage_cash
  await asPlatform(db, (tx) => tx.update(tenants).set({ refundLimitPesewas: 100000 }).where(eq(tenants.id, shop.tenantId))); // a PIN session cannot refund freely
  const sale = (await findReturnableSale(db, owner, cashSale.receiptNumber))!;
  expect(await processReturn(db, manager, { saleId: sale.saleId, items: [{ saleLineId: sale.lines[0].saleLineId, quantity: '1', condition: 'saleable' }], reason: 'x', refundMethod: 'cash' }, t0))
    .toEqual({ ok: true, returnId: expect.any(String), refundPesewas: 500 });
  expect(await currentShift(db, cashier)).toMatchObject({
    openingCashPesewas: 10000, cashTakenPesewas: 2000, changeGivenPesewas: 1000, paidInPesewas: 500, paidOutPesewas: 300, cashRefundsPesewas: 500,
    expectedCashPesewas: 10700, sales: 2,
  });
});

it('a variance above the limit needs a reason and approval', async () => {
  await openShift(db, cashier, { openingCashPesewas: 10000 }, t0);
  const shiftId = (await currentShift(db, cashier))!.shiftId;
  expect(await closeShift(db, cashier, { countedCashPesewas: 9900 }, t0)).toEqual({ ok: false, error: 'reason_required' });
  expect(await closeShift(db, cashier, { countedCashPesewas: 9900, reason: 'gave wrong change' }, t0)).toEqual({ ok: false, error: 'approval_required' });
  const a = await requestApproval(db, cashier, { action: 'cash_variance', contextKey: varianceKey(shiftId, -100), approverId: shop.users.manager.id, pin: '4321' }, t0);
  const closed = await closeShift(db, cashier, { countedCashPesewas: 9900, reason: 'gave wrong change', approvalToken: (a as { token: string }).token }, t0);
  expect(closed).toMatchObject({ ok: true, variancePesewas: -100, summary: { expectedCashPesewas: 10000 } });
  expect(await currentShift(db, cashier)).toBeNull();
  await openShift(db, manager, { openingCashPesewas: 5000 }, t0);
  expect(await closeShift(db, manager, { countedCashPesewas: 5000 }, t0)).toMatchObject({ ok: true, variancePesewas: 0 }); // nothing to explain
});

it('sales need an open shift when the shop requires it', async () => {
  await asPlatform(db, (tx) => tx.update(tenants).set({ requireShifts: true }).where(eq(tenants.id, shop.tenantId)));
  expect(await completeSale(db, cashier, saleInput({ lines: [line('1')], tenders: [pay('cash', 500)] }), t0)).toEqual({ ok: false, error: 'no_open_shift' });
  expect(await completeSale(db, cashier, saleInput({ lines: [line('1')], tenders: [pay('cash', 500)], fromOfflineOutbox: true }), t0)).toMatchObject({ ok: true });
  const { shiftId } = await openShift(db, cashier, { openingCashPesewas: 0 }, t0) as { shiftId: string };
  expect(await completeSale(db, cashier, saleInput({ lines: [line('1')], tenders: [pay('cash', 500)] }), t0)).toMatchObject({ ok: true });
  const rows = await asPlatform(db, (tx) => tx.select({ shiftId: sales.shiftId, needsReview: sales.needsReview, reasons: sales.reviewReasons }).from(sales));
  expect(rows).toEqual(expect.arrayContaining([
    { shiftId: null, needsReview: true, reasons: ['no_open_shift'] },
    { shiftId, needsReview: false, reasons: [] },
  ]));
});

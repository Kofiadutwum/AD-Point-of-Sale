import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { afterEach, beforeEach, expect, it } from 'vitest';
import type { Db } from '@/db/client';
import { customerLedger, sales, tenants } from '@/db/schema';
import { asPlatform } from '@/db/tenant';
import { requestApproval } from '@/server/approvals';
import type { Ctx } from '@/server/context';
import { adjustBalance, customerAccount, listDebtors, recordDebtPayment, saveCreditTerms } from '@/server/customer-accounts';
import { addCustomer } from '@/server/customers';
import { findReturnableSale, processReturn } from '@/server/returns';
import { completeSale, type SaleInput } from '@/server/sales';
import { currentShift, openShift } from '@/server/shifts';
import { ctxFor, productFor, saleInput, type SeededShop, seedShop, stockFor, tillCtxFor } from '../helpers/fixtures';
import { createTestDb } from '../helpers/test-db';

const t0 = new Date('2026-11-26T09:00:00Z');
let db: Db;
let close: () => Promise<void>;
let shop: SeededShop;
let owner: Ctx;
let manager: Ctx;
let cashier: Ctx;
let ama: string;
let p: { variantId: string; baseUnitId: string };
beforeEach(async () => {
  ({ db, close } = await createTestDb());
  shop = await seedShop(db, { users: [
    { key: 'owner', email: 'o@c.test', password: 'correct-horse-1', rolePreset: 'owner' },
    { key: 'manager', phone: '0200000009', pin: '4321', rolePreset: 'manager' },
    { key: 'supervisor', phone: '0200000008', pin: '8888', rolePreset: 'manager' },
    { key: 'cashier', phone: '0200000001', pin: '1234', rolePreset: 'cashier' },
  ] });
  owner = await ctxFor(db, shop, 'owner', t0);
  manager = await tillCtxFor(db, shop, 'manager', t0);
  cashier = await tillCtxFor(db, shop, 'cashier', t0);
  p = await productFor(db, owner); // GHS 5.00
  await stockFor(db, owner, shop.branchId, { variantId: p.variantId, unitId: p.baseUnitId, quantity: '50', totalCostPesewas: 20000 }, t0);
  ama = ((await addCustomer(db, owner, { name: 'Ama', phone: '0244000001' })) as { customerId: string }).customerId;
  expect(await saveCreditTerms(db, owner, { customerId: ama, creditLimitPesewas: 2000, reminderConsent: true })).toEqual({ ok: true });
});
afterEach(async () => { await close(); });

const line = (quantity: string): SaleInput['lines'][number] => ({ variantId: p.variantId, unitId: p.baseUnitId, quantity, unitPricePesewas: 500, discountPesewas: 0 });
const onCredit = (quantity: string, extra: Partial<SaleInput> = {}) =>
  saleInput({ lines: [line(quantity)], tenders: [{ id: randomUUID(), method: 'credit', amountPesewas: 500 * Number(quantity) }], customerId: ama, deviceCreatedAt: t0.toISOString(), ...extra });
const balance = async (id = ama) => (await customerAccount(db, owner, id))!.balancePesewas;

it('a credit sale adds to the balance; it needs the permission and a customer', async () => {
  expect(await completeSale(db, manager, onCredit('2'), t0)).toMatchObject({ ok: true, changeDuePesewas: 0 });
  expect(await balance()).toBe(1000);
  expect((await customerAccount(db, owner, ama))!.ledger).toMatchObject([{ type: 'sale', amountPesewas: 1000, balanceAfterPesewas: 1000 }]);
  expect(await completeSale(db, cashier, onCredit('1'), t0)).toEqual({ ok: false, error: 'credit_not_allowed' });
  expect(await completeSale(db, manager, onCredit('1', { customerId: undefined }), t0)).toEqual({ ok: false, error: 'credit_needs_customer' });
});

it('over the limit needs a manager', async () => {
  await completeSale(db, manager, onCredit('2'), t0); // owes 10.00 of 20.00
  const big = onCredit('3'); // 15.00 more
  expect(await completeSale(db, manager, big, t0)).toEqual({ ok: false, error: 'credit_over_limit' });
  const a = await requestApproval(db, manager, { action: 'credit_over_limit', contextKey: `${big.saleId}:1500`, approverId: shop.users.supervisor.id, pin: '8888' }, t0);
  expect(await completeSale(db, manager, { ...big, creditApprovalToken: (a as { token: string }).token }, t0)).toMatchObject({ ok: true });
  expect(await balance()).toBe(2500);
});

it('an offline credit sale is kept for review', async () => {
  expect(await completeSale(db, manager, onCredit('1', { fromOfflineOutbox: true }), t0)).toMatchObject({ ok: true });
  const [row] = await asPlatform(db, (tx) => tx.select().from(sales));
  expect(row.reviewReasons).toContain('credit_offline');
  expect(await balance()).toBe(500);
});

it('a return on a credit sale reduces the balance', async () => {
  await asPlatform(db, (tx) => tx.update(tenants).set({ refundLimitPesewas: 100000 }).where(eq(tenants.id, shop.tenantId)));
  const sale = onCredit('2');
  await completeSale(db, manager, sale, t0);
  const found = (await findReturnableSale(db, owner, sale.receiptNumber))!;
  const back = (method: 'credit' | 'cash', quantity = '1') => processReturn(db, manager, { saleId: found.saleId, items: [{ saleLineId: found.lines[0].saleLineId, quantity, condition: 'saleable' }], reason: 'x', refundMethod: method }, t0);
  expect(await back('credit')).toMatchObject({ ok: true, refundPesewas: 500 });
  expect(await balance()).toBe(500);
  expect((await customerAccount(db, owner, ama))!.ledger.find((e) => e.type === 'return')).toMatchObject({ amountPesewas: -500, balanceAfterPesewas: 500 });
  await recordDebtPayment(db, cashier, { customerId: ama, amountPesewas: 500, method: 'cash' }, t0); // paid off
  expect(await back('credit')).toEqual({ ok: false, error: 'credit_refund_exceeds_balance' });
  const cashSale = saleInput({ lines: [line('1')], tenders: [{ id: randomUUID(), method: 'cash', amountPesewas: 500 }], customerId: ama });
  await completeSale(db, manager, cashSale, t0);
  const cs = (await findReturnableSale(db, owner, cashSale.receiptNumber))!;
  expect(await processReturn(db, manager, { saleId: cs.saleId, items: [{ saleLineId: cs.lines[0].saleLineId, quantity: '1', condition: 'saleable' }], reason: 'x', refundMethod: 'credit' }, t0))
    .toEqual({ ok: false, error: 'not_credit_sale' });
});

it('part payments reduce the balance and cannot exceed it; cash at a till counts in the shift', async () => {
  await completeSale(db, manager, onCredit('2'), t0);
  await openShift(db, cashier, { openingCashPesewas: 0 }, t0);
  expect(await recordDebtPayment(db, cashier, { customerId: ama, amountPesewas: 300, method: 'cash' }, t0)).toEqual({ ok: true, balancePesewas: 700, customerName: 'Ama' });
  expect(await recordDebtPayment(db, cashier, { customerId: ama, amountPesewas: 800, method: 'cash' }, t0)).toEqual({ ok: false, error: 'invalid_amount' });
  expect(await recordDebtPayment(db, cashier, { customerId: ama, amountPesewas: 100, method: 'momo_manual' }, t0)).toEqual({ ok: false, error: 'reference_required' });
  expect(await currentShift(db, cashier)).toMatchObject({ debtPaymentsPesewas: 300, expectedCashPesewas: 300 });
});

it('adjustments need a reason and a manager', async () => {
  await completeSale(db, manager, onCredit('2'), t0);
  expect(await adjustBalance(db, owner, { customerId: ama, amountPesewas: -100, reason: ' ' }, t0)).toEqual({ ok: false, error: 'reason_required' });
  expect(await adjustBalance(db, owner, { customerId: ama, amountPesewas: -100, reason: 'agreed discount on old debt' }, t0)).toEqual({ ok: true, balancePesewas: 900 });
  expect(await adjustBalance(db, owner, { customerId: ama, amountPesewas: -5000, reason: 'too much' }, t0)).toEqual({ ok: false, error: 'invalid_amount' });
  await expect(adjustBalance(db, cashier, { customerId: ama, amountPesewas: -100, reason: 'x' }, t0)).rejects.toThrow();
  const rows = await asPlatform(db, (tx) => tx.select().from(customerLedger).where(eq(customerLedger.type, 'adjustment')));
  expect(rows).toMatchObject([{ amountPesewas: -100, approvedBy: shop.users.owner.id, reason: 'agreed discount on old debt' }]);
});

it('debtors are listed oldest debt first', async () => {
  const kofi = ((await addCustomer(db, owner, { name: 'Kofi', phone: '0244000002' })) as { customerId: string }).customerId;
  await saveCreditTerms(db, owner, { customerId: kofi, creditLimitPesewas: 5000, reminderConsent: false });
  const later = new Date(t0.getTime() + 86_400_000);
  await completeSale(db, manager, onCredit('1'), later); // Ama owes from tomorrow
  await completeSale(db, manager, onCredit('1', { customerId: kofi }), t0); // Kofi owes from today
  await completeSale(db, manager, onCredit('1', { customerId: kofi }), later);
  expect((await listDebtors(db, owner)).map((d) => [d.name, d.balancePesewas])).toEqual([['Kofi', 1000], ['Ama', 500]]);
  await recordDebtPayment(db, cashier, { customerId: kofi, amountPesewas: 500, method: 'cash' }, later); // settles Kofi's oldest
  expect((await listDebtors(db, owner)).find((d) => d.name === 'Kofi')!.oldestUnpaidAt).toEqual(later);
});

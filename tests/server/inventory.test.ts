import { eq } from 'drizzle-orm';
import { afterEach, beforeEach, expect, it } from 'vitest';
import type { Db } from '@/db/client';
import { branches, stockBalances, variants } from '@/db/schema';
import { asPlatform } from '@/db/tenant';
import { code128Values, PATTERNS } from '@/lib/code128';
import type { Ctx } from '@/server/context';
import { adjustStock, finishCount, getTransfer, inventoryValuation, lowStock, receiveTransfer, recordCount, sendTransfer, startCount } from '@/server/inventory';
import {
  createPurchaseOrder, getPurchaseOrder, listBills, markPurchaseOrderSent, payBill, receivePurchaseOrder, returnToSupplier, saveSupplier, setSupplierItem, suggestPurchaseOrders,
} from '@/server/purchasing';
import { ctxFor, expectAccess, productFor, type SeededShop, seedShop, stockFor, tillCtxFor } from '../helpers/fixtures';
import { createTestDb } from '../helpers/test-db';

const t0 = new Date('2026-11-26T09:00:00Z');
let db: Db;
let close: () => Promise<void>;
let shop: SeededShop;
let owner: Ctx;
let p: { variantId: string; baseUnitId: string };
let supplierId: string;
beforeEach(async () => {
  ({ db, close } = await createTestDb());
  shop = await seedShop(db, { users: [
    { key: 'owner', email: 'o@inv.test', password: 'correct-horse-1', rolePreset: 'owner' },
    { key: 'cashier', phone: '0200000001', pin: '1234', rolePreset: 'cashier' },
  ] });
  owner = await ctxFor(db, shop, 'owner', t0);
  p = await productFor(db, owner); // GHS 5.00, cost 4.00
  await stockFor(db, owner, shop.branchId, { variantId: p.variantId, unitId: p.baseUnitId, quantity: '10', totalCostPesewas: 4000 }, t0);
  supplierId = ((await saveSupplier(db, owner, { name: 'Kumasi Wholesale', phone: '0244000100', paymentTermsDays: 30, leadTimeDays: 5 })) as { supplierId: string }).supplierId;
});
afterEach(async () => { await close(); });

const onHand = async (branchId = shop.branchId) => (await asPlatform(db, (tx) => tx.select().from(stockBalances).where(eq(stockBalances.branchId, branchId)))).find((b) => b.variantId === p.variantId)?.onHand;

it('purchase order: send, receive in parts, bill, pay, return to supplier, pay with credit', async () => {
  expect(await saveSupplier(db, owner, { name: 'kumasi wholesale', paymentTermsDays: 0, leadTimeDays: 0 })).toEqual({ ok: false, error: 'duplicate_name' });
  const po = await createPurchaseOrder(db, owner, { branchId: shop.branchId, supplierId, lines: [{ variantId: p.variantId, unitId: p.baseUnitId, quantity: '10', unitCostPesewas: 400 }] }) as { purchaseOrderId: string; number: string };
  expect(po.number).toBe('PO-0001');
  const [line] = (await getPurchaseOrder(db, owner, po.purchaseOrderId))!.lines;
  expect(await receivePurchaseOrder(db, owner, { purchaseOrderId: po.purchaseOrderId, lines: [{ lineId: line.id, quantity: '6', totalCostPesewas: 2400 }], paidNow: false }, t0)).toEqual({ ok: false, error: 'not_open' });
  expect(await markPurchaseOrderSent(db, owner, po.purchaseOrderId, t0)).toEqual({ ok: true });
  const r1 = await receivePurchaseOrder(db, owner, { purchaseOrderId: po.purchaseOrderId, lines: [{ lineId: line.id, quantity: '6', totalCostPesewas: 2400 }], paidNow: false, billReference: 'INV-77' }, t0);
  expect(r1).toMatchObject({ ok: true, status: 'partly_received', billId: expect.any(String) });
  expect(await receivePurchaseOrder(db, owner, { purchaseOrderId: po.purchaseOrderId, lines: [{ lineId: line.id, quantity: '5', totalCostPesewas: 2000 }], paidNow: true }, t0)).toEqual({ ok: false, error: 'over_received' });
  expect(await receivePurchaseOrder(db, owner, { purchaseOrderId: po.purchaseOrderId, lines: [{ lineId: line.id, quantity: '4', totalCostPesewas: 1600 }], paidNow: true }, t0)).toMatchObject({ status: 'received', billId: null });
  expect(await onHand()).toBe('20.000');
  const [bill] = await listBills(db, owner, t0);
  expect(bill).toMatchObject({ amountPesewas: 2400, dueDate: '2026-12-26', status: 'due', reference: 'INV-77' });
  expect(await payBill(db, owner, { billId: bill.id, amountPesewas: 1000, method: 'momo_manual' })).toEqual({ ok: false, error: 'reference_required' });
  expect(await payBill(db, owner, { billId: bill.id, amountPesewas: 1000, method: 'cash' })).toEqual({ ok: true, owedPesewas: 1400 });
  const ret = await returnToSupplier(db, owner, { branchId: shop.branchId, supplierId, reason: 'Damaged in delivery', lines: [{ variantId: p.variantId, unitId: p.baseUnitId, quantity: '2' }] });
  expect(ret).toEqual({ ok: true, returnId: expect.any(String), creditPesewas: 800 });
  expect(await onHand()).toBe('18.000');
  expect(await returnToSupplier(db, owner, { branchId: shop.branchId, supplierId, reason: 'x', lines: [{ variantId: p.variantId, unitId: p.baseUnitId, quantity: '99' }] })).toMatchObject({ ok: false, error: 'not_enough_stock' });
  expect(await payBill(db, owner, { billId: bill.id, amountPesewas: 900, method: 'credit' })).toEqual({ ok: false, error: 'not_enough_credit' });
  expect(await payBill(db, owner, { billId: bill.id, amountPesewas: 800, method: 'credit' })).toEqual({ ok: true, owedPesewas: 600 });
  await expectAccess(listBills(db, await tillCtxFor(db, shop, 'cashier', t0), t0), 'forbidden');
});

it('suggested orders cover the reorder level, rounded to whole packs, for the main supplier', async () => {
  await asPlatform(db, (tx) => tx.update(variants).set({ reorderLevel: '25' }).where(eq(variants.id, p.variantId)));
  await setSupplierItem(db, owner, { supplierId, variantId: p.variantId, unitId: p.baseUnitId, lastCostPesewas: 390, isMain: true });
  const s = await suggestPurchaseOrders(db, owner, shop.branchId, t0) as { created: Array<{ purchaseOrderId: string }> };
  expect(s.created).toHaveLength(1);
  const po = (await getPurchaseOrder(db, owner, s.created[0].purchaseOrderId))!;
  expect(po).toMatchObject({ status: 'draft', suggested: true });
  expect(po.lines[0]).toMatchObject({ quantity: '15.000', unitCostPesewas: 390 });
  const again = await suggestPurchaseOrders(db, owner, shop.branchId, t0) as { created: unknown[] };
  expect(again.created).toHaveLength(1); // the unsent draft was replaced, not doubled
  expect((await lowStock(db, owner)).map((l) => [l.name.startsWith('Item'), l.supplier])).toEqual([[true, 'Kumasi Wholesale']]);
});

it('transfers move stock through "in transit", and differences need a reason', async () => {
  const [b2] = await asPlatform(db, (tx) => tx.insert(branches).values({ tenantId: shop.tenantId, name: 'Osu', branchCode: 'B2' }).returning());
  expect(await sendTransfer(db, owner, { fromBranchId: shop.branchId, toBranchId: shop.branchId, lines: [] }, t0)).toEqual({ ok: false, error: 'invalid_input' });
  expect(await sendTransfer(db, owner, { fromBranchId: shop.branchId, toBranchId: b2.id, lines: [{ variantId: p.variantId, unitId: p.baseUnitId, quantity: '30' }] }, t0)).toMatchObject({ ok: false, error: 'not_enough_stock' });
  const tr = await sendTransfer(db, owner, { fromBranchId: shop.branchId, toBranchId: b2.id, lines: [{ variantId: p.variantId, unitId: p.baseUnitId, quantity: '3' }] }, t0) as { transferId: string; number: string };
  expect(tr.number).toBe('TR-0001');
  expect(await onHand()).toBe('7.000');
  expect((await inventoryValuation(db, owner)).inTransitPesewas).toBe(1200);
  const [line] = (await getTransfer(db, owner, tr.transferId))!.lines;
  expect(await receiveTransfer(db, owner, { transferId: tr.transferId, lines: [{ lineId: line.id, receivedQuantity: '2' }] }, t0)).toEqual({ ok: false, error: 'reason_required', detail: line.id });
  expect(await receiveTransfer(db, owner, { transferId: tr.transferId, lines: [{ lineId: line.id, receivedQuantity: '2', reason: 'One broken on the way' }] }, t0)).toEqual({ ok: true, differences: 1 });
  expect(await onHand(b2.id)).toBe('2.000');
  expect(await inventoryValuation(db, owner)).toMatchObject({ inTransitPesewas: 0, totalPesewas: 3600 });
});

it('a count keeps selling going: stock moved after the snapshot is not counted as a difference', async () => {
  const c = await startCount(db, owner, { branchId: shop.branchId }, new Date()) as { countId: string };
  await adjustStock(db, owner, { branchId: shop.branchId, line: { variantId: p.variantId, unitId: p.baseUnitId, quantity: '1' }, reason: 'damage' }, new Date()); // 10 -> 9 during the count
  expect(await recordCount(db, owner, { countId: c.countId, variantId: p.variantId, quantity: '5', mode: 'set' }, new Date())).toEqual({ ok: true, counted: '5.000' });
  expect(await recordCount(db, owner, { countId: c.countId, variantId: p.variantId, quantity: '3', mode: 'add' }, new Date())).toEqual({ ok: true, counted: '8.000' });
  expect(await finishCount(db, owner, { countId: c.countId }, new Date())).toEqual({ ok: true, counted: 1, notCounted: 0, differenceValuePesewas: 400 }); // 8 counted vs 9 expected
  expect(await onHand()).toBe('8.000');
});

it('adjustments: down for theft, up when found', async () => {
  expect(await adjustStock(db, owner, { branchId: shop.branchId, line: { variantId: p.variantId, unitId: p.baseUnitId, quantity: '2' }, reason: 'theft' }, t0)).toMatchObject({ ok: true, valuePesewas: 800 });
  expect(await adjustStock(db, owner, { branchId: shop.branchId, line: { variantId: p.variantId, unitId: p.baseUnitId, quantity: '1' }, reason: 'found' }, t0)).toMatchObject({ ok: true });
  expect(await onHand()).toBe('9.000');
  expect(await adjustStock(db, owner, { branchId: shop.branchId, line: { variantId: p.variantId, unitId: p.baseUnitId, quantity: '1' }, reason: 'gift' as never }, t0)).toEqual({ ok: false, error: 'invalid_input' });
});

it('Code 128 labels: every pattern is 11 modules and the check value is right', () => {
  expect(PATTERNS.slice(0, 106).every((x) => [...x].reduce((s, d) => s + Number(d), 0) === 11)).toBe(true);
  expect(code128Values('ABC')).toEqual([104, 33, 34, 35, 1, 106]);
  expect(code128Values('₵')).toBeNull();
});

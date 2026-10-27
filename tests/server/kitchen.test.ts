import { afterEach, beforeEach, expect, it } from 'vitest';
import type { Db } from '@/db/client';
import type { Ctx } from '@/server/context';
import { handOverOrder, kitchenBranches, listKitchenOrders, markOrderReady, tickPackedLine } from '@/server/kitchen';
import { completeSale, type SaleInput } from '@/server/sales';
import { ctxFor, foodShop, productFor, saleInput, type SeededShop, seedShop, tillCtxFor } from '../helpers/fixtures';
import { createTestDb } from '../helpers/test-db';

const t = new Date('2026-10-26T12:00:00Z');
const later = (min: number) => new Date(t.getTime() + min * 60_000);
let db: Db;
let close: () => Promise<void>;
let shop: SeededShop & { packVariantId: string; packUnitId: string };
let till: Ctx;
let jollof: { variantId: string; baseUnitId: string };
beforeEach(async () => {
  ({ db, close } = await createTestDb());
  shop = await foodShop(db, t);
  jollof = await productFor(db, await ctxFor(db, shop, 'owner', t), { name: 'Jollof', variants: [{ basePricePesewas: 3000, costPesewas: 1500 }] });
  till = await tillCtxFor(db, shop, 'owner', t);
});
afterEach(async () => { await close(); });

let receipt = 0;
async function order(diningOption: 'eat_in' | 'takeaway', at = t): Promise<string> {
  const lines: SaleInput['lines'] = [{ variantId: jollof.variantId, unitId: jollof.baseUnitId, quantity: '2', unitPricePesewas: 3000, discountPesewas: 0 }];
  if (diningOption === 'takeaway') lines.push({ variantId: shop.packVariantId, unitId: shop.packUnitId, quantity: '1', unitPricePesewas: 100, discountPesewas: 0 });
  const r = await completeSale(db, till, saleInput({
    receiptNumber: `B1-T1-${String(++receipt).padStart(6, '0')}`, lines, food: { serviceMode: 'counter', diningOption }, deviceCreatedAt: at.toISOString(),
  }), at);
  if (!r.ok) throw new Error(r.error);
  const list = await listKitchenOrders(db, till, shop.branchId, at);
  return (list as { orders: Array<{ id: string; orderNumber: string }> }).orders.find((o) => o.orderNumber === r.orderNumber)!.id;
}

it("lists today's orders oldest first with their lines", async () => {
  await order('takeaway', t);
  await order('eat_in', later(2));
  const r = await listKitchenOrders(db, till, shop.branchId, later(3));
  expect(r).toMatchObject({ ok: true, orders: [
    { orderNumber: '001', status: 'preparing', diningOption: 'takeaway', needsPacking: true, lines: [
      { lineNo: 1, name: 'Jollof', quantity: '2.000', packed: false }, { lineNo: 2, name: 'Takeaway pack', quantity: '1.000', packed: false },
    ] },
    { orderNumber: '002', diningOption: 'eat_in', needsPacking: false },
  ] });
  expect((await listKitchenOrders(db, till, shop.branchId, new Date('2026-10-27T12:00:00Z')) as { orders: unknown[] }).orders).toEqual([]);
});

it('refuses orders of a branch the user is not assigned to', async () => {
  const id = await order('eat_in');
  const other = await seedShop(db, { shopType: 'food' });
  const stranger = await tillCtxFor(db, other, 'owner', t);
  expect(await listKitchenOrders(db, stranger, shop.branchId, t)).toEqual({ ok: false, error: 'not_assigned' });
  expect(await markOrderReady(db, stranger, id, t)).toEqual({ ok: false, error: 'not_found' });
  expect(await handOverOrder(db, stranger, { orderId: id }, t)).toEqual({ ok: false, error: 'not_found' });
});

it('marks an order ready once', async () => {
  const id = await order('eat_in');
  expect(await markOrderReady(db, till, id, later(5))).toEqual({ ok: true });
  expect(await markOrderReady(db, till, id, later(6))).toEqual({ ok: false, error: 'wrong_status' });
  const r = await listKitchenOrders(db, till, shop.branchId, later(6)) as { orders: Array<{ status: string; readyAt: Date | null }> };
  expect(r.orders[0]).toMatchObject({ status: 'ready', readyAt: later(5) });
});

it('an eat-in order is collected without packing', async () => {
  const id = await order('eat_in');
  await markOrderReady(db, till, id, later(5));
  expect(await handOverOrder(db, till, { orderId: id }, later(7))).toEqual({ ok: true });
  expect((await listKitchenOrders(db, till, shop.branchId, later(8)) as { orders: unknown[] }).orders).toEqual([]);
  expect(await handOverOrder(db, till, { orderId: id }, later(9))).toEqual({ ok: false, error: 'wrong_status' });
});

it('a takeaway order cannot be handed over until every line is ticked', async () => {
  const id = await order('takeaway');
  expect(await tickPackedLine(db, till, { orderId: id, lineNo: 3, packed: true }, later(1))).toEqual({ ok: false, error: 'unknown_line' });
  expect(await tickPackedLine(db, till, { orderId: id, lineNo: 1, packed: true }, later(1))).toEqual({ ok: true });
  expect(await handOverOrder(db, till, { orderId: id, handedTo: 'Kwame, Bolt' }, later(2))).toEqual({ ok: false, error: 'not_packed' });
  await tickPackedLine(db, till, { orderId: id, lineNo: 2, packed: true }, later(2));
  expect(await handOverOrder(db, till, { orderId: id }, later(3))).toEqual({ ok: false, error: 'invalid_input' }); // who took it is required
  expect(await handOverOrder(db, till, { orderId: id, handedTo: 'Kwame, Bolt' }, later(3))).toEqual({ ok: true });
});

it('unticking a line blocks hand-over again', async () => {
  const id = await order('takeaway');
  await tickPackedLine(db, till, { orderId: id, lineNo: 1, packed: true }, later(1));
  await tickPackedLine(db, till, { orderId: id, lineNo: 2, packed: true }, later(1));
  expect(await tickPackedLine(db, till, { orderId: id, lineNo: 2, packed: false }, later(2))).toEqual({ ok: true });
  expect(await handOverOrder(db, till, { orderId: id, handedTo: 'Ama' }, later(3))).toEqual({ ok: false, error: 'not_packed' });
});

it('ticking on an eat-in order is refused', async () => {
  const id = await order('eat_in');
  expect(await tickPackedLine(db, till, { orderId: id, lineNo: 1, packed: true }, later(1))).toEqual({ ok: false, error: 'no_packing' });
});

it("lists the user's branches for the kitchen screen", async () => {
  expect(await kitchenBranches(db, till)).toEqual([{ id: shop.branchId, name: 'Main' }]);
});

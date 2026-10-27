import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { afterEach, beforeEach, expect, it } from 'vitest';
import type { Db } from '@/db/client';
import { kitchenOrders, sales, variants } from '@/db/schema';
import { asPlatform } from '@/db/tenant';
import { saveChannel } from '@/server/channels';
import type { Ctx } from '@/server/context';
import { handOverOrder, listKitchenOrders, tickPackedLine } from '@/server/kitchen';
import { cancelPhoneOrder, createPhoneOrder, findPhoneOrder } from '@/server/phone-orders';
import { completeSale, type SaleInput } from '@/server/sales';
import { markSoldOut } from '@/server/sold-out';
import { ctxFor, foodShop, productFor, saleInput, type SeededShop, tillCtxFor } from '../helpers/fixtures';
import { createTestDb } from '../helpers/test-db';

const t = new Date('2026-10-26T12:00:00Z');
let db: Db;
let close: () => Promise<void>;
let shop: SeededShop & { packVariantId: string; packUnitId: string };
let owner: Ctx;
let till: Ctx;
let jollof: { variantId: string; baseUnitId: string };
let phone: string;
let bolt: string;
beforeEach(async () => {
  ({ db, close } = await createTestDb());
  shop = await foodShop(db, t);
  owner = await ctxFor(db, shop, 'owner', t);
  jollof = await productFor(db, owner, { name: 'Jollof', variants: [{ basePricePesewas: 4500, costPesewas: 2000 }] });
  const channel = async (name: string, kind: 'phone' | 'delivery_app') => (await saveChannel(db, owner, {
    name, kind, priceListId: null, commissionBp: 0, collectedBy: 'shop', active: true,
  }) as { channelId: string }).channelId;
  phone = await channel('Phone', 'phone');
  bolt = await channel('Bolt Food', 'delivery_app');
  till = await tillCtxFor(db, shop, 'owner', t);
});
afterEach(async () => { await close(); });

const pending = (quantity = '2') => ({ variantId: jollof.variantId, unitId: jollof.baseUnitId, quantity });
const order = (o: Partial<Parameters<typeof createPhoneOrder>[2]> = {}) => ({
  channelId: phone, diningOption: 'takeaway' as const, customer: { name: 'Ama', phone: '0241234567' }, pickupAt: '2026-10-26T13:00:00Z', lines: [pending()], ...o,
});
const created = async () => await createPhoneOrder(db, till, order(), t) as { ok: true; kitchenOrderId: string; orderNumber: string };

let receipt = 0;
const collect = (kitchenOrderId: string, lines: SaleInput['lines']) => saleInput({
  receiptNumber: `B1-T1-${String(++receipt + 900).padStart(6, '0')}`, deviceCreatedAt: t.toISOString(), lines,
  tenders: [{ id: randomUUID(), method: 'cash', amountPesewas: 100000 }],
  food: { serviceMode: 'counter', diningOption: 'takeaway', channelId: phone, kitchenOrderId },
});
const jollofLine = (quantity = '2', price = 4500) => ({ variantId: jollof.variantId, unitId: jollof.baseUnitId, quantity, unitPricePesewas: price, discountPesewas: 0 });
const pack = () => ({ variantId: shop.packVariantId, unitId: shop.packUnitId, quantity: '1', unitPricePesewas: 100, discountPesewas: 0 });
const orderRow = async (id: string) => (await asPlatform(db, (tx) => tx.select().from(kitchenOrders).where(eq(kitchenOrders.id, id))))[0];

it('creates an unpaid phone order with the next number and sends it to the kitchen', async () => {
  const r = await created();
  expect(r).toMatchObject({ ok: true, orderNumber: '001' });
  expect(await orderRow(r.kitchenOrderId)).toMatchObject({ payOnCollect: true, saleId: null, needsPacking: true, channelId: phone, customerName: 'Ama', status: 'preparing' });
  const kitchen = await listKitchenOrders(db, owner, shop.branchId, t) as { ok: true; orders: Array<Record<string, unknown>> };
  expect(kitchen.orders).toMatchObject([{
    orderNumber: '001', channelName: 'Phone', customerName: 'Ama', payOnCollect: true, paid: false, lines: [{ lineNo: 1, name: 'Jollof', quantity: '2.000', packed: false }],
  }]);
});

it('refuses a sold-out item or a delivery-app channel', async () => {
  await markSoldOut(db, owner, { branchId: shop.branchId, variantId: jollof.variantId }, t);
  expect(await createPhoneOrder(db, till, order(), t)).toEqual({ ok: false, error: 'sold_out' });
  expect(await createPhoneOrder(db, till, order({ channelId: bolt }), t)).toEqual({ ok: false, error: 'unknown_channel' });
  expect(await createPhoneOrder(db, till, order({ customer: { name: 'Ama', phone: '12' } }), t)).toEqual({ ok: false, error: 'customer_details_required' });
});

it("finds today's open order by number", async () => {
  const r = await created();
  expect(await findPhoneOrder(db, till, '001', t)).toMatchObject({ kitchenOrderId: r.kitchenOrderId, channelId: phone, customerName: 'Ama', lines: [pending('2.000')] });
  expect(await findPhoneOrder(db, till, '002', t)).toBeNull();
  expect(await findPhoneOrder(db, till, '001', new Date('2026-10-27T12:00:00Z'))).toBeNull();
});

it('collecting checks the lines match the order', async () => {
  const r = await created();
  // the price went up after the call: the customer pays today's price for the same lines
  await asPlatform(db, (tx) => tx.update(variants).set({ basePricePesewas: 5000 }).where(eq(variants.id, jollof.variantId)));
  expect(await completeSale(db, till, collect(r.kitchenOrderId, [jollofLine('3', 5000), pack()]), t)).toEqual({ ok: false, error: 'order_changed' });
  expect(await completeSale(db, till, collect(r.kitchenOrderId, [pack(), jollofLine('2', 5000)]), t)).toEqual({ ok: false, error: 'order_changed' });
  expect(await completeSale(db, till, collect(r.kitchenOrderId, [jollofLine('2', 4500), pack()]), t)).toEqual({ ok: false, error: 'price_changed' });
  const paid = await completeSale(db, till, collect(r.kitchenOrderId, [jollofLine('2', 5000), pack()]), t);
  expect(paid).toMatchObject({ ok: true, orderNumber: '001' });
  const saleId = (paid as { saleId: string }).saleId;
  expect(await orderRow(r.kitchenOrderId)).toMatchObject({ saleId, orderNumber: '001' });
  expect((await asPlatform(db, (tx) => tx.select().from(sales).where(eq(sales.id, saleId))))[0]).toMatchObject({ totalPesewas: 10100, channelId: phone, orderNumber: '001' });
  expect(await asPlatform(db, (tx) => tx.select().from(kitchenOrders))).toHaveLength(1);
});

it('a phone order is still paid for after its item sold out', async () => {
  const r = await created();
  await markSoldOut(db, owner, { branchId: shop.branchId, variantId: jollof.variantId }, t); // the last portion went to this order
  expect(await completeSale(db, till, collect(r.kitchenOrderId, [jollofLine(), pack()]), t)).toMatchObject({ ok: true });
});

it('a pack scanned by hand is not kept on the phone order', async () => {
  const r = await createPhoneOrder(db, till, order({ lines: [pending(), { variantId: shop.packVariantId, unitId: shop.packUnitId, quantity: '1' }] }), t) as { kitchenOrderId: string };
  expect((await orderRow(r.kitchenOrderId)).pendingLines).toEqual([pending('2.000')]);
  expect(await completeSale(db, till, collect(r.kitchenOrderId, [jollofLine(), pack()]), t)).toMatchObject({ ok: true });
});

it('a paid or cancelled order cannot be collected again', async () => {
  const r = await created();
  await completeSale(db, till, collect(r.kitchenOrderId, [jollofLine(), pack()]), t);
  expect(await completeSale(db, till, collect(r.kitchenOrderId, [jollofLine(), pack()]), t)).toEqual({ ok: false, error: 'order_not_open' });
  const other = await createPhoneOrder(db, till, order(), t) as { kitchenOrderId: string };
  await cancelPhoneOrder(db, till, { kitchenOrderId: other.kitchenOrderId, reason: 'Customer did not come' }, t);
  expect(await completeSale(db, till, collect(other.kitchenOrderId, [jollofLine(), pack()]), t)).toEqual({ ok: false, error: 'order_not_open' });
  expect(await completeSale(db, till, collect(randomUUID(), [jollofLine(), pack()]), t)).toEqual({ ok: false, error: 'order_not_open' });
});

it('an unpaid order cannot be handed over', async () => {
  const r = await created();
  expect(await tickPackedLine(db, owner, { orderId: r.kitchenOrderId, lineNo: 1, packed: true }, t)).toEqual({ ok: true });
  expect(await handOverOrder(db, owner, { orderId: r.kitchenOrderId, handedTo: 'Ama' }, t)).toEqual({ ok: false, error: 'not_paid' });
  await completeSale(db, till, collect(r.kitchenOrderId, [jollofLine(), pack()]), t);
  await tickPackedLine(db, owner, { orderId: r.kitchenOrderId, lineNo: 2, packed: true }, t);
  expect(await handOverOrder(db, owner, { orderId: r.kitchenOrderId, handedTo: 'Ama' }, t)).toEqual({ ok: true });
});

it('cancels an unpaid order with a reason; a paid order cannot be cancelled', async () => {
  const r = await created();
  expect(await cancelPhoneOrder(db, till, { kitchenOrderId: r.kitchenOrderId, reason: '' }, t)).toEqual({ ok: false, error: 'invalid_input' });
  expect(await cancelPhoneOrder(db, till, { kitchenOrderId: r.kitchenOrderId, reason: 'No show' }, t)).toEqual({ ok: true });
  expect(await orderRow(r.kitchenOrderId)).toMatchObject({ status: 'cancelled' });
  const paid = await created();
  await completeSale(db, till, collect(paid.kitchenOrderId, [jollofLine(), pack()]), t);
  expect(await cancelPhoneOrder(db, till, { kitchenOrderId: paid.kitchenOrderId, reason: 'No show' }, t)).toEqual({ ok: false, error: 'already_paid' });
});

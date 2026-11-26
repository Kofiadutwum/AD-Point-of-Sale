import { randomUUID } from 'node:crypto';
import { afterEach, beforeEach, expect, it } from 'vitest';
import type { Db } from '@/db/client';
import { sales } from '@/db/schema';
import { asPlatform, withTenant } from '@/db/tenant';
import type { Ctx } from '@/server/context';
import { cancelCounterOrder, collectCounterOrder, listCounterOrders, quoteCounterOrder, sendCounterOrder } from '@/server/counter-orders';
import { stockOnHand } from '@/server/stock';
import { ctxFor, productFor, type SeededShop, seedShop, stockFor, tillCtxFor } from '../helpers/fixtures';
import { createTestDb } from '../helpers/test-db';

const t0 = new Date('2026-11-26T10:00:00Z');
let db: Db;
let close: () => Promise<void>;
let shop: SeededShop;
let seller: Ctx;
let cashier: Ctx;
let p: { variantId: string; baseUnitId: string };
beforeEach(async () => {
  ({ db, close } = await createTestDb());
  shop = await seedShop(db, { users: [
    { key: 'owner', email: 'o@c.test', password: 'correct-horse-1', rolePreset: 'owner' },
    { key: 'seller', phone: '0200000002', pin: '2222', rolePreset: 'cashier' },
    { key: 'cashier', phone: '0200000001', pin: '1234', rolePreset: 'cashier' },
  ] });
  const owner = await ctxFor(db, shop, 'owner', t0);
  seller = await tillCtxFor(db, shop, 'seller', t0);
  cashier = await tillCtxFor(db, shop, 'cashier', t0);
  p = await productFor(db, owner); // GHS 5.00
  await stockFor(db, owner, shop.branchId, { variantId: p.variantId, unitId: p.baseUnitId, quantity: '5', totalCostPesewas: 2000 }, t0);
});
afterEach(async () => { await close(); });

const send = (quantity = '2', at = t0) => sendCounterOrder(db, seller, { lines: [{ variantId: p.variantId, unitId: p.baseUnitId, quantity }] }, at);
const cash = (amountPesewas: number) => [{ id: randomUUID(), method: 'cash' as const, amountPesewas }];
const onHand = () => withTenant(db, shop.tenantId, (tx) => stockOnHand(tx, shop.branchId, p.variantId));

it('stock moves only when paid', async () => {
  const o = await send();
  expect(o).toEqual({ ok: true, orderId: expect.any(String), orderNumber: '0001' });
  expect(await onHand()).toBe('5.000');
  const orderId = (o as { orderId: string }).orderId;
  expect(await quoteCounterOrder(db, cashier, orderId, t0)).toEqual({ ok: true, orderNumber: '0001', totalPesewas: 1000 });
  expect(await collectCounterOrder(db, cashier, { orderId, tenders: cash(2000) }, t0)).toMatchObject({ ok: true, changeDuePesewas: 1000 });
  expect(await onHand()).toBe('3.000');
});

it('an order is paid once, and a cancelled one not at all', async () => {
  const { orderId } = await send() as { orderId: string };
  expect(await collectCounterOrder(db, cashier, { orderId, tenders: cash(1000) }, t0)).toMatchObject({ ok: true });
  expect(await collectCounterOrder(db, cashier, { orderId, tenders: cash(1000) }, t0)).toEqual({ ok: false, error: 'not_open' });
  const other = await send('1') as { orderId: string; orderNumber: string };
  expect(other.orderNumber).toBe('0002');
  expect(await cancelCounterOrder(db, seller, other.orderId, t0)).toEqual({ ok: true });
  expect(await collectCounterOrder(db, cashier, { orderId: other.orderId, tenders: cash(500) }, t0)).toEqual({ ok: false, error: 'not_open' });
  expect(await asPlatform(db, (tx) => tx.select().from(sales))).toHaveLength(1);
});

it('expired orders cannot be collected', async () => {
  const { orderId } = await send() as { orderId: string };
  expect((await listCounterOrders(db, cashier, t0)).map((o) => o.orderNumber)).toEqual(['0001']);
  const later = new Date(t0.getTime() + 121 * 60_000); // the default is 2 hours
  expect(await listCounterOrders(db, cashier, later)).toEqual([]);
  expect(await collectCounterOrder(db, cashier, { orderId, tenders: cash(1000) }, later)).toEqual({ ok: false, error: 'expired' });
});

it('the sale records the salesperson', async () => {
  const { orderId } = await send() as { orderId: string };
  await collectCounterOrder(db, cashier, { orderId, tenders: cash(1000) }, t0);
  expect(await asPlatform(db, (tx) => tx.select().from(sales))).toMatchObject([{ salespersonId: shop.users.seller.id, cashierId: shop.users.cashier.id, totalPesewas: 1000 }]);
});

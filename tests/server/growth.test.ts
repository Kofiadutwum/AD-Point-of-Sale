import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Db } from '@/db/client';
import { customers, notifications, saleLines, sales, stockBalances, tenants, variants } from '@/db/schema';
import { asPlatform } from '@/db/tenant';
import { applyPromotions, type Promo, promoRunning } from '@/lib/promotions';
import type { Ctx } from '@/server/context';
import { displayState, pairDisplay, pushCart, startPairing } from '@/server/customer-display';
import { cancelOrder, collectOrder, createOrder, payOrder } from '@/server/customer-orders';
import { addCustomer } from '@/server/customers';
import { saveCoupon, savePromotion } from '@/server/promotions';
import { processReturn } from '@/server/returns';
import { commissionReport, giftCardBalance, markCommissionPaid, saveCommissionRule, saveLoyaltySettings } from '@/server/rewards';
import { completeSale } from '@/server/sales';
import { ctxFor, productFor, saleInput, type SeededShop, seedShop, stockFor, tillCtxFor } from '../helpers/fixtures';
import { createTestDb } from '../helpers/test-db';

const promo = (p: Partial<Promo>): Promo => ({
  id: randomUUID(), name: 'x', kind: 'percent_off', productIds: [], categoryIds: [], percentBp: null, amountPesewas: null, buyQty: null, getQty: null, groupQty: null, groupPricePesewas: null,
  minSubtotalPesewas: 0, startsOn: null, endsOn: null, days: [], startTime: null, endTime: null, branchIds: [], stackable: false, requiresCoupon: false, createdAt: '2026-01-01T00:00:00Z', ...p,
});
const line = (unit: number, qty: string, productId = 'p1') => ({ productId, categoryId: null, unitPricePesewas: unit, quantity: qty, grossPesewas: Math.round(unit * Number(qty)), manualDiscountPesewas: 0 });

describe('promotion engine', () => {
  it('best line promotion wins, stackable ones add on, never below zero', () => {
    const r = applyPromotions([line(1000, '1')], [promo({ percentBp: 1000 }), promo({ kind: 'amount_off', amountPesewas: 300 }), promo({ percentBp: 500, stackable: true })]);
    expect(r.discounts).toEqual([350]); // 300 off beats 10%, plus a stackable 5%
    expect(applyPromotions([line(100, '1')], [promo({ kind: 'amount_off', amountPesewas: 500 })]).discounts).toEqual([100]);
  });
  it('buy 2 get 1 free discounts the cheapest unit; 3 for a price; cart promotion above a minimum', () => {
    expect(applyPromotions([line(500, '2'), line(300, '1', 'p2')], [promo({ kind: 'buy_x_get_y', buyQty: 2, getQty: 1, percentBp: 10000 })]).discounts).toEqual([0, 300]);
    expect(applyPromotions([line(400, '3')], [promo({ kind: 'multi_buy', groupQty: 3, groupPricePesewas: 1000 })]).discounts).toEqual([200]);
    expect(applyPromotions([line(1000, '1')], [promo({ kind: 'cart_percent', percentBp: 1000, minSubtotalPesewas: 2000 })]).discounts).toEqual([0]);
    expect(applyPromotions([line(1500, '2')], [promo({ kind: 'cart_percent', percentBp: 1000, minSubtotalPesewas: 2000 })]).discounts).toEqual([300]);
  });
  it('happy hours, days, dates, and branches', () => {
    const p = promo({ startTime: '16:00', endTime: '18:00', days: [5], startsOn: '2026-11-01', branchIds: ['b1'] });
    expect(promoRunning(p, { date: '2026-11-27', weekday: 5, time: '16:30', branchId: 'b1' })).toBe(true);
    expect(promoRunning(p, { date: '2026-11-27', weekday: 5, time: '18:00', branchId: 'b1' })).toBe(false);
    expect(promoRunning(p, { date: '2026-11-26', weekday: 4, time: '16:30', branchId: 'b1' })).toBe(false);
    expect(promoRunning(p, { date: '2026-11-27', weekday: 5, time: '16:30', branchId: 'b2' })).toBe(false);
  });
});

const t0 = new Date('2026-11-26T09:00:00Z');
let db: Db;
let close: () => Promise<void>;
let shop: SeededShop;
let owner: Ctx;
let manager: Ctx;
let p: { productId: string; variantId: string; baseUnitId: string };
let ama: string;
beforeEach(async () => {
  ({ db, close } = await createTestDb());
  shop = await seedShop(db, { users: [
    { key: 'owner', email: 'o@g.test', password: 'correct-horse-1', rolePreset: 'owner' },
    { key: 'manager', phone: '0200000009', pin: '4321', rolePreset: 'manager' },
  ] });
  owner = await ctxFor(db, shop, 'owner', t0);
  manager = await tillCtxFor(db, shop, 'manager', t0);
  p = await productFor(db, owner); // GHS 5.00
  await stockFor(db, owner, shop.branchId, { variantId: p.variantId, unitId: p.baseUnitId, quantity: '50', totalCostPesewas: 20000 }, t0);
  ama = ((await addCustomer(db, owner, { name: 'Ama', phone: '0244000001' })) as { customerId: string }).customerId;
});
afterEach(async () => { await close(); });

const sell = (qty: string, extra: Record<string, unknown> = {}, lineExtra: Record<string, unknown> = {}) => completeSale(db, manager, saleInput({
  lines: [{ variantId: p.variantId, unitId: p.baseUnitId, quantity: qty, unitPricePesewas: 500, discountPesewas: 0, ...lineExtra }],
  tenders: [{ id: randomUUID(), method: 'cash', amountPesewas: 100000 }], deviceCreatedAt: t0.toISOString(), ...extra,
}), t0);

it('a promotion the till worked out is checked by the server; an outdated till is refused online and flagged offline', async () => {
  expect(await savePromotion(db, owner, { name: '10% off everything', kind: 'percent_off', percentBp: 1000 })).toMatchObject({ ok: true });
  expect(await sell('2')).toEqual({ ok: false, error: 'price_changed' });
  expect(await sell('2', {}, { promotionDiscountPesewas: 100 })).toMatchObject({ ok: true, changeDuePesewas: 100000 - 900 });
  const off = await sell('1', { fromOfflineOutbox: true }) as { saleId: string };
  const [row] = await asPlatform(db, (tx) => tx.select().from(sales).where(eq(sales.id, off.saleId)));
  expect(row).toMatchObject({ totalPesewas: 500, needsReview: true, reviewReasons: ['promotion_changed'] });
});

it('a single-use coupon is used up by the sale that completes', async () => {
  const pr = await savePromotion(db, owner, { name: 'GHS 1 off', kind: 'amount_off', amountPesewas: 100, requiresCoupon: true }) as { promotionId: string };
  expect(await saveCoupon(db, owner, { code: 'xmas-1', promotionId: pr.promotionId, maxUses: 1 })).toMatchObject({ ok: true });
  expect(await sell('1')).toMatchObject({ ok: true }); // a coupon-only promotion does nothing without its code
  expect(await sell('1', { couponCode: 'XMAS-1' }, { promotionDiscountPesewas: 100 })).toMatchObject({ ok: true });
  expect(await sell('1', { couponCode: 'XMAS-1' }, { promotionDiscountPesewas: 100 })).toEqual({ ok: false, error: 'invalid_coupon' });
});

it('loyalty: points earned on money paid, spent as a tender, and taken back on a return', async () => {
  await saveLoyaltySettings(db, owner, { loyaltyEnabled: true, pesewasPerPoint: 100, pointValuePesewas: 10, minRedeemPoints: 5, pointsExpiryMonths: 0, giftCardExpiryMonths: 0 });
  await asPlatform(db, (tx) => tx.update(tenants).set({ refundLimitPesewas: 1_000_000 }).where(eq(tenants.id, shop.tenantId)));
  const s1 = await sell('4', { customerId: ama, tenders: [{ id: randomUUID(), method: 'cash', amountPesewas: 2000 }] }) as { saleId: string };
  const points = async () => (await asPlatform(db, (tx) => tx.select({ n: customers.loyaltyPoints }).from(customers).where(eq(customers.id, ama))))[0].n;
  expect(await points()).toBe(20); // GHS 20 = 20 points
  expect(await sell('1', { customerId: ama, tenders: [{ id: randomUUID(), method: 'points', amountPesewas: 50 }, { id: randomUUID(), method: 'cash', amountPesewas: 450 }] })).toMatchObject({ ok: true });
  expect(await points()).toBe(15 + 4); // 5 spent, 4 earned on the GHS 4.50 cash
  expect(await sell('1', { customerId: ama, tenders: [{ id: randomUUID(), method: 'points', amountPesewas: 30 }, { id: randomUUID(), method: 'cash', amountPesewas: 470 }] })).toEqual({ ok: false, error: 'insufficient_points' }); // below the minimum of 5
  const [sl] = await asPlatform(db, (tx) => tx.select().from(saleLines).where(eq(saleLines.saleId, s1.saleId)));
  expect(await processReturn(db, manager, { saleId: s1.saleId, items: [{ saleLineId: sl.id, quantity: '2', condition: 'saleable' }], reason: 'Changed mind', refundMethod: 'cash' }, t0)).toMatchObject({ ok: true });
  expect(await points()).toBe(9); // half of the 20 earned on that sale taken back
});

it('gift cards: sold as an item (no stock moves), spent in parts, balance checked', async () => {
  const card = await productFor(db, owner, { name: 'Gift card GHS 50', variants: [{ basePricePesewas: 5000, costPesewas: 0 }] });
  await asPlatform(db, (tx) => tx.update(variants).set({ isGiftCard: true }).where(eq(variants.id, card.variantId)));
  const sold = await completeSale(db, manager, saleInput({ lines: [{ variantId: card.variantId, unitId: card.baseUnitId, quantity: '1', unitPricePesewas: 5000, discountPesewas: 0 }], tenders: [{ id: randomUUID(), method: 'cash', amountPesewas: 5000 }], deviceCreatedAt: t0.toISOString() }), t0) as { giftCards: Array<{ code: string }> };
  const code = sold.giftCards[0].code;
  expect(code).toMatch(/^[A-Z2-9]{4}-[A-Z2-9]{4}-[A-Z2-9]{4}-[A-Z2-9]{4}$/);
  expect(await asPlatform(db, (tx) => tx.select().from(stockBalances).where(eq(stockBalances.variantId, card.variantId)))).toEqual([]);
  expect(await sell('2', { tenders: [{ id: randomUUID(), method: 'gift_card', amountPesewas: 1000, reference: code }] })).toMatchObject({ ok: true });
  expect(await giftCardBalance(db, manager, code)).toMatchObject({ balancePesewas: 4000 });
  expect(await sell('1', { tenders: [{ id: randomUUID(), method: 'gift_card', amountPesewas: 500, reference: 'AAAA-BBBB-CCCC-DDDD' }] })).toEqual({ ok: false, error: 'invalid_gift_card' });
});

it('commission: the shop default applies and the owner marks it paid', async () => {
  expect(await saveCommissionRule(db, owner, { percentBp: 500 })).toEqual({ ok: true });
  await sell('4'); // GHS 20 net
  expect((await commissionReport(db, owner, { from: '2026-11-01', to: '2099-12-31' }))[0]).toMatchObject({ totalPesewas: 100, unpaidPesewas: 100 });
  expect(await markCommissionPaid(db, owner, { userId: shop.users.manager.id, from: '2026-11-01', to: '2099-12-31' }, t0)).toEqual({ ok: true, paidPesewas: 100 });
});

it('layaway: deposit reserves stock, paid in parts, collected as a sale; a cancelled one refunds as store credit', async () => {
  const items = [{ variantId: p.variantId, unitId: p.baseUnitId, quantity: '4' }];
  expect(await createOrder(db, manager, { kind: 'layaway', customerId: ama, lines: items, deposit: { method: 'cash', amountPesewas: 100 } }, t0)).toEqual({ ok: false, error: 'deposit_too_small' });
  const o = await createOrder(db, manager, { kind: 'layaway', customerId: ama, lines: items, deposit: { method: 'cash', amountPesewas: 500 } }, t0) as { orderId: string; number: string };
  expect(o.number).toBe('LA-0001');
  const bal = async () => (await asPlatform(db, (tx) => tx.select().from(stockBalances).where(eq(stockBalances.variantId, p.variantId))))[0];
  expect((await bal()).reserved).toBe('4.000');
  expect(await collectOrder(db, manager, o.orderId, t0)).toMatchObject({ ok: false, error: 'payment_incomplete' });
  expect(await payOrder(db, manager, { orderId: o.orderId, method: 'cash', amountPesewas: 1500 }, t0)).toEqual({ ok: true, paidPesewas: 2000, status: 'ready' });
  expect(await collectOrder(db, manager, o.orderId, t0)).toMatchObject({ ok: true });
  expect(await bal()).toMatchObject({ reserved: '0.000', onHand: '46.000' });

  await asPlatform(db, (tx) => tx.update(tenants).set({ orderCancellationFeePesewas: 200 }).where(eq(tenants.id, shop.tenantId)));
  const o2 = await createOrder(db, manager, { kind: 'layaway', customerId: ama, lines: items, deposit: { method: 'cash', amountPesewas: 1000 } }, t0) as { orderId: string };
  expect(await cancelOrder(db, manager, { orderId: o2.orderId, reason: 'Customer changed mind' }, t0)).toEqual({ ok: true, refundPesewas: 800, refundAs: 'store_credit' });
  expect((await bal()).reserved).toBe('0.000');
  const [c] = await asPlatform(db, (tx) => tx.select().from(customers).where(eq(customers.id, ama)));
  expect(c.storeCreditPesewas).toBe(800);
});

it('a special order becomes ready (with an SMS) when its stock arrives', async () => {
  const other = await productFor(db, owner);
  const o = await createOrder(db, manager, { kind: 'special', customerId: ama, lines: [{ variantId: other.variantId, unitId: other.baseUnitId, quantity: '2' }], deposit: { method: 'cash', amountPesewas: 0 } }, t0) as { orderId: string };
  await stockFor(db, owner, shop.branchId, { variantId: other.variantId, unitId: other.baseUnitId, quantity: '5', totalCostPesewas: 2000 }, t0);
  const [n] = await asPlatform(db, (tx) => tx.select().from(notifications));
  expect(n).toMatchObject({ kind: 'order', toPhone: '233244000001', key: `order-ready:${o.orderId}` });
});

it('a customer display pairs with a code and shows only its till\'s cart', async () => {
  const pair = await startPairing(db, manager, t0) as { code: string };
  expect(await pairDisplay(db, 'another-shop', pair.code, t0)).toEqual({ ok: false, error: 'invalid_code' });
  const d = await pairDisplay(db, shop.slug, pair.code, t0) as { token: string };
  expect(await pairDisplay(db, shop.slug, pair.code, t0)).toEqual({ ok: false, error: 'invalid_code' }); // used
  await savePromotion(db, owner, { name: 'Fried rice Friday', kind: 'percent_off', percentBp: 500 });
  expect(await displayState(db, shop.slug, d.token, t0)).toMatchObject({ cart: null, promotions: ['Fried rice Friday'] });
  await pushCart(db, manager, { lines: [{ name: 'Rice', quantity: '1', totalPesewas: 500 }], discountPesewas: 0, totalPesewas: 500, paidPesewas: 0, changePesewas: 0 }, t0);
  expect(await displayState(db, shop.slug, d.token, t0)).toMatchObject({ cart: { totalPesewas: 500 }, promotions: [] });
  expect(await displayState(db, shop.slug, 'x'.repeat(32), t0)).toBeNull();
});

import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { afterEach, beforeEach, expect, it } from 'vitest';
import type { Db } from '@/db/client';
import { coupons, customers, loyaltyEntries } from '@/db/schema';
import { asPlatform, withTenant } from '@/db/tenant';
import { ROLE_PRESETS } from '@/lib/permissions';
import type { Ctx } from '@/server/context';
import { cancelOrder, createOrder } from '@/server/customer-orders';
import { addCustomer } from '@/server/customers';
import { saveCoupon, savePromotion } from '@/server/promotions';
import { overLimit } from '@/server/rate-limit';
import { expireAllPoints, redeemPoints, saveLoyaltySettings } from '@/server/rewards';
import { completeSale } from '@/server/sales';
import { addStaff } from '@/server/staff';
import { ctxFor, productFor, saleInput, type SeededShop, seedShop, stockFor, tillCtxFor } from '../helpers/fixtures';
import { createTestDb } from '../helpers/test-db';

// Spec section 13 acceptance tests not already covered elsewhere, plus Phase 7 changes.

const t0 = new Date('2026-11-26T09:00:00Z');
let db: Db;
let close: () => Promise<void>;
let shop: SeededShop;
let owner: Ctx;
let till: Ctx;
let p: { productId: string; variantId: string; baseUnitId: string };
let ama: string;

beforeEach(async () => {
  ({ db, close } = await createTestDb());
  shop = await seedShop(db, { users: [
    { key: 'owner', email: 'o@acc.test', password: 'correct-horse-1', rolePreset: 'owner' },
    { key: 'manager', phone: '0200000009', pin: '4321', rolePreset: 'manager' },
  ] });
  owner = await ctxFor(db, shop, 'owner', t0);
  till = await tillCtxFor(db, shop, 'manager', t0);
  p = await productFor(db, owner); // GHS 5.00
  await stockFor(db, owner, shop.branchId, { variantId: p.variantId, unitId: p.baseUnitId, quantity: '5', totalCostPesewas: 1500 }, t0);
  ama = ((await addCustomer(db, owner, { name: 'Ama', phone: '0244000001' })) as { customerId: string }).customerId;
});
afterEach(async () => { await close(); });

const sell = (qty: string, extra: Record<string, unknown> = {}, lineExtra: Record<string, unknown> = {}) => completeSale(db, till, saleInput({
  lines: [{ variantId: p.variantId, unitId: p.baseUnitId, quantity: qty, unitPricePesewas: 500, discountPesewas: 0, ...lineExtra }],
  tenders: [{ id: randomUUID(), method: 'cash', amountPesewas: 100000 }], deviceCreatedAt: t0.toISOString(), ...extra,
}), t0);

it('layaway stock is reserved and cannot be sold to someone else; cancelling returns it to available stock', async () => {
  const o = await createOrder(db, till, { kind: 'layaway', customerId: ama, lines: [{ variantId: p.variantId, unitId: p.baseUnitId, quantity: '4' }], deposit: { method: 'cash', amountPesewas: 1000 } }, t0) as { orderId: string };
  expect(await sell('1')).toMatchObject({ ok: true }); // 5 on hand, 4 held: one is free
  expect(await sell('1')).toEqual({ ok: false, error: 'reserved_stock' }); // even though this shop allows negative stock
  expect(await cancelOrder(db, till, { orderId: o.orderId, reason: 'Changed mind' }, t0)).toMatchObject({ ok: true });
  expect(await sell('1')).toMatchObject({ ok: true });
});

it('a coupon on an abandoned sale is not used up', async () => {
  const pr = await savePromotion(db, owner, { name: 'GHS 1 off', kind: 'amount_off', amountPesewas: 100, requiresCoupon: true }) as { promotionId: string };
  await saveCoupon(db, owner, { code: 'ONCE', promotionId: pr.promotionId, maxUses: 1 });
  // the sale is refused (the till's figure is out of date), so nothing is saved, the coupon included
  expect(await sell('1', { couponCode: 'ONCE' })).toEqual({ ok: false, error: 'price_changed' });
  const [c] = await asPlatform(db, (tx) => tx.select({ used: coupons.usedCount }).from(coupons));
  expect(c.used).toBe(0);
  expect(await sell('1', { couponCode: 'ONCE' }, { promotionDiscountPesewas: 100 })).toMatchObject({ ok: true });
});

it('loyalty points never go below zero when two sales spend them at the same moment', async () => {
  await saveLoyaltySettings(db, owner, { loyaltyEnabled: true, pesewasPerPoint: 100, pointValuePesewas: 10, minRedeemPoints: 5, pointsExpiryMonths: 0, giftCardExpiryMonths: 0 });
  await asPlatform(db, (tx) => tx.update(customers).set({ loyaltyPoints: 10 }).where(eq(customers.id, ama)));
  const spend = () => withTenant(db, shop.tenantId, (tx) => redeemPoints(tx, shop.tenantId, ama, 80, randomUUID())); // 8 points each
  const results = await Promise.all([spend(), spend()]);
  expect(results.filter((r) => r === true)).toHaveLength(1);
  const [row] = await asPlatform(db, (tx) => tx.select({ n: customers.loyaltyPoints }).from(customers).where(eq(customers.id, ama)));
  expect(row.n).toBe(2);
});

it('points expire on the daily job for every shop that set an expiry', async () => {
  await saveLoyaltySettings(db, owner, { loyaltyEnabled: true, pesewasPerPoint: 100, pointValuePesewas: 10, minRedeemPoints: 5, pointsExpiryMonths: 6, giftCardExpiryMonths: 0 });
  await sell('2', { customerId: ama, tenders: [{ id: randomUUID(), method: 'cash', amountPesewas: 1000 }] }); // 10 points
  expect(await expireAllPoints(db, new Date('2027-01-01T02:00:00Z'))).toBe(0); // not old enough
  await asPlatform(db, (tx) => tx.update(loyaltyEntries).set({ createdAt: new Date('2026-01-01T00:00:00Z') }).where(eq(loyaltyEntries.customerId, ama)));
  expect(await expireAllPoints(db, new Date('2027-01-01T02:00:00Z'))).toBe(10);
  expect(await expireAllPoints(db, new Date('2027-01-01T02:15:00Z'))).toBe(0); // a repeat run does nothing
});

it('stock clerk and accountant presets: goods only, or reading and money records only', async () => {
  expect(ROLE_PRESETS.stock_clerk).not.toContain('make_sale');
  expect(ROLE_PRESETS.stock_clerk).toEqual(expect.arrayContaining(['receive_stock', 'stock_count', 'transfer_stock']));
  expect(ROLE_PRESETS.accountant).toEqual(expect.arrayContaining(['view_reports', 'export_data']));
  expect(ROLE_PRESETS.accountant).not.toContain('make_sale');
  expect(await addStaff(db, owner, { name: 'Kwame', phone: '0201112222', rolePreset: 'stock_clerk', branchIds: [shop.branchId] }, t0)).toMatchObject({ ok: true });
  expect(await addStaff(db, owner, { name: 'Esi', email: 'esi@acc.test', rolePreset: 'accountant', branchIds: [shop.branchId] }, t0)).toMatchObject({ ok: true });
});

it('the API rate limit counts per key within a window', async () => {
  const hit = (now: Date) => asPlatform(db, (tx) => overLimit(tx, 'api:test', now, 3, 60_000));
  expect([await hit(t0), await hit(t0), await hit(t0), await hit(t0)]).toEqual([false, false, false, true]);
  expect(await hit(new Date(t0.getTime() + 61_000))).toBe(false); // a new window
});

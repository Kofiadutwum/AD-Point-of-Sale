import { createHmac, randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { afterEach, beforeEach, expect, it } from 'vitest';
import type { Db } from '@/db/client';
import { apiKeys, coupons, notifications, onlineOrders, payments, products, sales, shopCharges, shopDomains, stockBalances, tenants, variants, webhookDeliveries } from '@/db/schema';
import { asPlatform } from '@/db/tenant';
import { apiRead, authenticateKey, createApiKey, revokeApiKey } from '@/server/api-keys';
import type { Ctx } from '@/server/context';
import { exportData } from '@/server/data-export';
import { addDomain, slugForHost, verifyDomain } from '@/server/domains';
import {
  completeOnlineOrder, confirmTransfer, expireOnlineOrders, orderAwaitingPaystack, placeOnlineOrder, publicOrder, requestPhoneCode, saveOnlineOrderSettings, verifyPhoneCode,
} from '@/server/online-orders';
import type { Paystack, VerifiedTransaction } from '@/server/paystack';
import { completeSale } from '@/server/sales';
import { applyShopCharge, handleShopWebhook, saveShopPaystackKey, type ShopClient, startOrderCharge, startTillCharge } from '@/server/shop-paystack';
import { saveCoupon, savePromotion } from '@/server/promotions';
import { setPublished } from '@/server/storefront';
import { addEndpoint, checkEndpointUrl, privateAddress, runWebhookDeliveries, signDelivery } from '@/server/webhooks';
import { ctxFor, expectAccess, productFor, saleInput, type SeededShop, seedShop, stockFor, tillCtxFor } from '../helpers/fixtures';
import { createTestDb } from '../helpers/test-db';

const t0 = new Date('2026-11-26T09:00:00Z');
const KEY = `sk_test_${'a1'.repeat(20)}`; // a made-up test key
let db: Db;
let close: () => Promise<void>;
let shop: SeededShop;
let owner: Ctx;
let manager: Ctx;
let till: Ctx;
let p: { productId: string; variantId: string; baseUnitId: string };

/** A Paystack stand-in: initialize hands back a URL; verify answers whatever the test set. */
function fakePaystack() {
  const verified = new Map<string, Partial<VerifiedTransaction>>();
  const started: string[] = [];
  const client: Paystack = {
    async initialize(i) { started.push(i.reference); return { authorizationUrl: `https://checkout.paystack.test/${i.reference}` }; },
    async verify(reference) { return { status: 'pending', reference, amount: 0, currency: 'GHS', ...verified.get(reference) } as VerifiedTransaction; },
    async chargeAuthorization() { return { status: 'success' }; },
  };
  const shopClient: ShopClient = (key) => { if (key !== KEY) throw new Error('wrong key'); return client; };
  return { shopClient, verified, started };
}

beforeEach(async () => {
  ({ db, close } = await createTestDb());
  shop = await seedShop(db, { users: [
    { key: 'owner', email: 'o@int.test', password: 'correct-horse-1', rolePreset: 'owner' },
    { key: 'manager', phone: '0200000009', pin: '4321', rolePreset: 'manager' },
  ] });
  owner = await ctxFor(db, shop, 'owner', t0);
  manager = await ctxFor(db, shop, 'manager', t0);
  till = await tillCtxFor(db, shop, 'manager', t0);
  p = await productFor(db, owner); // GHS 5.00
  await stockFor(db, owner, shop.branchId, { variantId: p.variantId, unitId: p.baseUnitId, quantity: '10', totalCostPesewas: 3000 }, t0);
});
afterEach(async () => { await close(); });

const onHand = async () => (await asPlatform(db, (tx) => tx.select().from(stockBalances).where(eq(stockBalances.variantId, p.variantId))))[0];
const cashSale = (qty: string, cash: number) => completeSale(db, till, saleInput({
  lines: [{ variantId: p.variantId, unitId: p.baseUnitId, quantity: qty, unitPricePesewas: 500, discountPesewas: 0 }],
  tenders: [{ id: randomUUID(), method: 'cash', amountPesewas: cash }], deviceCreatedAt: t0.toISOString(),
}), t0);

it("the owner connects the shop's own Paystack key; it is sealed at rest and managers cannot touch it", async () => {
  expect(await saveShopPaystackKey(db, owner, 'pk_live_nope')).toEqual({ ok: false, error: 'invalid_key' });
  await expectAccess(saveShopPaystackKey(db, manager, KEY), 'forbidden');
  expect(await saveShopPaystackKey(db, owner, KEY)).toEqual({ ok: true });
  const [t] = await asPlatform(db, (tx) => tx.select().from(tenants).where(eq(tenants.id, shop.tenantId)));
  expect(t.paystackSecretSealed).not.toContain(KEY);
  expect(t.paystackKeyHint).toBe('sk_test_…a1a1');
});

it('a till charge becomes a sale only when Paystack verifies the right amount, exactly once', async () => {
  const fake = fakePaystack();
  const lines = (q: string) => ({ lines: [{ variantId: p.variantId, unitId: p.baseUnitId, quantity: q }] });
  expect(await startTillCharge(db, till, lines('2'), t0, fake.shopClient)).toEqual({ ok: false, error: 'not_connected' });
  await saveShopPaystackKey(db, owner, KEY);
  const c = await startTillCharge(db, till, lines('2'), t0, fake.shopClient);
  expect(c).toMatchObject({ ok: true, amountPesewas: 1000, authorizationUrl: expect.stringContaining('checkout.paystack.test') });
  const ref = (c as { reference: string }).reference;

  expect(await applyShopCharge(db, shop.tenantId, ref, t0, fake.shopClient)).toEqual({ outcome: 'pending' });
  expect(await asPlatform(db, (tx) => tx.select().from(sales))).toHaveLength(0); // nothing sold before the money is confirmed

  fake.verified.set(ref, { status: 'success', amount: 1000, channel: 'mobile_money' });
  const done = await applyShopCharge(db, shop.tenantId, ref, t0, fake.shopClient);
  expect(done).toMatchObject({ outcome: 'completed', saleId: expect.any(String) });
  expect(await applyShopCharge(db, shop.tenantId, ref, t0, fake.shopClient)).toEqual({ outcome: 'completed', saleId: done.saleId });
  expect(await asPlatform(db, (tx) => tx.select({ m: payments.method, a: payments.amountPesewas, r: payments.reference }).from(payments))).toEqual([{ m: 'paystack', a: 1000, r: ref }]);
  expect((await onHand()).onHand).toBe('8.000');

  // a different amount is never accepted
  const c2 = await startTillCharge(db, till, lines('1'), t0, fake.shopClient) as { reference: string };
  fake.verified.set(c2.reference, { status: 'success', amount: 100 });
  expect(await applyShopCharge(db, shop.tenantId, c2.reference, t0, fake.shopClient)).toEqual({ outcome: 'mismatch' });
  expect(await asPlatform(db, (tx) => tx.select().from(sales))).toHaveLength(1);
});

it("the shop webhook is checked with that shop's own key", async () => {
  const fake = fakePaystack();
  await saveShopPaystackKey(db, owner, KEY);
  const c = await startTillCharge(db, till, { lines: [{ variantId: p.variantId, unitId: p.baseUnitId, quantity: '1' }] }, t0, fake.shopClient) as { reference: string };
  fake.verified.set(c.reference, { status: 'success', amount: 500 });
  const raw = new TextEncoder().encode(JSON.stringify({ event: 'charge.success', data: { reference: c.reference } }));
  const sig = (k: string) => createHmac('sha512', k).update(raw).digest('hex');
  expect(await handleShopWebhook(db, shop.slug, raw, sig('sk_test_wrong'), t0, fake.shopClient)).toEqual({ status: 401 });
  expect(await handleShopWebhook(db, 'no-such-shop', raw, sig(KEY), t0, fake.shopClient)).toEqual({ status: 404 });
  expect(await handleShopWebhook(db, shop.slug, raw, sig(KEY), t0, fake.shopClient)).toEqual({ status: 200 });
  const [charge] = await asPlatform(db, (tx) => tx.select().from(shopCharges).where(eq(shopCharges.reference, c.reference)));
  expect(charge).toMatchObject({ status: 'success', saleId: expect.any(String) });
});

async function openForOrders() {
  await asPlatform(db, async (tx) => {
    await tx.update(products).set({ showOnStorefront: true }).where(eq(products.id, p.productId));
    await tx.update(tenants).set({ managerPhone: '233200000099' }).where(eq(tenants.id, shop.tenantId));
  });
  expect(await setPublished(db, owner, true)).toEqual({ ok: true });
  expect(await saveOnlineOrderSettings(db, owner, { enabled: true, expiryMinutes: 30, deliveryFeePesewas: 1500, transferInstructions: 'MoMo 024 000 0000' })).toEqual({ ok: true });
}

async function verifiedToken(phone = '0244000123') {
  let sent = '';
  const r = await requestPhoneCode(db, shop.slug, phone, t0, async (_to, text) => { sent = text; }) as { verificationId: string };
  const code = /(\d{6})/.exec(sent)![1];
  expect(await verifyPhoneCode(db, shop.slug, r.verificationId, code === '000000' ? '111111' : '000000', t0)).toEqual({ ok: false, error: 'wrong_code' });
  return ((await verifyPhoneCode(db, shop.slug, r.verificationId, code, t0)) as { token: string }).token;
}

it('online order: phone code first, stock reserved, transfer confirmed by staff, handed over as a sale', async () => {
  expect(await requestPhoneCode(db, shop.slug, '0244000123', t0, async () => {})).toEqual({ ok: false, error: 'closed' });
  await openForOrders();
  const order = { items: [{ productId: p.productId, quantity: 3 }], fulfilment: 'pickup' as const, name: 'Kofi', payMethod: 'transfer' as const, source: 'whatsapp' };
  expect(await placeOnlineOrder(db, shop.slug, { ...order, token: undefined }, '1.2.3.4', t0)).toEqual({ ok: false, error: 'phone_not_verified' });
  const token = await verifiedToken();
  expect(await placeOnlineOrder(db, shop.slug, { ...order, token, items: [{ productId: p.productId, quantity: 11 }] }, '1.2.3.4', t0)).toEqual({ ok: false, error: 'unavailable' });
  expect(await placeOnlineOrder(db, shop.slug, { ...order, token, payMethod: 'paystack' }, '1.2.3.4', t0)).toEqual({ ok: false, error: 'payment_unavailable' });
  const placed = await placeOnlineOrder(db, shop.slug, { ...order, token }, '1.2.3.4', t0);
  expect(placed).toMatchObject({ ok: true, number: 'WEB-0001', totalPesewas: 1500 });
  const orderId = (placed as { orderId: string }).orderId;
  expect((await onHand()).reserved).toBe('3.000');
  const [row] = await asPlatform(db, (tx) => tx.select().from(onlineOrders));
  expect(row).toMatchObject({ source: 'whatsapp', contactPhone: '233244000123', status: 'awaiting_payment' });

  expect(await confirmTransfer(db, manager, orderId, '', t0)).toEqual({ ok: false, error: 'reference_required' });
  expect(await confirmTransfer(db, manager, orderId, 'MOMO-778', t0)).toEqual({ ok: true });
  expect(await completeOnlineOrder(db, till, orderId, t0)).toMatchObject({ ok: true });
  const after = await onHand();
  expect([after.onHand, after.reserved]).toEqual(['7.000', '0.000']);
  expect(await asPlatform(db, (tx) => tx.select({ m: payments.method, a: payments.amountPesewas }).from(payments))).toEqual([{ m: 'bank_transfer', a: 1500 }]);
  const sms = (await asPlatform(db, (tx) => tx.select({ key: notifications.key }).from(notifications))).map((n) => n.key.split(':')[0]);
  expect(sms).toEqual(expect.arrayContaining(['online-new', 'online-received', 'online-confirmed']));
});

it('online order paid by Paystack is confirmed on verification; unpaid ones lapse and release their stock', async () => {
  const fake = fakePaystack();
  await openForOrders();
  await saveShopPaystackKey(db, owner, KEY);
  const token = await verifiedToken();
  const base = { fulfilment: 'delivery' as const, address: 'Osu, Accra', name: 'Kofi', payMethod: 'paystack' as const, token };
  const a = await placeOnlineOrder(db, shop.slug, { ...base, items: [{ productId: p.productId, quantity: 2 }] }, '1.2.3.4', t0) as { orderId: string; number: string; totalPesewas: number; tenantId: string };
  const url = await startOrderCharge(db, a.tenantId, shop.slug, { id: a.orderId, number: a.number, totalPesewas: a.totalPesewas }, fake.shopClient);
  expect(url).toContain('checkout.paystack.test');
  fake.verified.set(fake.started[0], { status: 'success', amount: 1000 });
  expect(await applyShopCharge(db, shop.tenantId, fake.started[0], t0, fake.shopClient)).toEqual({ outcome: 'completed' });

  const b = await placeOnlineOrder(db, shop.slug, { ...base, items: [{ productId: p.productId, quantity: 4 }] }, '1.2.3.4', t0) as { orderId: string };
  expect((await onHand()).reserved).toBe('6.000');
  expect(await expireOnlineOrders(db, new Date(t0.getTime() + 31 * 60_000))).toBe(1);
  const rows = await asPlatform(db, (tx) => tx.select({ id: onlineOrders.id, status: onlineOrders.status, delivery: onlineOrders.deliveryFeePesewas }).from(onlineOrders));
  expect(rows.find((r) => r.id === a.orderId)).toMatchObject({ status: 'confirmed', delivery: 1500 });
  expect(rows.find((r) => r.id === b.orderId)).toMatchObject({ status: 'expired' });
  expect((await onHand()).reserved).toBe('2.000');
});

it('webhooks: only public https endpoints; deliveries are signed, retried, and never sent to private addresses', async () => {
  expect(checkEndpointUrl('http://example.com/h')).toBeNull();
  expect(checkEndpointUrl('https://127.0.0.1/h')).toBeNull();
  expect(checkEndpointUrl('https://localhost/h')).toBeNull();
  expect(['10.0.0.1', '192.168.1.1', '169.254.169.254', '::1', '::ffff:127.0.0.1', 'fd00::1'].every(privateAddress)).toBe(true);
  expect(privateAddress('41.66.1.1')).toBe(false);
  expect(await addEndpoint(db, owner, { url: 'https://hooks.example.com/pos', events: ['nope'] })).toEqual({ ok: false, error: 'invalid_input' });
  const e = await addEndpoint(db, owner, { url: 'https://hooks.example.com/pos', events: ['sale.completed', 'stock.low'] }) as { secret: string };
  expect(e.secret).toMatch(/^whsec_/);
  await asPlatform(db, (tx) => tx.update(variants).set({ reorderLevel: '9' }).where(eq(variants.id, p.variantId)));
  await cashSale('2', 1000);
  const queued = await asPlatform(db, (tx) => tx.select().from(webhookDeliveries));
  expect(queued.map((d) => d.event).sort()).toEqual(['sale.completed', 'stock.low']); // 10 → 8 crosses the reorder level of 9

  const posted: Array<{ headers: Record<string, string>; body: string }> = [];
  expect(await runWebhookDeliveries(db, t0, { resolve: async () => ['10.0.0.5'], post: async () => ({ ok: true, status: 200 }) })).toEqual({ delivered: 0, failed: 2 });
  const later = new Date(t0.getTime() + 3 * 60_000);
  expect(await runWebhookDeliveries(db, later, { resolve: async () => ['41.66.1.1'], post: async (_u, init) => { posted.push(init); return { ok: true, status: 200 }; } })).toEqual({ delivered: 2, failed: 0 });
  const h = posted[0].headers;
  expect(h['x-webhook-signature']).toBe(signDelivery(e.secret, h['x-webhook-timestamp'], posted[0].body));
  expect(JSON.parse(posted.find((x) => x.body.includes('sale.completed'))!.body)).toMatchObject({ event: 'sale.completed', data: { totalPesewas: 1000 } });
});

it('API keys: shown once, scoped, revocable; sales need a short date range', async () => {
  const k = await createApiKey(db, owner, { name: 'Books', scopes: ['products:read'] }) as { key: string };
  expect(k.key).toMatch(/^ads_[0-9a-f]{8}_/);
  await expectAccess(createApiKey(db, manager, { name: 'x', scopes: ['products:read'] }), 'forbidden');
  expect(await authenticateKey(db, `Bearer ${k.key}`, t0)).toEqual({ tenantId: shop.tenantId, scopes: ['products:read'] });
  expect(await authenticateKey(db, `Bearer ${k.key.slice(0, -2)}xx`, t0)).toBeNull();
  const read = await apiRead(db, shop.tenantId, 'products', {});
  expect(read).toMatchObject({ ok: true, data: [expect.objectContaining({ pricePesewas: 500 })] });
  expect(JSON.stringify(read)).not.toMatch(/averageCost/);
  expect(await apiRead(db, shop.tenantId, 'sales', { from: '2026-01-01', to: '2026-11-26' })).toEqual({ ok: false, error: 'invalid_range' });
  const [row] = await asPlatform(db, (tx) => tx.select({ id: apiKeys.id }).from(apiKeys));
  expect(await revokeApiKey(db, owner, row.id, t0)).toEqual({ ok: true });
  expect(await authenticateKey(db, `Bearer ${k.key}`, t0)).toBeNull();
});

it('the general journal for accounting software balances each day', async () => {
  await cashSale('3', 2000); // GHS 15 sale, GHS 5 change
  const r = await exportData(db, owner, 'journal', { from: '2026-11-26', to: '2026-11-26' }) as { csv: string };
  const rows = r.csv.trim().split(/\r?\n/).slice(1).map((l) => l.split(','));
  const sum = (i: number) => rows.reduce((a, x) => a + Number(x[i] || 0), 0);
  expect(rows.length).toBeGreaterThan(1);
  expect(sum(3).toFixed(2)).toBe(sum(4).toFixed(2));
  expect(r.csv).toContain('Cash on hand,15.00');
});

it('custom domains go live only after the TXT record proves ownership', async () => {
  const d = await addDomain(db, owner, 'https://Shop.Example.com/') as { id: string };
  expect(await addDomain(db, owner, 'shop.example.com')).toEqual({ ok: false, error: 'taken' });
  expect(await slugForHost(db, 'shop.example.com')).toBeNull();
  expect(await verifyDomain(db, owner, d.id, t0, async () => [['something-else']])).toEqual({ ok: false, error: 'not_verified' });
  const [{ token }] = await asPlatform(db, (tx) => tx.select({ token: shopDomains.verifyToken }).from(shopDomains));
  expect(await verifyDomain(db, owner, d.id, t0, async (name) => (name === '_adsmartshop.shop.example.com' ? [[token]] : []))).toEqual({ ok: true });
  expect(await slugForHost(db, 'shop.example.com:443')).toBe(shop.slug);
});

it('a coupon on a till Paystack charge is priced in and used up only when the money is confirmed', async () => {
  const fake = fakePaystack();
  await saveShopPaystackKey(db, owner, KEY);
  const pr = await savePromotion(db, owner, { name: 'GHS 1 off', kind: 'amount_off', amountPesewas: 100, requiresCoupon: true }) as { promotionId: string };
  await saveCoupon(db, owner, { code: 'ONCE', promotionId: pr.promotionId, maxUses: 1 });
  const lines = [{ variantId: p.variantId, unitId: p.baseUnitId, quantity: '1' }];
  expect(await startTillCharge(db, till, { lines, couponCode: 'NOPE' }, t0, fake.shopClient)).toEqual({ ok: false, error: 'invalid_coupon' });
  const c = await startTillCharge(db, till, { lines, couponCode: 'once' }, t0, fake.shopClient) as { reference: string; amountPesewas: number };
  expect(c.amountPesewas).toBe(400);
  const used = async () => (await asPlatform(db, (tx) => tx.select({ n: coupons.usedCount }).from(coupons)))[0].n;
  expect(await used()).toBe(0);
  fake.verified.set(c.reference, { status: 'success', amount: 400 });
  expect(await applyShopCharge(db, shop.tenantId, c.reference, t0, fake.shopClient)).toMatchObject({ outcome: 'completed' });
  expect(await used()).toBe(1);
});

it('a visitor who left Paystack checkout can go back to it, and only for their own order', async () => {
  const fake = fakePaystack();
  await openForOrders();
  await saveShopPaystackKey(db, owner, KEY);
  const token = await verifiedToken();
  const a = await placeOnlineOrder(db, shop.slug, { token, fulfilment: 'pickup', name: 'Kofi', payMethod: 'paystack', items: [{ productId: p.productId, quantity: 1 }] }, '1.2.3.4', t0) as { orderId: string; number: string; totalPesewas: number; tenantId: string };
  expect((await publicOrder(db, shop.slug, a.orderId, token, t0))!.payUrl).toBeNull(); // checkout never opened
  expect(await orderAwaitingPaystack(db, shop.slug, a.orderId, token, t0)).toMatchObject({ id: a.orderId, totalPesewas: 500 });
  expect(await orderAwaitingPaystack(db, shop.slug, a.orderId, 'someone-else', t0)).toBeNull();
  await startOrderCharge(db, a.tenantId, shop.slug, { id: a.orderId, number: a.number, totalPesewas: a.totalPesewas }, fake.shopClient);
  expect((await publicOrder(db, shop.slug, a.orderId, token, t0))!.payUrl).toContain('checkout.paystack.test');
  expect(await publicOrder(db, shop.slug, a.orderId, 'someone-else', t0)).toBeNull();
});

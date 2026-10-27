import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { afterEach, beforeEach, expect, it } from 'vitest';
import type { Db } from '@/db/client';
import { channelReceivables, kitchenOrders, registers, sales, users } from '@/db/schema';
import { asPlatform } from '@/db/tenant';
import { saveChannel } from '@/server/channels';
import { type Ctx, requireContext } from '@/server/context';
import { createPriceList, setPriceListItem } from '@/server/price-lists';
import { completeSale, type SaleInput, type SaleResult } from '@/server/sales';
import { createSession } from '@/server/sessions';
import { ctxFor, foodShop, productFor, saleInput, type SeededShop, tillCtxFor } from '../helpers/fixtures';
import { createTestDb } from '../helpers/test-db';

const t = new Date('2026-10-26T12:00:00Z');
let db: Db;
let close: () => Promise<void>;
let shop: SeededShop & { packVariantId: string; packUnitId: string };
let owner: Ctx;
let till: Ctx;
let jollof: { variantId: string; baseUnitId: string };
let bolt: string;
let chowdeck: string;
let phone: string;
beforeEach(async () => {
  ({ db, close } = await createTestDb());
  shop = await foodShop(db, t, { users: [{ key: 'owner', email: 'o@x.test', rolePreset: 'owner' }, { key: 'cook', email: 'k@x.test', rolePreset: 'cashier' }] });
  owner = await ctxFor(db, shop, 'owner', t);
  jollof = await productFor(db, owner, { name: 'Jollof', variants: [{ basePricePesewas: 4500, costPesewas: 2000 }] });
  const { priceListId } = await createPriceList(db, owner, { name: 'Bolt prices', kind: 'wholesale', branchId: null, startsOn: null, endsOn: null }) as { priceListId: string };
  await setPriceListItem(db, owner, { priceListId, unitId: jollof.baseUnitId, minQuantity: '1', pricePesewas: 5000 });
  const channel = async (name: string, extra: object) => (await saveChannel(db, owner, {
    name, kind: 'delivery_app', priceListId: null, commissionBp: 0, collectedBy: 'shop', active: true, ...extra,
  }) as { channelId: string }).channelId;
  bolt = await channel('Bolt Food', { priceListId, commissionBp: 2250, collectedBy: 'app' });
  chowdeck = await channel('Chowdeck', { commissionBp: 2000, collectedBy: 'app' });
  phone = await channel('Phone', { kind: 'phone' });
  till = await tillCtxFor(db, shop, 'owner', t);
});
afterEach(async () => { await close(); });

let receipt = 0;
const jollofLine = (price = 5000) => ({ variantId: jollof.variantId, unitId: jollof.baseUnitId, quantity: '1', unitPricePesewas: price, discountPesewas: 0 });
const packLine = () => ({ variantId: shop.packVariantId, unitId: shop.packUnitId, quantity: '1', unitPricePesewas: 100, discountPesewas: 0 });
const settle = (amount: number, reference: string) => [{ id: randomUUID(), method: 'channel_settlement' as const, amountPesewas: amount, reference }];

function channelSale(channelId: string, food: Partial<NonNullable<SaleInput['food']>>, extra: Partial<SaleInput> = {}, registerCode = 'T1'): SaleInput {
  return saleInput({
    receiptNumber: `B1-${registerCode}-${String(++receipt + 700).padStart(6, '0')}`, lines: [jollofLine(), packLine()],
    food: { serviceMode: 'counter', diningOption: 'delivery', channelId, ...food }, deviceCreatedAt: t.toISOString(), ...extra,
  });
}
const boltSale = (orderId: string, registerCode = 'T1', extra: Partial<SaleInput> = {}) =>
  channelSale(bolt, { externalOrderId: orderId }, { tenders: settle(5100, orderId), ...extra }, registerCode);
const phoneSale = (food: Partial<NonNullable<SaleInput['food']>>) =>
  channelSale(phone, food, { lines: [jollofLine(4500), packLine()], tenders: [{ id: randomUUID(), method: 'cash', amountPesewas: 4600 }] });

const saleOf = async (r: SaleResult) => (await asPlatform(db, (tx) => tx.select().from(sales).where(eq(sales.id, (r as { saleId: string }).saleId))))[0];
const kitchenOrderOf = async (r: SaleResult) => (await asPlatform(db, (tx) => tx.select().from(kitchenOrders).where(eq(kitchenOrders.saleId, (r as { saleId: string }).saleId))))[0];

async function secondTill(code: string): Promise<Ctx> {
  const [reg] = await asPlatform(db, (tx) => tx.insert(registers).values({ tenantId: shop.tenantId, branchId: shop.branchId, name: code, registerCode: code }).returning());
  const { token } = await createSession(db, { tenantId: shop.tenantId, userId: shop.users.owner.id, kind: 'pin', registerId: reg.id }, t);
  return requireContext(db, { slug: shop.slug, sessionToken: token, permission: null }, t);
}

it('a Bolt Food order uses the channel prices, records commission, and owes a receivable', async () => {
  const r = await completeSale(db, till, boltSale('BF-123'), t);
  expect(r).toMatchObject({ ok: true, status: 'completed' });
  // GHS 50 jollof on the Bolt list + GHS 1 pack; 22.5% of 5100 = 1147.5 → 1148
  expect(await saleOf(r)).toMatchObject({ totalPesewas: 5100, channelId: bolt, externalOrderId: 'BF-123', commissionPesewas: 1148, needsReview: false });
  const owed = await asPlatform(db, (tx) => tx.select().from(channelReceivables));
  expect(owed).toMatchObject([{ channelId: bolt, expectedPesewas: 3952, payoutId: null }]);
  expect(await kitchenOrderOf(r)).toMatchObject({ channelId: bolt, needsPacking: true, diningOption: 'delivery' });
});

it('two tills entering one platform order at once make one sale', async () => {
  const tillB = await secondTill('T2');
  const [x, y] = await Promise.all([completeSale(db, till, boltSale('BF-123'), t), completeSale(db, tillB, boltSale('BF-123', 'T2'), t)]);
  expect([x, y].filter((r) => r.ok)).toHaveLength(1);
  expect([x, y].find((r) => !r.ok)).toEqual({ ok: false, error: 'channel_order_exists' });
});

it('an outbox duplicate is refused and held', async () => {
  await completeSale(db, till, boltSale('BF-9'), t);
  expect(await completeSale(db, till, boltSale(' BF-9 ', 'T1', { fromOfflineOutbox: true }), t)).toEqual({ ok: false, error: 'channel_order_exists' });
});

it('the same order ID on two channels is allowed', async () => {
  expect(await completeSale(db, till, boltSale('A1'), t)).toMatchObject({ ok: true });
  // Chowdeck has no price list: walk-in GHS 45 + GHS 1 pack
  const chow = channelSale(chowdeck, { externalOrderId: 'A1' }, { lines: [jollofLine(4500), packLine()], tenders: settle(4600, 'A1') });
  expect(await completeSale(db, till, chow, t)).toMatchObject({ ok: true });
});

it('an app-collected order must be paid by channel settlement', async () => {
  const cash = [{ id: randomUUID(), method: 'cash' as const, amountPesewas: 5100 }];
  expect(await completeSale(db, till, boltSale('BF-1', 'T1', { tenders: cash }), t)).toEqual({ ok: false, error: 'channel_settlement_required' });
  expect(await completeSale(db, till, boltSale('BF-1', 'T1', { tenders: settle(5000, 'BF-1') }), t)).toEqual({ ok: false, error: 'channel_settlement_required' });
  expect(await completeSale(db, till, channelSale(bolt, {}, { tenders: settle(5100, 'x') }), t)).toEqual({ ok: false, error: 'external_order_id_required' });
  const walkIn = saleInput({ receiptNumber: `B1-T1-${String(++receipt + 700).padStart(6, '0')}`, lines: [jollofLine(4500)], tenders: settle(4500, 'x'), deviceCreatedAt: t.toISOString() });
  expect(await completeSale(db, till, walkIn, t)).toEqual({ ok: false, error: 'invalid_tender' });
  const phoneSettled = channelSale(phone, { customer: { name: 'Ama', phone: '0241234567' }, pickupAt: '2026-10-26T13:00:00Z' }, { lines: [jollofLine(4500), packLine()], tenders: settle(4600, 'x') });
  expect(await completeSale(db, till, phoneSettled, t)).toEqual({ ok: false, error: 'invalid_tender' });
});

it('a phone order needs the customer and a pickup time or address', async () => {
  expect(await completeSale(db, till, phoneSale({ customer: { name: 'Ama', phone: '123' }, pickupAt: '2026-10-26T13:00:00Z' }), t)).toEqual({ ok: false, error: 'customer_details_required' });
  expect(await completeSale(db, till, phoneSale({ customer: { name: 'Ama', phone: '0241234567' } }), t)).toEqual({ ok: false, error: 'customer_details_required' });
  const r = await completeSale(db, till, phoneSale({ customer: { name: 'Ama', phone: '0241234567' }, deliveryAddress: 'GA-123-4567, near the Total station' }), t);
  expect(r).toMatchObject({ ok: true });
  expect(await saleOf(r)).toMatchObject({ channelId: phone, commissionPesewas: 0, externalOrderId: null });
  expect(await kitchenOrderOf(r)).toMatchObject({ customerName: 'Ama', customerPhone: '233241234567', deliveryAddress: 'GA-123-4567, near the Total station', needsPacking: true });
  expect(await asPlatform(db, (tx) => tx.select().from(channelReceivables))).toEqual([]);
});

it('channel orders need the permission and a takeaway or delivery option', async () => {
  await asPlatform(db, (tx) => tx.update(users).set({ permissions: ['make_sale'] }).where(eq(users.id, shop.users.cook.id)));
  const cook = await tillCtxFor(db, shop, 'cook', t);
  expect(await completeSale(db, cook, boltSale('BF-2'), t)).toEqual({ ok: false, error: 'channel_not_allowed' });
  expect(await completeSale(db, till, channelSale(bolt, { externalOrderId: 'BF-3', diningOption: 'eat_in' }, { lines: [jollofLine()], tenders: settle(5000, 'BF-3') }), t))
    .toEqual({ ok: false, error: 'dining_option_not_allowed' });
  expect(await completeSale(db, till, channelSale(randomUUID(), { externalOrderId: 'BF-4' }), t)).toEqual({ ok: false, error: 'unknown_channel' });
});

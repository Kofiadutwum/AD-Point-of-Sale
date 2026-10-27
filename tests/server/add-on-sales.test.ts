import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { afterEach, beforeEach, expect, it } from 'vitest';
import type { Db } from '@/db/client';
import { addOnOptions, saleLines, sales, stockBalances } from '@/db/schema';
import { asPlatform } from '@/db/tenant';
import { listAddOnGroups, saveAddOnGroup, setItemAddOnGroups } from '@/server/add-ons';
import type { Ctx } from '@/server/context';
import { saveChannel } from '@/server/channels';
import { listKitchenOrders } from '@/server/kitchen';
import { createPhoneOrder } from '@/server/phone-orders';
import { getReceipt } from '@/server/receipts';
import { completeSale, type SaleInput, type SaleResult } from '@/server/sales';
import { ctxFor, foodShop, productFor, saleInput, type SeededShop, tillCtxFor } from '../helpers/fixtures';
import { createTestDb } from '../helpers/test-db';

const t = new Date('2026-10-27T12:00:00Z');
let db: Db;
let close: () => Promise<void>;
let shop: SeededShop;
let s: SeededShop & { packVariantId: string; packUnitId: string };
let till: Ctx;
let jollof: { variantId: string; baseUnitId: string };
let chicken: string;
let ids: Record<'protein' | 'extras' | 'chicken' | 'fish' | 'egg', string>;
beforeEach(async () => {
  ({ db, close } = await createTestDb());
  shop = s = await foodShop(db, t);
  const owner = await ctxFor(db, shop, 'owner', t);
  jollof = await productFor(db, owner, { name: 'Jollof', variants: [{ basePricePesewas: 3000, costPesewas: 1500 }] });
  chicken = (await productFor(db, owner, { name: 'Chicken piece' })).variantId;
  const protein = await saveAddOnGroup(db, owner, { name: 'Protein', minChoices: 1, maxChoices: 1, options: [
    { name: 'Extra chicken', pricePesewas: 1000, ingredientVariantId: chicken, ingredientQuantity: '1' },
    { name: 'Fish', pricePesewas: 1200, ingredientVariantId: null, ingredientQuantity: null },
  ] }) as { groupId: string };
  const extras = await saveAddOnGroup(db, owner, { name: 'Extras', minChoices: 0, maxChoices: 3, options: [
    { name: 'Egg', pricePesewas: 300, ingredientVariantId: null, ingredientQuantity: null },
  ] }) as { groupId: string };
  await setItemAddOnGroups(db, owner, jollof.variantId, [protein.groupId, extras.groupId]);
  const groups = await listAddOnGroups(db, owner);
  const option = (name: string) => groups.flatMap((g) => g.options).find((o) => o.name === name)!.id;
  ids = { protein: protein.groupId, extras: extras.groupId, chicken: option('Extra chicken'), fish: option('Fish'), egg: option('Egg') };
  till = await tillCtxFor(db, shop, 'owner', t);
});
afterEach(async () => { await close(); });

let receipt = 0;
const line = (price: number, extra: Partial<SaleInput['lines'][number]> = {}) =>
  ({ variantId: jollof.variantId, unitId: jollof.baseUnitId, quantity: '1', unitPricePesewas: price, discountPesewas: 0, ...extra });
const sale = (l: SaleInput['lines'][number], extra: Partial<SaleInput> = {}) => saleInput({
  receiptNumber: `B1-T1-${String(++receipt + 300).padStart(6, '0')}`, deviceCreatedAt: t.toISOString(), lines: [l],
  tenders: [{ id: randomUUID(), method: 'cash', amountPesewas: 100000 }], ...extra,
});
const fishAndEgg = () => [{ groupId: ids.protein, optionId: ids.fish }, { groupId: ids.extras, optionId: ids.egg }];
const lineOf = async (r: SaleResult) => (await asPlatform(db, (tx) => tx.select().from(saleLines).where(eq(saleLines.saleId, (r as { saleId: string }).saleId))))[0];

it('jollof with fish and egg costs base + add-ons and is stored as sold', async () => {
  const r = await completeSale(db, till, sale(line(4500, { addOns: fishAndEgg(), note: ' no onions ' })), t);
  expect(r).toMatchObject({ ok: true });
  const l = await lineOf(r);
  expect(l).toMatchObject({ unitPricePesewas: 4500, note: 'no onions' });
  expect(l.addOns.map((a) => a.name)).toEqual(['Fish', 'Egg']);
  expect(await completeSale(db, till, sale(line(3000, { addOns: fishAndEgg() })), t)).toEqual({ ok: false, error: 'price_changed' });
});

it('a missing required add-on is refused', async () => {
  expect(await completeSale(db, till, sale(line(3300, { addOns: [{ groupId: ids.extras, optionId: ids.egg }] })), t)).toEqual({ ok: false, error: 'invalid_add_ons' });
  expect(await completeSale(db, till, sale(line(3000)), t)).toEqual({ ok: false, error: 'invalid_add_ons' });
});

it('an outbox sale with a removed add-on is kept for review', async () => {
  await asPlatform(db, (tx) => tx.update(addOnOptions).set({ active: false }).where(eq(addOnOptions.id, ids.egg)));
  expect(await completeSale(db, till, sale(line(4500, { addOns: fishAndEgg() })), t)).toEqual({ ok: false, error: 'invalid_add_ons' });
  const r = await completeSale(db, till, sale(line(4500, { addOns: fishAndEgg() }), { fromOfflineOutbox: true }), t);
  expect(r).toMatchObject({ ok: true });
  const [s] = await asPlatform(db, (tx) => tx.select().from(sales).where(eq(sales.id, (r as { saleId: string }).saleId)));
  expect(s.reviewReasons).toContain('add_ons_changed');
  expect((await lineOf(r)).addOns.map((a) => a.name)).toEqual(['Fish', 'Egg']);
});

it('add-on ingredients are deducted per plate', async () => {
  const r = await completeSale(db, till, sale(line(4000, { quantity: '2', addOns: [{ groupId: ids.protein, optionId: ids.chicken }] })), t);
  expect(r).toMatchObject({ ok: true });
  const [b] = await asPlatform(db, (tx) => tx.select({ q: stockBalances.onHand }).from(stockBalances).where(eq(stockBalances.variantId, chicken)));
  expect(b.q).toBe('-2.000');
});

it('the receipt and the kitchen show add-ons and the note', async () => {
  const r = await completeSale(db, till, sale(line(4500, { addOns: fishAndEgg(), note: 'no onions' }), { food: { serviceMode: 'counter', diningOption: 'eat_in' } }), t);
  const owner = await ctxFor(db, shop, 'owner', t);
  expect((await getReceipt(db, owner, (r as { saleId: string }).saleId, { reprint: false }))!.lines[0]).toMatchObject({ addOns: ['Fish', 'Egg'], note: 'no onions' });
  const k = await listKitchenOrders(db, owner, shop.branchId, t) as { ok: true; orders: Array<{ lines: unknown[] }> };
  expect(k.orders[0].lines[0]).toMatchObject({ name: 'Jollof', addOns: ['Fish', 'Egg'], note: 'no onions' });
});

it('collecting a phone order checks add-ons and notes', async () => {
  const owner = await ctxFor(db, shop, 'owner', t);
  const phone = (await saveChannel(db, owner, { name: 'Phone', kind: 'phone', priceListId: null, commissionBp: 0, collectedBy: 'shop', active: true }) as { channelId: string }).channelId;
  const order = (addOns: Array<{ groupId: string; optionId: string }>) => createPhoneOrder(db, till, {
    channelId: phone, diningOption: 'takeaway', customer: { name: 'Ama', phone: '0241234567' }, pickupAt: '2026-10-27T13:00:00Z',
    lines: [{ variantId: jollof.variantId, unitId: jollof.baseUnitId, quantity: '1', addOns, note: 'no onions' }],
  }, t);
  expect(await order([{ groupId: ids.extras, optionId: ids.egg }])).toEqual({ ok: false, error: 'invalid_add_ons' });
  const { kitchenOrderId } = await order(fishAndEgg()) as { kitchenOrderId: string };
  const pack = { variantId: s.packVariantId, unitId: s.packUnitId, quantity: '1', unitPricePesewas: 100, discountPesewas: 0 };
  const collect = (l: SaleInput['lines'][number]) => sale(l, { lines: [l, pack], food: { serviceMode: 'counter', diningOption: 'takeaway', channelId: phone, kitchenOrderId } });
  expect(await completeSale(db, till, collect(line(4200, { addOns: [{ groupId: ids.protein, optionId: ids.fish }], note: 'no onions' })), t)).toEqual({ ok: false, error: 'order_changed' });
  expect(await completeSale(db, till, collect(line(4500, { addOns: fishAndEgg() })), t)).toEqual({ ok: false, error: 'order_changed' });
  expect(await completeSale(db, till, collect(line(4500, { addOns: fishAndEgg(), note: 'no onions' })), t)).toMatchObject({ ok: true });
});

it('a note over 140 characters is refused', async () => {
  expect(await completeSale(db, till, sale(line(4200, { addOns: [{ groupId: ids.protein, optionId: ids.fish }], note: 'x'.repeat(141) })), t)).toEqual({ ok: false, error: 'invalid_input' });
});

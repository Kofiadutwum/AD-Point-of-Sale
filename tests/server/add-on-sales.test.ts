import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { afterEach, beforeEach, expect, it } from 'vitest';
import type { Db } from '@/db/client';
import { addOnOptions, saleLines, sales, stockBalances } from '@/db/schema';
import { asPlatform } from '@/db/tenant';
import { listAddOnGroups, saveAddOnGroup, setItemAddOnGroups } from '@/server/add-ons';
import type { Ctx } from '@/server/context';
import { completeSale, type SaleInput, type SaleResult } from '@/server/sales';
import { ctxFor, foodShop, productFor, saleInput, type SeededShop, tillCtxFor } from '../helpers/fixtures';
import { createTestDb } from '../helpers/test-db';

const t = new Date('2026-10-27T12:00:00Z');
let db: Db;
let close: () => Promise<void>;
let shop: SeededShop;
let till: Ctx;
let jollof: { variantId: string; baseUnitId: string };
let chicken: string;
let ids: Record<'protein' | 'extras' | 'chicken' | 'fish' | 'egg', string>;
beforeEach(async () => {
  ({ db, close } = await createTestDb());
  shop = await foodShop(db, t);
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

it('a note over 140 characters is refused', async () => {
  expect(await completeSale(db, till, sale(line(4200, { addOns: [{ groupId: ids.protein, optionId: ids.fish }], note: 'x'.repeat(141) })), t)).toEqual({ ok: false, error: 'invalid_input' });
});

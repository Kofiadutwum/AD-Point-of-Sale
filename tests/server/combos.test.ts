import { randomUUID } from 'node:crypto';
import { afterEach, beforeEach, expect, it } from 'vitest';
import type { Db } from '@/db/client';
import { getComboSlots, saveComboSlots } from '@/server/combos';
import type { Ctx } from '@/server/context';
import { createProduct } from '@/server/products';
import { completeSale } from '@/server/sales';
import { addComponent, updateVariant } from '@/server/variants';
import { ctxFor, foodShop, productFor, saleInput, type SeededShop, seedShop, tillCtxFor } from '../helpers/fixtures';
import { createTestDb } from '../helpers/test-db';

const t0 = new Date('2026-10-26T10:00:00Z');
let db: Db;
let close: () => Promise<void>;
let shop: SeededShop;
let owner: Ctx;
beforeEach(async () => {
  ({ db, close } = await createTestDb());
  shop = await foodShop(db, t0);
  owner = await ctxFor(db, shop, 'owner', t0);
});
afterEach(async () => { await close(); });

async function combo(name = 'Meal 2') {
  const r = await createProduct(db, owner, { name, kind: 'combo', tracking: 'none', baseUnit: 'meal', allowsFractions: false, variants: [{ basePricePesewas: 4500, costPesewas: 0 }] });
  if (!r.ok) throw new Error(r.error);
  return { productId: r.productId, variantId: r.variants[0].variantId };
}
const drinks = async () => [await productFor(db, owner, { name: 'Coke' }), await productFor(db, owner, { name: 'Large Coke' })];

it('creates a combo product with fixed items', async () => {
  const meal = await combo();
  await productFor(db, owner, { name: 'Chicken piece', variants: [{ sku: 'CHK', basePricePesewas: 1500, costPesewas: 800 }] });
  expect(await addComponent(db, owner, meal.variantId, { code: 'CHK', quantity: '2' })).toMatchObject({ ok: true });
  expect(await createProduct(db, owner, { name: 'Bad', kind: 'combo', tracking: 'none', baseUnit: 'meal', allowsFractions: true, variants: [{ basePricePesewas: 1, costPesewas: 0 }] }))
    .toMatchObject({ ok: false, error: 'invalid_input' });
});

it('saves slots and choices and replaces them on save', async () => {
  const meal = await combo();
  const [coke, large] = await drinks();
  expect(await saveComboSlots(db, owner, meal.variantId, [
    { name: 'Drink', minChoices: 1, maxChoices: 1, choices: [{ variantId: coke.variantId, upgradePesewas: 0 }, { variantId: large.variantId, upgradePesewas: 500 }] },
  ])).toEqual({ ok: true });
  expect(await getComboSlots(db, owner, meal.variantId)).toMatchObject([
    { name: 'Drink', minChoices: 1, maxChoices: 1, choices: [{ variantId: coke.variantId, upgradePesewas: 0 }, { variantId: large.variantId, upgradePesewas: 500 }],
      choiceNames: { [coke.variantId]: 'Coke', [large.variantId]: 'Large Coke' } },
  ]);
  await saveComboSlots(db, owner, meal.variantId, [{ name: 'Side', minChoices: 0, maxChoices: 1, choices: [{ variantId: coke.variantId, upgradePesewas: 0 }] }]);
  expect((await getComboSlots(db, owner, meal.variantId)).map((s) => s.name)).toEqual(['Side']);
});

it('refuses a combo as a choice', async () => {
  const meal = await combo();
  const other = await combo('Meal 3');
  expect(await saveComboSlots(db, owner, meal.variantId, [{ name: 'Add', minChoices: 0, maxChoices: 1, choices: [{ variantId: other.variantId, upgradePesewas: 0 }] }]))
    .toMatchObject({ ok: false, error: 'nested_combo' });
});

it("refuses another shop's variant as a choice", async () => {
  const meal = await combo();
  const foreign = await productFor(db, await ctxFor(db, await seedShop(db, { shopType: 'food' }), 'owner', t0));
  expect(await saveComboSlots(db, owner, meal.variantId, [{ name: 'Drink', minChoices: 1, maxChoices: 1, choices: [{ variantId: foreign.variantId, upgradePesewas: 0 }] }]))
    .toMatchObject({ ok: false, error: 'unknown_item' });
});

it('refuses min above max or no choices', async () => {
  const meal = await combo();
  const [coke] = await drinks();
  expect(await saveComboSlots(db, owner, meal.variantId, [{ name: 'Drink', minChoices: 2, maxChoices: 1, choices: [{ variantId: coke.variantId, upgradePesewas: 0 }] }]))
    .toMatchObject({ ok: false, error: 'invalid_input' });
  expect(await saveComboSlots(db, owner, meal.variantId, [{ name: 'Drink', minChoices: 1, maxChoices: 1, choices: [] }])).toMatchObject({ ok: false, error: 'invalid_input' });
  const plain = await productFor(db, owner);
  expect(await saveComboSlots(db, owner, plain.variantId, [{ name: 'Drink', minChoices: 1, maxChoices: 1, choices: [{ variantId: coke.variantId, upgradePesewas: 0 }] }]))
    .toMatchObject({ ok: false, error: 'not_a_combo' });
});

const fields = { name: '', sku: null, basePricePesewas: 1000, costPesewas: null, reorderLevel: null, sellable: true, allowsFractions: false };

it('saves sell-by-amount with a minimum and value per pot', async () => {
  const rice = await productFor(db, owner, { name: 'Jollof rice' });
  expect(await updateVariant(db, owner, rice.variantId, { ...fields, sellByAmount: true, minAmountPesewas: 500, valuePerPotPesewas: 60000 })).toEqual({ ok: true });
  expect(await updateVariant(db, owner, rice.variantId, { ...fields, sellByAmount: true, minAmountPesewas: null, valuePerPotPesewas: null })).toMatchObject({ ok: false, error: 'invalid_input' });
});

it('refuses sell by amount on a bundle or combo', async () => {
  const meal = await combo();
  expect(await updateVariant(db, owner, meal.variantId, { ...fields, sellByAmount: true, minAmountPesewas: 500, valuePerPotPesewas: null })).toMatchObject({ ok: false, error: 'invalid_input' });
});

it('refuses switching sell by amount once the item has sales', async () => {
  const rice = await productFor(db, owner, { name: 'Waakye' });
  const till = await tillCtxFor(db, shop, 'owner', t0);
  expect(await completeSale(db, till, saleInput({ saleId: randomUUID(), lines: [{ variantId: rice.variantId, unitId: rice.baseUnitId, quantity: '1', unitPricePesewas: 500, discountPesewas: 0 }] }), t0))
    .toMatchObject({ ok: true });
  expect(await updateVariant(db, owner, rice.variantId, { ...fields, basePricePesewas: 500, sellByAmount: true, minAmountPesewas: 500, valuePerPotPesewas: null }))
    .toMatchObject({ ok: false, error: 'in_use' });
});

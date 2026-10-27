import { eq } from 'drizzle-orm';
import { afterEach, beforeEach, expect, it } from 'vitest';
import { variants } from '@/db/schema';
import { asPlatform } from '@/db/tenant';
import type { Db } from '@/db/client';
import { getItemAddOnGroups, listAddOnGroups, listIngredientItems, saveAddOnGroup, setItemAddOnGroups } from '@/server/add-ons';
import { updateVariant } from '@/server/variants';
import type { Ctx } from '@/server/context';
import { createProduct } from '@/server/products';
import { ctxFor, expectAccess, productFor, type SeededShop, seedShop } from '../helpers/fixtures';
import { createTestDb } from '../helpers/test-db';

const t0 = new Date('2026-10-27T10:00:00Z');
let db: Db;
let close: () => Promise<void>;
let shop: SeededShop;
let owner: Ctx;
let chicken: string;
beforeEach(async () => {
  ({ db, close } = await createTestDb());
  shop = await seedShop(db, { shopType: 'food', users: [
    { key: 'owner', email: 'o@x.test', rolePreset: 'owner' }, { key: 'cashier', email: 'c@x.test', rolePreset: 'cashier' },
  ] });
  owner = await ctxFor(db, shop, 'owner', t0);
  chicken = (await productFor(db, owner, { name: 'Chicken piece' })).variantId;
});
afterEach(async () => { await close(); });

const protein = () => ({
  name: 'Protein', minChoices: 1, maxChoices: 1, options: [
    { name: 'Chicken', pricePesewas: 1000, ingredientVariantId: chicken, ingredientQuantity: '1' },
    { name: 'Fish', pricePesewas: 1200, ingredientVariantId: null, ingredientQuantity: null },
  ],
});

it('saves a Protein group with priced options and an ingredient', async () => {
  const r = await saveAddOnGroup(db, owner, protein());
  expect(r).toMatchObject({ ok: true });
  expect(await listAddOnGroups(db, owner)).toMatchObject([{
    name: 'Protein', minChoices: 1, maxChoices: 1, options: [
      { name: 'Chicken', pricePesewas: 1000, ingredientVariantId: chicken, ingredientQuantity: '1.000', active: true },
      { name: 'Fish', pricePesewas: 1200, ingredientVariantId: null, active: true },
    ],
  }]);
});

it('an option left out becomes inactive and keeps its id', async () => {
  const { groupId } = await saveAddOnGroup(db, owner, protein()) as { groupId: string };
  const [g] = await listAddOnGroups(db, owner);
  const fish = g.options[1];
  expect(await saveAddOnGroup(db, owner, { ...protein(), id: groupId, options: [{ ...fish, pricePesewas: 1300 }] })).toEqual({ ok: true, groupId });
  const [after] = await listAddOnGroups(db, owner);
  expect(after.options).toMatchObject([{ id: g.options[0].id, active: false }, { id: fish.id, pricePesewas: 1300, active: true }]);
  expect(await saveAddOnGroup(db, owner, { ...protein(), name: 'PROTEIN' })).toMatchObject({ ok: false, error: 'duplicate_name' });
});

it('refuses a combo as an ingredient', async () => {
  const meal = await createProduct(db, owner, { name: 'Meal 2', kind: 'combo', tracking: 'none', baseUnit: 'meal', allowsFractions: false, variants: [{ basePricePesewas: 4500, costPesewas: 0 }] });
  const mealId = (meal as { variants: Array<{ variantId: string }> }).variants[0].variantId;
  const bad = { ...protein(), options: [{ name: 'Meal', pricePesewas: 0, ingredientVariantId: mealId, ingredientQuantity: '1' }] };
  expect(await saveAddOnGroup(db, owner, bad)).toMatchObject({ ok: false, error: 'unknown_item' });
});

it('links groups to an item in order and refuses combos', async () => {
  const p = (await saveAddOnGroup(db, owner, protein()) as { groupId: string }).groupId;
  const e = (await saveAddOnGroup(db, owner, { name: 'Extras', minChoices: 0, maxChoices: 3, options: [{ name: 'Egg', pricePesewas: 300, ingredientVariantId: null, ingredientQuantity: null }] }) as { groupId: string }).groupId;
  const jollof = (await productFor(db, owner, { name: 'Jollof' })).variantId;
  expect(await setItemAddOnGroups(db, owner, jollof, [e, p])).toEqual({ ok: true });
  expect(await getItemAddOnGroups(db, owner, jollof)).toEqual([e, p]);
  expect(await setItemAddOnGroups(db, owner, jollof, [p, p])).toMatchObject({ ok: false, error: 'invalid_input' });
  const meal = await createProduct(db, owner, { name: 'Meal 3', kind: 'combo', tracking: 'none', baseUnit: 'meal', allowsFractions: false, variants: [{ basePricePesewas: 4500, costPesewas: 0 }] });
  expect(await setItemAddOnGroups(db, owner, (meal as { variants: Array<{ variantId: string }> }).variants[0].variantId, [p])).toMatchObject({ ok: false, error: 'not_allowed' });
});

it('offers ingredients that are not sold on their own', async () => {
  const raw = await productFor(db, owner, { name: 'Raw chicken' });
  await asPlatform(db, (tx) => tx.update(variants).set({ sellable: false }).where(eq(variants.id, raw.variantId)));
  expect((await listIngredientItems(db, owner)).map((i) => i.variantId)).toContain(raw.variantId);
});

it('turning on sell by amount removes the item from its add-on groups', async () => {
  const p = (await saveAddOnGroup(db, owner, protein()) as { groupId: string }).groupId;
  const rice = (await productFor(db, owner, { name: 'Rice' })).variantId;
  await setItemAddOnGroups(db, owner, rice, [p]);
  const fields = { name: '', sku: null, basePricePesewas: 1000, costPesewas: null, reorderLevel: null, sellable: true, allowsFractions: false };
  expect(await updateVariant(db, owner, rice, { ...fields, sellByAmount: true, minAmountPesewas: 500, valuePerPotPesewas: 60000 })).toEqual({ ok: true });
  expect(await getItemAddOnGroups(db, owner, rice)).toEqual([]);
});

it('a cashier cannot change add-ons', async () => {
  await expectAccess(saveAddOnGroup(db, await ctxFor(db, shop, 'cashier', t0), protein()), 'forbidden');
});

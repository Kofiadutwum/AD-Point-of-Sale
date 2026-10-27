import { eq } from 'drizzle-orm';
import { afterEach, beforeEach, expect, it } from 'vitest';
import type { Db } from '@/db/client';
import { stockBalances, wastageEntries } from '@/db/schema';
import { asPlatform } from '@/db/tenant';
import type { Ctx } from '@/server/context';
import { createProduct } from '@/server/products';
import { addComponent, updateVariant } from '@/server/variants';
import { listWastableItems, recordWastage } from '@/server/wastage';
import { ctxFor, foodShop, productFor, type SeededShop, seedShop, tillCtxFor } from '../helpers/fixtures';
import { createTestDb } from '../helpers/test-db';

const t0 = new Date('2026-10-26T12:00:00Z');
let db: Db;
let close: () => Promise<void>;
let shop: SeededShop;
let owner: Ctx;
let till: Ctx;
beforeEach(async () => {
  ({ db, close } = await createTestDb());
  shop = await foodShop(db, t0);
  owner = await ctxFor(db, shop, 'owner', t0);
  till = await tillCtxFor(db, shop, 'owner', t0);
});
afterEach(async () => { await close(); });

const onHand = async (variantId: string) => (await asPlatform(db, (tx) => tx.select({ q: stockBalances.onHand }).from(stockBalances)
  .where(eq(stockBalances.variantId, variantId))))[0]?.q ?? '0.000';
const recipe = async (name: string, kind: 'recipe' | 'combo') => {
  const r = await createProduct(db, owner, { name, kind, tracking: 'none', baseUnit: 'plate', allowsFractions: false, variants: [{ basePricePesewas: 3000, costPesewas: 0 }] });
  return (r as { variants: Array<{ variantId: string }> }).variants[0];
};

it('records a staff meal of a recipe and deducts its ingredients', async () => {
  const chicken = await productFor(db, owner, { name: 'Chicken', variants: [{ sku: 'CHK', basePricePesewas: 1500, costPesewas: 800 }] });
  const meal = await recipe('Staff plate', 'recipe');
  await addComponent(db, owner, meal.variantId, { code: 'CHK', quantity: '2' });
  expect(await recordWastage(db, till, { branchId: shop.branchId, variantId: meal.variantId, quantity: '1', reason: 'staff_meal', note: 'Ama lunch' }, t0))
    .toEqual({ ok: true, costPesewas: 1600 });
  expect(await onHand(chicken.variantId)).toBe('-2.000');
  const [w] = await asPlatform(db, (tx) => tx.select().from(wastageEntries));
  expect(w).toMatchObject({ reason: 'staff_meal', quantity: '1.000', costPesewas: 1600, note: 'Ama lunch', businessDate: '2026-10-26' });
});

it('records spoiled stock of a plain item with its cost', async () => {
  const tomatoes = await productFor(db, owner, { name: 'Tomatoes', baseUnit: 'kg', allowsFractions: true, variants: [{ basePricePesewas: 2000, costPesewas: 1200 }] });
  expect(await recordWastage(db, till, { branchId: shop.branchId, variantId: tomatoes.variantId, quantity: '1.5', reason: 'spoiled' }, t0))
    .toEqual({ ok: true, costPesewas: 1800 });
  expect(await onHand(tomatoes.variantId)).toBe('-1.500');
});

it('refuses a combo or a sell-by-amount item', async () => {
  const combo = await recipe('Meal 2', 'combo');
  expect(await recordWastage(db, till, { branchId: shop.branchId, variantId: combo.variantId, quantity: '1', reason: 'dropped' }, t0)).toEqual({ ok: false, error: 'not_wastable' });
  const rice = await productFor(db, owner, { name: 'Jollof rice' });
  await updateVariant(db, owner, rice.variantId, { name: '', sku: null, basePricePesewas: 500, costPesewas: null, reorderLevel: null, sellable: true, allowsFractions: false,
    sellByAmount: true, minAmountPesewas: 500 });
  expect(await recordWastage(db, till, { branchId: shop.branchId, variantId: rice.variantId, quantity: '1', reason: 'dropped' }, t0)).toEqual({ ok: false, error: 'use_pot_leftover' });
  const loose = await productFor(db, owner, { name: 'Bottle' });
  expect(await recordWastage(db, till, { branchId: shop.branchId, variantId: loose.variantId, quantity: '0.5', reason: 'dropped' }, t0)).toEqual({ ok: false, error: 'invalid_input' });
});

it('refuses another branch', async () => {
  const other = await seedShop(db, { shopType: 'food' });
  const item = await productFor(db, owner);
  expect(await recordWastage(db, till, { branchId: other.branchId, variantId: item.variantId, quantity: '1', reason: 'spoiled' }, t0)).toEqual({ ok: false, error: 'not_assigned' });
});

it('offers plain items and recipes for wastage, not combos or by-amount items', async () => {
  await recipe('Meal 2', 'combo');
  await productFor(db, owner, { name: 'Tomatoes' });
  const list = (await listWastableItems(db, till)).map((i) => i.label);
  expect(list).toContain('Tomatoes');
  expect(list).not.toContain('Meal 2');
});

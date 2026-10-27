import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Db } from '@/db/client';
import { branches, kitchenOrders, registers, saleLines, sales, stockBalances, tenants, users } from '@/db/schema';
import { asPlatform } from '@/db/tenant';
import { getComboSlots, saveComboSlots } from '@/server/combos';
import { type Ctx, requireContext } from '@/server/context';
import { createProduct } from '@/server/products';
import { completeSale, type SaleInput, type SaleResult } from '@/server/sales';
import { createSession } from '@/server/sessions';
import { markSoldOut } from '@/server/sold-out';
import { addComponent, updateVariant } from '@/server/variants';
import { ctxFor, foodShop, productFor, saleInput, type SeededShop, tillCtxFor } from '../helpers/fixtures';
import { createTestDb } from '../helpers/test-db';

const t = new Date('2026-10-26T12:00:00Z');
let db: Db;
let close: () => Promise<void>;
let shop: SeededShop & { packVariantId: string; packUnitId: string };
let till: Ctx;
let jollof: { variantId: string; baseUnitId: string };
beforeEach(async () => {
  ({ db, close } = await createTestDb());
  shop = await foodShop(db, t);
  jollof = await productFor(db, await ctxFor(db, shop, 'owner', t), { name: 'Jollof', variants: [{ basePricePesewas: 3000, costPesewas: 1500 }] });
  till = await tillCtxFor(db, shop, 'owner', t);
});
afterEach(async () => { await close(); });

let receipt = 0;
const food = (o: Partial<NonNullable<SaleInput['food']>> = {}): NonNullable<SaleInput['food']> => ({ serviceMode: 'counter', diningOption: 'eat_in', ...o });
const jollofLine = (quantity = '1') => ({ variantId: jollof.variantId, unitId: jollof.baseUnitId, quantity, unitPricePesewas: 3000, discountPesewas: 0 });
const packLine = (quantity = '1') => ({ variantId: shop.packVariantId, unitId: shop.packUnitId, quantity, unitPricePesewas: 100, discountPesewas: 0 });

function counterSale(registerCode = 'T1', extra: Partial<SaleInput> = {}): SaleInput {
  return saleInput({
    receiptNumber: `B1-${registerCode}-${String(++receipt + 500).padStart(6, '0')}`, lines: [jollofLine()], food: food(),
    deviceCreatedAt: t.toISOString(), ...extra,
  });
}

const kitchenOrderOf = async (r: SaleResult) => (await asPlatform(db, (tx) => tx.select().from(kitchenOrders)
  .where(eq(kitchenOrders.saleId, (r as { saleId: string }).saleId))))[0];
const saleOf = async (r: SaleResult) => (await asPlatform(db, (tx) => tx.select().from(sales).where(eq(sales.id, (r as { saleId: string }).saleId))))[0];

async function secondTill(code: string, branchId = shop.branchId): Promise<Ctx> {
  const [reg] = await asPlatform(db, (tx) => tx.insert(registers).values({ tenantId: shop.tenantId, branchId, name: code, registerCode: code }).returning());
  const { token } = await createSession(db, { tenantId: shop.tenantId, userId: shop.users.owner.id, kind: 'pin', registerId: reg.id }, t);
  return requireContext(db, { slug: shop.slug, sessionToken: token, permission: null }, t);
}

it('a counter sale gets the next number and a preparing kitchen order', async () => {
  const r1 = await completeSale(db, till, counterSale(), t);
  const r2 = await completeSale(db, till, counterSale(), t);
  expect([r1, r2].map((r) => r.ok && r.orderNumber)).toEqual(['001', '002']);
  expect(await kitchenOrderOf(r1)).toMatchObject({ status: 'preparing', orderNumber: '001', needsPacking: false, businessDate: '2026-10-26' });
  expect(await saleOf(r1)).toMatchObject({ serviceMode: 'counter', diningOption: 'eat_in', orderNumber: '001' });
});

it('numbers restart each business day per branch', async () => {
  const day1 = await completeSale(db, till, counterSale(), t);
  await completeSale(db, till, counterSale(), t);
  const next = new Date('2026-10-27T12:00:00Z');
  const day2 = await completeSale(db, till, counterSale('T1', { deviceCreatedAt: next.toISOString() }), next);
  const [b2] = await asPlatform(db, (tx) => tx.insert(branches).values({ tenantId: shop.tenantId, name: 'Kumasi', branchCode: 'B2', serviceModes: ['counter'] }).returning());
  await asPlatform(db, (tx) => tx.update(users).set({ branchIds: [shop.branchId, b2.id] }).where(eq(users.id, shop.users.owner.id)));
  const tillB2 = await secondTill('T9', b2.id);
  const otherBranch = await completeSale(db, tillB2, counterSale('T9', { receiptNumber: 'B2-T9-000001' }), t);
  expect([day1, day2, otherBranch].map((r) => r.ok && r.orderNumber)).toEqual(['001', '001', '001']);
});

it('a quick serve sale gets no number and no kitchen order', async () => {
  const r = await completeSale(db, till, counterSale('T1', { food: food({ serviceMode: 'quick', diningOption: 'takeaway' }) }), t);
  expect(r).toMatchObject({ ok: true, orderNumber: null });
  expect(await kitchenOrderOf(r)).toBeUndefined();
  expect(await saleOf(r)).toMatchObject({ serviceMode: 'quick', diningOption: 'eat_in', orderNumber: null }); // quick serve is always eat in
});

it('keeps a device number from an offline till', async () => {
  const r = await completeSale(db, till, counterSale('T1', { food: food({ orderNumber: 'T1-005' }), fromOfflineOutbox: true }), t);
  expect(r).toMatchObject({ ok: true, orderNumber: 'T1-005' });
  expect(await kitchenOrderOf(r)).toMatchObject({ orderNumber: 'T1-005' });
});

it("refuses an order number with another till's prefix or no prefix", async () => {
  expect(await completeSale(db, till, counterSale('T1', { food: food({ orderNumber: 'T9-005' }) }), t)).toEqual({ ok: false, error: 'invalid_order_number' });
  expect(await completeSale(db, till, counterSale('T1', { food: food({ orderNumber: '005' }) }), t)).toEqual({ ok: false, error: 'invalid_order_number' });
});

it('a repeat with a device order number replaces the stored one', async () => {
  const input = counterSale();
  await completeSale(db, till, input, t); // server gave '001'
  const again = await completeSale(db, till, { ...input, food: { ...input.food!, orderNumber: 'T1-004' }, fromOfflineOutbox: true }, t);
  expect(again).toMatchObject({ ok: true, alreadyExisted: true, orderNumber: 'T1-004' });
  expect(await kitchenOrderOf(again)).toMatchObject({ orderNumber: 'T1-004' });
});

it('refuses a sold-out item online and flags it from the outbox', async () => {
  await markSoldOut(db, till, { branchId: shop.branchId, variantId: jollof.variantId }, t);
  expect(await completeSale(db, till, counterSale(), t)).toEqual({ ok: false, error: 'sold_out' });
  const r = await completeSale(db, till, counterSale('T1', { fromOfflineOutbox: true }), t);
  expect(r).toMatchObject({ ok: true });
  expect((await saleOf(r)).reviewReasons).toContain('sold_out');
});

it('refuses a takeaway sale with the wrong pack quantity', async () => {
  expect(await completeSale(db, till, counterSale('T1', { food: food({ diningOption: 'takeaway' }) }), t)).toEqual({ ok: false, error: 'pack_fee_mismatch' });
  expect(await completeSale(db, till, counterSale('T1', { food: food({ diningOption: 'takeaway' }), lines: [jollofLine(), packLine('2')] }), t))
    .toEqual({ ok: false, error: 'pack_fee_mismatch' });
  expect(await completeSale(db, till, counterSale('T1', { food: food({ diningOption: 'takeaway' }), lines: [jollofLine(), packLine()] }), t)).toMatchObject({ ok: true });
  expect(await completeSale(db, till, counterSale('T1', { lines: [jollofLine(), packLine()] }), t)).toEqual({ ok: false, error: 'pack_fee_mismatch' });
});

it('a takeaway counter order needs packing', async () => {
  const r = await completeSale(db, till, counterSale('T1', { food: food({ diningOption: 'takeaway' }), lines: [jollofLine(), packLine()] }), t);
  expect(await kitchenOrderOf(r)).toMatchObject({ needsPacking: true, diningOption: 'takeaway' });
});

it('refuses a service mode the branch does not use', async () => {
  await asPlatform(db, (tx) => tx.update(branches).set({ serviceModes: ['counter'] }).where(eq(branches.id, shop.branchId)));
  expect(await completeSale(db, till, counterSale('T1', { food: food({ serviceMode: 'quick' }) }), t)).toEqual({ ok: false, error: 'service_mode_not_allowed' });
});

it('refuses a food block when the kitchen module is off', async () => {
  await asPlatform(db, (tx) => tx.update(tenants).set({ modules: ['recipes'] }).where(eq(tenants.id, shop.tenantId)));
  expect(await completeSale(db, till, counterSale(), t)).toEqual({ ok: false, error: 'invalid_input' });
});

it('two counter sales at once get different numbers', async () => {
  const tillB = await secondTill('T2');
  const [x, y] = await Promise.all([completeSale(db, till, counterSale(), t), completeSale(db, tillB, counterSale('T2'), t)]);
  expect(new Set([x, y].map((r) => r.ok && r.orderNumber)).size).toBe(2);
});

it('a sale without a food block is unchanged', async () => {
  const r = await completeSale(db, till, saleInput({ receiptNumber: `B1-T1-${String(900 + ++receipt).padStart(6, '0')}`, lines: [jollofLine()], saleId: randomUUID() }), t);
  expect(r).toMatchObject({ ok: true, orderNumber: null });
  expect(await kitchenOrderOf(r)).toBeUndefined();
});

it("an online order from a till whose clock is behind lands on the server's business day", async () => {
  const after = new Date('2026-10-27T00:05:00Z'); // Accra is UTC; the cutoff is midnight
  const r = await completeSale(db, till, counterSale('T1', { deviceCreatedAt: '2026-10-26T23:55:00.000Z' }), after);
  expect(await kitchenOrderOf(r)).toMatchObject({ businessDate: '2026-10-27', orderNumber: '001' });
});

describe('combos and sell by amount', () => {
  let meal: { variantId: string; baseUnitId: string };
  let coke: { variantId: string; baseUnitId: string };
  let large: { variantId: string; baseUnitId: string };
  let sobolo: { variantId: string; baseUnitId: string };
  let chicken: { variantId: string };
  let soboloBase: { variantId: string };
  let rice: { variantId: string; baseUnitId: string };
  let drink: string;
  const onHand = async (variantId: string) => {
    const [r] = await asPlatform(db, (tx) => tx.select({ q: stockBalances.onHand }).from(stockBalances).where(eq(stockBalances.variantId, variantId)));
    return r?.q ?? '0.000';
  };
  beforeEach(async () => {
    const owner = await ctxFor(db, shop, 'owner', t);
    chicken = await productFor(db, owner, { name: 'Chicken piece', variants: [{ sku: 'CHK', basePricePesewas: 1500, costPesewas: 800 }] });
    soboloBase = await productFor(db, owner, { name: 'Sobolo base', baseUnit: 'L', allowsFractions: true, variants: [{ sku: 'SOB', basePricePesewas: 1000, costPesewas: 500 }] });
    coke = await productFor(db, owner, { name: 'Coke' });
    large = await productFor(db, owner, { name: 'Large Coke' });
    const sob = await createProduct(db, owner, { name: 'Sobolo', kind: 'recipe', tracking: 'none', baseUnit: 'cup', allowsFractions: false, variants: [{ basePricePesewas: 800, costPesewas: 0 }] });
    sobolo = (sob as { variants: Array<{ variantId: string; baseUnitId: string }> }).variants[0];
    await addComponent(db, owner, sobolo.variantId, { code: 'SOB', quantity: '0.300' });
    const m = await createProduct(db, owner, { name: 'Meal 2', kind: 'combo', tracking: 'none', baseUnit: 'meal', allowsFractions: false, variants: [{ basePricePesewas: 4500, costPesewas: 0 }] });
    meal = (m as { variants: Array<{ variantId: string; baseUnitId: string }> }).variants[0];
    await addComponent(db, owner, meal.variantId, { code: 'CHK', quantity: '2' });
    await saveComboSlots(db, owner, meal.variantId, [{ name: 'Drink', minChoices: 1, maxChoices: 1, choices: [
      { variantId: coke.variantId, upgradePesewas: 0 }, { variantId: large.variantId, upgradePesewas: 500 }, { variantId: sobolo.variantId, upgradePesewas: 0 },
    ] }]);
    drink = (await getComboSlots(db, owner, meal.variantId))[0].id;
    rice = await productFor(db, owner, { name: 'Jollof rice', variants: [{ basePricePesewas: 1000, costPesewas: 0 }] });
    await updateVariant(db, owner, rice.variantId, { name: '', sku: null, basePricePesewas: 1000, costPesewas: null, reorderLevel: null, sellable: true, allowsFractions: false,
      sellByAmount: true, minAmountPesewas: 500, valuePerPotPesewas: 60000 });
  });
  const comboLine = (o: { unitPricePesewas?: number; choices?: Array<{ slotId: string; variantId: string }> } = {}) => ({
    variantId: meal.variantId, unitId: meal.baseUnitId, quantity: '1', unitPricePesewas: o.unitPricePesewas ?? 4500, discountPesewas: 0,
    choices: o.choices ?? [{ slotId: drink, variantId: coke.variantId }],
  });
  const riceLine = (amount: number, extra: Record<string, unknown> = {}) => ({
    variantId: rice.variantId, unitId: rice.baseUnitId, quantity: '1', unitPricePesewas: amount, discountPesewas: 0, byAmount: true, ...extra,
  });
  const lineOf = async (r: SaleResult) => (await asPlatform(db, (tx) => tx.select().from(saleLines).where(eq(saleLines.saleId, (r as { saleId: string }).saleId))))[0];

  it('a combo upgrade adds its price', async () => {
    const r = await completeSale(db, till, counterSale('T1', { lines: [comboLine({ unitPricePesewas: 5000, choices: [{ slotId: drink, variantId: large.variantId }] })] }), t);
    expect(r.ok).toBe(true);
    expect(await lineOf(r)).toMatchObject({ unitPricePesewas: 5000, choices: [{ slotId: drink, variantId: large.variantId, name: 'Large Coke', upgradePesewas: 500 }] });
    expect(await completeSale(db, till, counterSale('T1', { lines: [comboLine({ unitPricePesewas: 4500, choices: [{ slotId: drink, variantId: large.variantId }] })] }), t))
      .toEqual({ ok: false, error: 'price_changed' });
  });

  it('a combo deducts its fixed items and the recipe ingredients of a chosen item', async () => {
    const r = await completeSale(db, till, counterSale('T1', { lines: [comboLine({ choices: [{ slotId: drink, variantId: sobolo.variantId }] })] }), t);
    expect(r.ok).toBe(true);
    expect([await onHand(chicken.variantId), await onHand(soboloBase.variantId), await onHand(sobolo.variantId)]).toEqual(['-2.000', '-0.300', '0.000']);
  });

  it('refuses a combo with too many choices', async () => {
    const two = [{ slotId: drink, variantId: coke.variantId }, { slotId: drink, variantId: sobolo.variantId }];
    expect(await completeSale(db, till, counterSale('T1', { lines: [comboLine({ choices: two })] }), t)).toEqual({ ok: false, error: 'invalid_choices' });
    expect(await completeSale(db, till, counterSale('T1', { lines: [comboLine({ choices: two })], fromOfflineOutbox: true }), t)).toEqual({ ok: false, error: 'invalid_choices' });
  });

  it('an offline combo sale made before the combo was edited is kept for review', async () => {
    const owner = await ctxFor(db, shop, 'owner', t);
    await saveComboSlots(db, owner, meal.variantId, [{ name: 'Drink', minChoices: 1, maxChoices: 1, choices: [{ variantId: coke.variantId, upgradePesewas: 0 }] }]); // new slot ids
    expect(await completeSale(db, till, counterSale('T1', { lines: [comboLine()] }), t)).toEqual({ ok: false, error: 'invalid_choices' });
    const r = await completeSale(db, till, counterSale('T1', { lines: [comboLine()], fromOfflineOutbox: true }), t);
    expect(r.ok).toBe(true);
    expect((await saleOf(r)).reviewReasons).toContain('combo_changed');
    expect(await lineOf(r)).toMatchObject({ choices: [{ variantId: coke.variantId, name: 'Coke' }] });
    expect(await onHand(coke.variantId)).toBe('-1.000'); // the drink still leaves stock
  });

  it('refuses a sold-out choice', async () => {
    await markSoldOut(db, till, { branchId: shop.branchId, variantId: coke.variantId }, t);
    expect(await completeSale(db, till, counterSale('T1', { lines: [comboLine()] }), t)).toEqual({ ok: false, error: 'sold_out' });
  });

  it('a by-amount line keeps the amount typed and deducts no stock', async () => {
    const r = await completeSale(db, till, counterSale('T1', { lines: [riceLine(1000)] }), t);
    expect(r.ok).toBe(true);
    expect(await lineOf(r)).toMatchObject({ unitPricePesewas: 1000, byAmount: true, totalPesewas: 1000 });
    expect(await onHand(rice.variantId)).toBe('0.000');
    expect(await completeSale(db, till, counterSale('T1', { lines: [riceLine(1500)] }), t)).toMatchObject({ ok: true }); // any amount above the minimum
  });

  it('refuses an amount below the minimum online and flags it from the outbox', async () => {
    expect(await completeSale(db, till, counterSale('T1', { lines: [riceLine(400)] }), t)).toEqual({ ok: false, error: 'below_minimum_amount' });
    const r = await completeSale(db, till, counterSale('T1', { lines: [riceLine(400)], fromOfflineOutbox: true }), t);
    expect(r.ok).toBe(true);
    expect((await saleOf(r)).reviewReasons).toContain('below_minimum');
  });

  it('a sell-by-amount item must be sold by amount', async () => {
    expect(await completeSale(db, till, counterSale('T1', { lines: [riceLine(1000, { byAmount: undefined })] }), t)).toEqual({ ok: false, error: 'amount_required' });
    expect(await completeSale(db, till, counterSale('T1', { lines: [riceLine(1000, { quantity: '2' })] }), t)).toEqual({ ok: false, error: 'invalid_quantity' });
    expect(await completeSale(db, till, counterSale('T1', { lines: [{ ...jollofLine(), byAmount: true }] }), t)).toEqual({ ok: false, error: 'not_sold_by_amount' });
  });
});

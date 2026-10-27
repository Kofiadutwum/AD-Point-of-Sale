import { randomUUID } from 'node:crypto';
import { and, eq } from 'drizzle-orm';
import { afterEach, beforeEach, expect, it } from 'vitest';
import type { Db } from '@/db/client';
import { auditLog, foodSettings, stockBalances, wastageEntries } from '@/db/schema';
import { asPlatform, withTenant } from '@/db/tenant';
import type { Ctx } from '@/server/context';
import { getPotDay, getTodayPots, potReminders, recordClosingLeftover, recordPots } from '@/server/pots';
import { createProduct } from '@/server/products';
import { completeSale } from '@/server/sales';
import { addComponent, updateVariant } from '@/server/variants';
import { ctxFor, foodShop, productFor, saleInput, type SeededShop, tillCtxFor } from '../helpers/fixtures';
import { createTestDb } from '../helpers/test-db';

const day1 = new Date('2026-10-26T09:00:00Z');
const close1 = new Date('2026-10-26T20:00:00Z');
const day2 = new Date('2026-10-27T09:00:00Z');
const close2 = new Date('2026-10-27T20:00:00Z');
let db: Db;
let close: () => Promise<void>;
let shop: SeededShop;
let owner: Ctx;
let till: Ctx;
let jollof: { variantId: string; baseUnitId: string };
let rice: { variantId: string };
let oil: { variantId: string };
const branch = () => shop.branchId;

beforeEach(async () => {
  ({ db, close } = await createTestDb());
  shop = await foodShop(db, day1);
  owner = await ctxFor(db, shop, 'owner', day1);
  till = await tillCtxFor(db, shop, 'owner', day1);
  rice = await productFor(db, owner, { name: 'Rice', baseUnit: 'kg', allowsFractions: true, variants: [{ sku: 'RICE', basePricePesewas: 2000, costPesewas: 1000 }] });
  oil = await productFor(db, owner, { name: 'Oil', baseUnit: 'L', allowsFractions: true, variants: [{ sku: 'OIL', basePricePesewas: 3000, costPesewas: 2000 }] });
  const r = await createProduct(db, owner, { name: 'Jollof', kind: 'recipe', tracking: 'none', baseUnit: 'plate', allowsFractions: false, variants: [{ basePricePesewas: 1000, costPesewas: 0 }] });
  jollof = (r as { variants: Array<{ variantId: string; baseUnitId: string }> }).variants[0];
  await addComponent(db, owner, jollof.variantId, { code: 'RICE', quantity: '5' });
  await addComponent(db, owner, jollof.variantId, { code: 'OIL', quantity: '1' });
  await setPot(60000);
});
afterEach(async () => { await close(); });

const setPot = (valuePerPotPesewas: number | null) => updateVariant(db, owner, jollof.variantId, {
  name: '', sku: null, basePricePesewas: 1000, costPesewas: null, reorderLevel: null, sellable: true, allowsFractions: false,
  sellByAmount: true, minAmountPesewas: 500, valuePerPotPesewas,
});
const onHand = async (variantId: string) => (await asPlatform(db, (tx) => tx.select({ q: stockBalances.onHand }).from(stockBalances)
  .where(eq(stockBalances.variantId, variantId))))[0]?.q ?? '0.000';
let receipt = 0;
async function sell(amount: number, at: Date, extra: { tenders?: []; fromOfflineOutbox?: boolean } = {}) {
  const r = await completeSale(db, till, saleInput({
    saleId: randomUUID(), receiptNumber: `B1-T1-${String(++receipt).padStart(6, '0')}`, deviceCreatedAt: at.toISOString(),
    tenders: [{ id: randomUUID(), method: 'cash', amountPesewas: amount }], ...extra,
    lines: [{ variantId: jollof.variantId, unitId: jollof.baseUnitId, quantity: '1', unitPricePesewas: amount, discountPesewas: 0, byAmount: true }],
  }), at);
  if (!r.ok) throw new Error(r.error);
}

it('records pots and deducts the pot recipe', async () => {
  expect(await recordPots(db, till, { branchId: branch(), variantId: jollof.variantId, pots: '2' }, day1)).toEqual({ ok: true, cooked: '2.000' });
  expect([await onHand(rice.variantId), await onHand(oil.variantId)]).toEqual(['-10.000', '-2.000']);
  expect(await recordPots(db, till, { branchId: branch(), variantId: jollof.variantId, pots: '0.5' }, day1)).toEqual({ ok: true, cooked: '2.500' });
});

it('compares expected with actual sales and flags a large gap', async () => {
  await recordPots(db, till, { branchId: branch(), variantId: jollof.variantId, pots: '3' }, day1);
  await sell(100000, day1);
  await sell(56000, day1);
  const ok = await recordClosingLeftover(db, till, { branchId: branch(), variantId: jollof.variantId, leftover: '0.4' }, close1);
  expect(ok).toMatchObject({ ok: true, pot: { expectedPesewas: 156000, actualPesewas: 156000, variancePesewas: 0, flagged: false, closed: true } });

  await recordPots(db, till, { branchId: branch(), variantId: jollof.variantId, pots: '3' }, day2);
  await sell(156000, day2);
  const bad = await recordClosingLeftover(db, till, { branchId: branch(), variantId: jollof.variantId, leftover: '0' }, close2);
  expect(bad).toMatchObject({ ok: true, pot: { expectedPesewas: 180000, actualPesewas: 156000, variancePesewas: -24000, flagged: true } });
  const audits = await asPlatform(db, (tx) => tx.select().from(auditLog).where(and(eq(auditLog.tenantId, shop.tenantId), eq(auditLog.action, 'pot_variance'))));
  expect(audits).toHaveLength(1);
});

it('refuses a leftover above the pots cooked', async () => {
  await recordPots(db, till, { branchId: branch(), variantId: jollof.variantId, pots: '1' }, day1);
  expect(await recordClosingLeftover(db, till, { branchId: branch(), variantId: jollof.variantId, leftover: '1.5' }, close1)).toEqual({ ok: false, error: 'leftover_above_cooked' });
});

it('closing twice is refused and wastes stock once', async () => {
  await recordPots(db, till, { branchId: branch(), variantId: jollof.variantId, pots: '1' }, day1);
  await recordClosingLeftover(db, till, { branchId: branch(), variantId: jollof.variantId, leftover: '0.5' }, close1);
  expect(await recordClosingLeftover(db, till, { branchId: branch(), variantId: jollof.variantId, leftover: '0.5' }, close1)).toEqual({ ok: false, error: 'already_closed' });
  expect(await asPlatform(db, (tx) => tx.select().from(wastageEntries))).toHaveLength(1);
});

it('wastes the leftover by default', async () => {
  await recordPots(db, till, { branchId: branch(), variantId: jollof.variantId, pots: '1' }, day1);
  await recordClosingLeftover(db, till, { branchId: branch(), variantId: jollof.variantId, leftover: '0.5' }, close1);
  expect([await onHand(rice.variantId), await onHand(oil.variantId)]).toEqual(['-7.500', '-1.500']);
  const [w] = await asPlatform(db, (tx) => tx.select().from(wastageEntries));
  // one pot costs 5 kg x GHS 10 + 1 L x GHS 20 = GHS 70; half a pot = GHS 35
  expect(w).toMatchObject({ reason: 'leftover', quantity: '0.500', costPesewas: 3500, businessDate: '2026-10-26' });
});

it('keeps leftovers for tomorrow when the shop says so', async () => {
  await asPlatform(db, (tx) => tx.update(foodSettings).set({ keepPotLeftovers: true }).where(eq(foodSettings.tenantId, shop.tenantId)));
  await recordPots(db, till, { branchId: branch(), variantId: jollof.variantId, pots: '1' }, day1);
  await recordClosingLeftover(db, till, { branchId: branch(), variantId: jollof.variantId, leftover: '0.5' }, close1);
  expect(await asPlatform(db, (tx) => tx.select().from(wastageEntries))).toHaveLength(0);
  const next = await getPotDay(db, till, branch(), '2026-10-27');
  expect(next).toMatchObject([{ variantId: jollof.variantId, cooked: '0.500', carriedIn: '0.500', closed: false }]);
  await recordPots(db, till, { branchId: branch(), variantId: jollof.variantId, pots: '2' }, day2);
  await sell(150000, day2);
  // 2.5 pots available, 0 left: expected 150000
  expect(await recordClosingLeftover(db, till, { branchId: branch(), variantId: jollof.variantId, leftover: '0' }, close2))
    .toMatchObject({ ok: true, pot: { cooked: '2.500', expectedPesewas: 150000, flagged: false } });
});

it('pots without a value per pot are closed without a check', async () => {
  await setPot(null);
  await recordPots(db, till, { branchId: branch(), variantId: jollof.variantId, pots: '1' }, day1);
  expect(await recordClosingLeftover(db, till, { branchId: branch(), variantId: jollof.variantId, leftover: '0' }, close1))
    .toMatchObject({ ok: true, pot: { expectedPesewas: null, variancePesewas: null, flagged: false } });
});

it('counts only completed by-amount sales of that branch and day', async () => {
  await recordPots(db, till, { branchId: branch(), variantId: jollof.variantId, pots: '1' }, day1);
  await sell(10000, day1);
  await sell(20000, day1, { tenders: [], fromOfflineOutbox: true }); // pending: not paid
  await sell(40000, day2); // another day
  expect(await recordClosingLeftover(db, till, { branchId: branch(), variantId: jollof.variantId, leftover: '0', businessDate: '2026-10-26' }, day2))
    .toMatchObject({ ok: true, pot: { actualPesewas: 10000 } });
});

it('lists earlier days still waiting for a leftover count', async () => {
  await recordPots(db, till, { branchId: branch(), variantId: jollof.variantId, pots: '1' }, day1);
  expect(await withTenant(db, shop.tenantId, (tx) => potReminders(tx, '2026-10-27'))).toEqual([
    { branchId: branch(), variantId: jollof.variantId, name: 'Jollof', businessDate: '2026-10-26' },
  ]);
  expect(await withTenant(db, shop.tenantId, (tx) => potReminders(tx, '2026-10-26'))).toEqual([]);
  expect(await recordClosingLeftover(db, till, { branchId: branch(), variantId: jollof.variantId, leftover: '0', businessDate: '2026-10-24' }, day2))
    .toEqual({ ok: false, error: 'too_old' });
});

it("lists today's by-amount items with their pot records", async () => {
  await recordPots(db, till, { branchId: branch(), variantId: jollof.variantId, pots: '2' }, day1);
  const r = await getTodayPots(db, till, branch(), close1);
  expect(r.businessDate).toBe('2026-10-26');
  expect(r.items).toMatchObject([{ variantId: jollof.variantId, name: 'Jollof', pot: { cooked: '2.000', closed: false } }]);
});

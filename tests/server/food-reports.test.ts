import { randomUUID } from 'node:crypto';
import { afterEach, beforeEach, expect, it } from 'vitest';
import type { Db } from '@/db/client';
import { saveChannel } from '@/server/channels';
import { getComboSlots, saveComboSlots } from '@/server/combos';
import type { Ctx } from '@/server/context';
import { foodReport, type FoodReport, foodReportCsv } from '@/server/food-reports';
import { handOverOrder, listKitchenOrders, markOrderReady } from '@/server/kitchen';
import { createProduct } from '@/server/products';
import { completeSale, type SaleInput } from '@/server/sales';
import { addComponent } from '@/server/variants';
import { recordWastage } from '@/server/wastage';
import { ctxFor, foodShop, productFor, saleInput, type SeededShop, tillCtxFor } from '../helpers/fixtures';
import { createTestDb } from '../helpers/test-db';

const t = new Date('2026-10-26T12:00:00Z');
const at = (minutes: number) => new Date(t.getTime() + minutes * 60_000);
const day = { from: '2026-10-26', to: '2026-10-26' };
let db: Db;
let close: () => Promise<void>;
let shop: SeededShop & { packVariantId: string; packUnitId: string };
let owner: Ctx;
let report: FoodReport;
let ids: Record<string, string>;
let receipt = 0;

beforeEach(async () => {
  ({ db, close } = await createTestDb());
  shop = await foodShop(db, t);
  owner = await ctxFor(db, shop, 'owner', t);
  const till = await tillCtxFor(db, shop, 'owner', t);
  const jollof = await productFor(db, owner, { name: 'Jollof', variants: [{ basePricePesewas: 4500, costPesewas: 2000 }] });
  const chicken = await productFor(db, owner, { name: 'Chicken piece', variants: [{ sku: 'CHK', basePricePesewas: 1500, costPesewas: 800 }] });
  const coke = await productFor(db, owner, { name: 'Coke' }); // GHS 5
  const kenkey = await productFor(db, owner, { name: 'Kenkey' });
  await productFor(db, owner, { name: '=cmd' });
  const meal = await createProduct(db, owner, { name: 'Meal 2', kind: 'combo', tracking: 'none', baseUnit: 'meal', allowsFractions: false, variants: [{ basePricePesewas: 4500, costPesewas: 0 }] });
  if (!meal.ok) throw new Error(meal.error);
  const mealId = meal.variants[0].variantId;
  await addComponent(db, owner, mealId, { code: 'CHK', quantity: '2' });
  await saveComboSlots(db, owner, mealId, [{ name: 'Drink', minChoices: 1, maxChoices: 1, choices: [{ variantId: coke.variantId, upgradePesewas: 0 }] }]);
  const [slot] = await getComboSlots(db, owner, mealId);
  const bolt = (await saveChannel(db, owner, { name: 'Bolt Food', kind: 'delivery_app', priceListId: null, commissionBp: 2000, collectedBy: 'app', active: true }) as { channelId: string }).channelId;
  ids = { jollof: jollof.variantId, chicken: chicken.variantId, coke: coke.variantId, kenkey: kenkey.variantId };

  const line = (variantId: string, unitId: string, price: number, quantity = '1', extra = {}) => ({ variantId, unitId, quantity, unitPricePesewas: price, discountPesewas: 0, ...extra });
  const sell = async (minutes: number, o: Partial<SaleInput> & Pick<SaleInput, 'lines'>) => {
    const r = await completeSale(db, till, saleInput({
      receiptNumber: `B1-T1-${String(++receipt).padStart(6, '0')}`, deviceCreatedAt: at(minutes).toISOString(),
      food: { serviceMode: 'counter', diningOption: 'eat_in' }, ...o,
    }), at(minutes));
    if (!r.ok) throw new Error(r.error);
    return r;
  };
  await sell(0, { lines: [line(jollof.variantId, jollof.baseUnitId, 4500, '2')] }); // 12:00, GHS 90
  await sell(30, { lines: [line(mealId, meal.variants[0].baseUnitId, 4500, '1', { choices: [{ slotId: slot.id, variantId: coke.variantId }] })] }); // 12:30, GHS 45
  await sell(70, { // 13:10, Bolt GHS 46, 20% commission
    lines: [line(jollof.variantId, jollof.baseUnitId, 4500), line(shop.packVariantId, shop.packUnitId, 100)],
    tenders: [{ id: randomUUID(), method: 'channel_settlement', amountPesewas: 4600, reference: 'BF-1' }],
    food: { serviceMode: 'counter', diningOption: 'delivery', channelId: bolt, externalOrderId: 'BF-1' },
  });
  // an offline sale paid GHS 1 of GHS 45 is held pending: never in the report
  await sell(80, { lines: [line(jollof.variantId, jollof.baseUnitId, 4500)], tenders: [{ id: randomUUID(), method: 'cash', amountPesewas: 100 }], fromOfflineOutbox: true, food: { serviceMode: 'counter', diningOption: 'eat_in', orderNumber: 'T1-090' } });

  // the first order: ready after 5 minutes, collected after 8
  const kitchen = await listKitchenOrders(db, owner, shop.branchId, at(90)) as { orders: Array<{ id: string; orderNumber: string }> };
  const first = kitchen.orders.find((o) => o.orderNumber === '001')!;
  await markOrderReady(db, owner, first.id, at(5));
  await handOverOrder(db, owner, { orderId: first.id }, at(8));
  await recordWastage(db, owner, { branchId: shop.branchId, variantId: chicken.variantId, quantity: '1', reason: 'dropped' }, t);

  const r = await foodReport(db, owner, day, at(120));
  if (!r.ok) throw new Error(r.error);
  report = r.report;
});
afterEach(async () => { await close(); });

it('groups orders and value by local hour', () => {
  expect(report.byHour).toHaveLength(24);
  expect(report.byHour[12]).toEqual({ hour: 12, orders: 2, valuePesewas: 13500 });
  expect(report.byHour[13]).toEqual({ hour: 13, orders: 1, valuePesewas: 4600 });
  expect(report.byHour[14].orders).toBe(0); // the pending sale is left out
});

it('item sales split combos into their parts', () => {
  const item = (id: string) => report.items.find((i) => i.variantId === id);
  expect(item(ids.jollof)).toMatchObject({ quantity: '3.000', valuePesewas: 13500 });
  // GHS 45 over chicken 2 × 15 and coke 5: 3857 + 642, the leftover pesewa to chicken
  expect(item(ids.chicken)).toMatchObject({ quantity: '2.000', valuePesewas: 3858 });
  expect(item(ids.coke)).toMatchObject({ quantity: '1.000', valuePesewas: 642 });
  expect(report.items.reduce((sum, i) => sum + i.valuePesewas, 0)).toBe(13500 + 4500 + 100);
});

it('best and slowest include items with no sales', () => {
  expect(report.best[0].variantId).toBe(ids.jollof);
  expect(report.slowest.find((i) => i.variantId === ids.kenkey)).toMatchObject({ quantity: '0.000', valuePesewas: 0 });
});

it('channel figures show sales minus commission', () => {
  expect(report.channels).toEqual([
    { channelId: null, name: 'Walk-in', orders: 2, salesPesewas: 13500, commissionPesewas: 0, afterCommissionPesewas: 13500 },
    expect.objectContaining({ name: 'Bolt Food', orders: 1, salesPesewas: 4600, commissionPesewas: 920, afterCommissionPesewas: 3680 }),
  ]);
});

it('wastage by reason with cost, and average kitchen time and counter wait', () => {
  expect(report.wastage).toEqual([{ reason: 'dropped', entries: 1, costPesewas: 800 }]);
  expect(report.avgKitchenSeconds).toBe(300);
  expect(report.avgCounterWaitSeconds).toBe(480);
});

it('filters by service mode and refuses a range longer than 92 days', async () => {
  const quick = await foodReport(db, owner, { ...day, serviceMode: 'quick' }, t) as { ok: true; report: FoodReport };
  expect(quick.report.channels).toEqual([]);
  expect(quick.report.byHour.every((h) => h.orders === 0)).toBe(true);
  expect(await foodReport(db, owner, { from: '2026-07-01', to: '2026-10-26' }, t)).toEqual({ ok: false, error: 'range_too_long' });
  expect(await foodReport(db, owner, { from: '2026-10-27', to: '2026-10-26' }, t)).toEqual({ ok: false, error: 'invalid_input' });
});

it('the CSV export neutralises formula cells', async () => {
  const r = await foodReportCsv(db, owner, day, t);
  expect(r.ok && r.csv).toContain("'=cmd");
  expect(r.ok && r.csv).not.toMatch(/(^|,)=cmd/m);
  expect(r.ok && r.csv).toContain('Bolt Food,1,4600,920,3680');
});

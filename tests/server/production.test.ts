import { eq } from 'drizzle-orm';
import { afterEach, beforeEach, expect, it } from 'vitest';
import type { Db } from '@/db/client';
import { stockMovements, variants } from '@/db/schema';
import { asPlatform, withTenant } from '@/db/tenant';
import type { Ctx } from '@/server/context';
import { getProductionList, recordProduction, saveProductionList } from '@/server/production';
import { stockOnHand } from '@/server/stock';
import { ctxFor, productFor, type SeededShop, seedShop, stockFor } from '../helpers/fixtures';
import { createTestDb } from '../helpers/test-db';

const t0 = new Date('2026-11-26T06:00:00Z');
let db: Db;
let close: () => Promise<void>;
let shop: SeededShop;
let owner: Ctx;
type Item = { variantId: string; baseUnitId: string };
let flour: Item;
let sugar: Item;
let bread: Item;
beforeEach(async () => {
  ({ db, close } = await createTestDb());
  shop = await seedShop(db, { users: [{ key: 'owner', email: 'o@b.test', password: 'correct-horse-1', rolePreset: 'owner' }] });
  owner = await ctxFor(db, shop, 'owner', t0);
  flour = await productFor(db, owner, { name: 'Flour', baseUnit: 'kg', allowsFractions: true });
  sugar = await productFor(db, owner, { name: 'Sugar', baseUnit: 'kg', allowsFractions: true });
  bread = await productFor(db, owner, { name: 'Sugar bread', variants: [{ basePricePesewas: 1000, costPesewas: 0 }] });
  await stockFor(db, owner, shop.branchId, { variantId: flour.variantId, unitId: flour.baseUnitId, quantity: '50', totalCostPesewas: 50000 }, t0); // GHS 10 a kg
  await stockFor(db, owner, shop.branchId, { variantId: sugar.variantId, unitId: sugar.baseUnitId, quantity: '10', totalCostPesewas: 20000 }, t0); // GHS 20 a kg
});
afterEach(async () => { await close(); });

const onHand = (item: Item) => withTenant(db, shop.tenantId, (tx) => stockOnHand(tx, shop.branchId, item.variantId));
const list = () => saveProductionList(db, owner, { variantId: bread.variantId, ingredients: [{ variantId: flour.variantId, quantity: '0.5' }, { variantId: sugar.variantId, quantity: '0.1' }] });

it('ingredients go down and the made item goes up', async () => {
  expect(await list()).toEqual({ ok: true });
  expect((await getProductionList(db, owner, bread.variantId)).map((i) => [i.name, i.quantity])).toEqual([['Flour', '0.500'], ['Sugar', '0.100']]);
  const r = await recordProduction(db, owner, { branchId: shop.branchId, variantId: bread.variantId, quantity: '40' }, t0);
  expect(r).toEqual({ ok: true, runId: expect.any(String), unitCostPesewas: '700.0000', negativeStock: false }); // 0.5 kg × 10.00 + 0.1 kg × 20.00
  expect([await onHand(flour), await onHand(sugar), await onHand(bread)]).toEqual(['30.000', '6.000', '40.000']);
  const moves = await asPlatform(db, (tx) => tx.select().from(stockMovements).where(eq(stockMovements.referenceType, 'production')));
  expect(moves.map((m) => [m.type, m.quantity]).sort()).toEqual([['produced', '40.000'], ['used_in_production', '-20.000'], ['used_in_production', '-4.000']]);
});

it("the made item's cost follows its ingredients", async () => {
  await list();
  await recordProduction(db, owner, { branchId: shop.branchId, variantId: bread.variantId, quantity: '10' }, t0); // 7.00 each
  await stockFor(db, owner, shop.branchId, { variantId: sugar.variantId, unitId: sugar.baseUnitId, quantity: '10', totalCostPesewas: 40000 }, t0); // 9 kg at 20.00 + 10 kg at 40.00: sugar now averages 30.5263
  await recordProduction(db, owner, { branchId: shop.branchId, variantId: bread.variantId, quantity: '10' }, t0); // 0.5 × 10 + 0.1 × 30.5263 = 8.0526 each
  const [v] = await asPlatform(db, (tx) => tx.select({ averageCost: variants.averageCost }).from(variants).where(eq(variants.id, bread.variantId)));
  expect(v.averageCost).toBe('752.6316'); // 10 at 7.00 and 10 at 8.0526
});

it('a production list cannot contain itself', async () => {
  const dough = await productFor(db, owner, { name: 'Dough', baseUnit: 'kg', allowsFractions: true });
  expect(await saveProductionList(db, owner, { variantId: bread.variantId, ingredients: [{ variantId: bread.variantId, quantity: '1' }] })).toEqual({ ok: false, error: 'contains_itself' });
  expect(await saveProductionList(db, owner, { variantId: dough.variantId, ingredients: [{ variantId: bread.variantId, quantity: '1' }] })).toEqual({ ok: true });
  expect(await saveProductionList(db, owner, { variantId: bread.variantId, ingredients: [{ variantId: dough.variantId, quantity: '0.5' }] })).toEqual({ ok: false, error: 'contains_itself' });
  expect(await recordProduction(db, owner, { branchId: shop.branchId, variantId: sugar.variantId, quantity: '1' }, t0)).toEqual({ ok: false, error: 'no_production_list' });
});

it('batch items are not supported yet', async () => {
  const pies = await productFor(db, owner, { name: 'Meat pie', tracking: 'batch' });
  expect(await saveProductionList(db, owner, { variantId: pies.variantId, ingredients: [{ variantId: flour.variantId, quantity: '0.1' }] })).toEqual({ ok: false, error: 'not_supported' });
});

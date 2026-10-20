import { and, eq } from 'drizzle-orm';
import { afterEach, beforeEach, expect, it } from 'vitest';
import type { Db } from '@/db/client';
import { auditLog, priceListItems } from '@/db/schema';
import { asPlatform } from '@/db/tenant';
import type { Ctx } from '@/server/context';
import {
  createPriceList, listPriceLists, quotePrice, removePriceListItem, setPriceListItem, updatePriceList,
} from '@/server/price-lists';
import { ctxFor, expectAccess, productFor, type SeededShop, seedShop } from '../helpers/fixtures';
import { createTestDb } from '../helpers/test-db';

const t0 = new Date('2026-10-20T10:00:00Z');
let db: Db;
let close: () => Promise<void>;
let shop: SeededShop;
let owner: Ctx;
beforeEach(async () => {
  ({ db, close } = await createTestDb());
  shop = await seedShop(db, { users: [
    { key: 'owner', email: 'owner@a.test', rolePreset: 'owner' },
    { key: 'kofi', phone: '0201234567', rolePreset: 'cashier' },
  ] });
  owner = await ctxFor(db, shop, 'owner', t0);
});
afterEach(async () => { await close(); });

const newList = (kind: 'retail' | 'wholesale' | 'branch', extra: Partial<Parameters<typeof createPriceList>[2]> = {}) =>
  ({ name: kind, kind, branchId: null, startsOn: null, endsOn: null, ...extra });

it('gives a wholesale customer the wholesale price, and the Retail break at 12', async () => {
  const milo = await productFor(db, owner); // base price GHS 5.00
  const { priceListId: retail } = await createPriceList(db, owner, newList('retail')) as { priceListId: string };
  const { priceListId: wholesale } = await createPriceList(db, owner, newList('wholesale')) as { priceListId: string };
  await setPriceListItem(db, owner, { priceListId: retail, unitId: milo.baseUnitId, minQuantity: '12', pricePesewas: 450 });
  await setPriceListItem(db, owner, { priceListId: wholesale, unitId: milo.baseUnitId, minQuantity: '1', pricePesewas: 420 });
  const quote = (quantity: string, priceListId: string | null) =>
    quotePrice(db, owner, { unitId: milo.baseUnitId, quantity, branchId: shop.branchId, priceListId }, t0);
  expect(await quote('12', null)).toEqual({ ok: true, unitPricePesewas: 450, priceListId: retail });
  expect(await quote('2', wholesale)).toEqual({ ok: true, unitPricePesewas: 420, priceListId: wholesale });
  expect(await quote('2', null)).toEqual({ ok: true, unitPricePesewas: 500, priceListId: retail });
});

it('allows one Retail list per shop and one list per branch', async () => {
  await createPriceList(db, owner, newList('retail'));
  expect(await createPriceList(db, owner, newList('retail', { name: 'Retail 2' }))).toEqual({ ok: false, error: 'retail_exists' });
  expect(await createPriceList(db, owner, newList('branch', { branchId: shop.branchId }))).toMatchObject({ ok: true });
  expect(await createPriceList(db, owner, newList('branch', { name: 'Again', branchId: shop.branchId }))).toEqual({ ok: false, error: 'branch_has_list' });
  const other = await seedShop(db);
  expect(await createPriceList(db, owner, newList('branch', { branchId: other.branchId }))).toEqual({ ok: false, error: 'unknown_branch' });
  expect(await createPriceList(db, owner, newList('wholesale', { startsOn: '2026-12-31', endsOn: '2026-12-01' }))).toEqual({ ok: false, error: 'invalid_input' });
});

it('updates a list and its dates', async () => {
  const { priceListId } = await createPriceList(db, owner, newList('wholesale')) as { priceListId: string };
  expect(await updatePriceList(db, owner, priceListId, { name: 'Trade', startsOn: '2026-11-01', endsOn: null, active: false })).toEqual({ ok: true });
  expect((await listPriceLists(db, owner))[0]).toMatchObject({ name: 'Trade', startsOn: '2026-11-01', active: false });
});

it('upserts a break and removes it', async () => {
  const milo = await productFor(db, owner);
  const { priceListId } = await createPriceList(db, owner, newList('retail')) as { priceListId: string };
  await setPriceListItem(db, owner, { priceListId, unitId: milo.baseUnitId, minQuantity: '12', pricePesewas: 450 });
  const { itemId } = await setPriceListItem(db, owner, { priceListId, unitId: milo.baseUnitId, minQuantity: '12.000', pricePesewas: 440 }) as { itemId: string };
  const items = await asPlatform(db, (tx) => tx.select().from(priceListItems));
  expect(items.map((i) => [i.minQuantity, i.pricePesewas])).toEqual([['12.000', 440]]);
  const [saved] = await asPlatform(db, (tx) => tx.select().from(auditLog)
    .where(and(eq(auditLog.action, 'price_list_item_saved'), eq(auditLog.recordId, itemId))).orderBy(auditLog.id).offset(1));
  expect(saved.changes).toEqual({ pricePesewas: [450, 440] });
  expect(await removePriceListItem(db, owner, itemId)).toEqual({ ok: true });
  expect(await asPlatform(db, (tx) => tx.select().from(priceListItems))).toEqual([]);
});

it("refuses another shop's unit or list", async () => {
  const other = await seedShop(db);
  const otherOwner = await ctxFor(db, other, 'owner', t0);
  const theirs = await productFor(db, otherOwner);
  const { priceListId: theirList } = await createPriceList(db, otherOwner, newList('retail')) as { priceListId: string };
  const mine = await productFor(db, owner);
  const { priceListId: myList } = await createPriceList(db, owner, newList('retail')) as { priceListId: string };
  expect(await setPriceListItem(db, owner, { priceListId: myList, unitId: theirs.baseUnitId, minQuantity: '1', pricePesewas: 1 })).toEqual({ ok: false, error: 'not_found' });
  expect(await setPriceListItem(db, owner, { priceListId: theirList, unitId: mine.baseUnitId, minQuantity: '1', pricePesewas: 1 })).toEqual({ ok: false, error: 'not_found' });
  expect(await quotePrice(db, owner, { unitId: theirs.baseUnitId, quantity: '1', branchId: shop.branchId, priceListId: null }, t0))
    .toEqual({ ok: false, error: 'not_found' });
});

it('rejects fractional quantities for whole units', async () => {
  const milo = await productFor(db, owner);
  const { priceListId } = await createPriceList(db, owner, newList('retail')) as { priceListId: string };
  expect(await setPriceListItem(db, owner, { priceListId, unitId: milo.baseUnitId, minQuantity: '1.5', pricePesewas: 1 })).toEqual({ ok: false, error: 'invalid_input' });
  expect(await quotePrice(db, owner, { unitId: milo.baseUnitId, quantity: '0.5', branchId: shop.branchId, priceListId: null }, t0))
    .toEqual({ ok: false, error: 'invalid_quantity' });
});

it('needs manage_products to change lists', async () => {
  await expectAccess(createPriceList(db, await ctxFor(db, shop, 'kofi', t0), newList('retail')), 'forbidden');
});

import { afterEach, beforeEach, expect, it } from 'vitest';
import type { Db } from '@/db/client';
import type { Ctx } from '@/server/context';
import { addCustomer } from '@/server/customers';
import { createPriceList, setPriceListItem } from '@/server/price-lists';
import { saveSellingSettings } from '@/server/shop-settings';
import { saveTaxRule } from '@/server/tax-rules';
import { lookupTillItem, tillItemForVariant } from '@/server/till';
import { addBarcode, addUnit } from '@/server/variants';
import { ctxFor, productFor, type SeededShop, seedShop, tillCtxFor, WEIGHT_LAYOUT } from '../helpers/fixtures';
import { createTestDb } from '../helpers/test-db';

const t0 = new Date('2026-10-20T10:00:00Z');
let db: Db;
let close: () => Promise<void>;
let shop: SeededShop;
let owner: Ctx;
let cashier: Ctx;
beforeEach(async () => {
  ({ db, close } = await createTestDb());
  shop = await seedShop(db, { users: [
    { key: 'owner', email: 'o@a.test', password: 'correct-horse-1', rolePreset: 'owner' },
    { key: 'cashier', phone: '0200000001', pin: '1234', rolePreset: 'cashier' },
  ] });
  owner = await ctxFor(db, shop, 'owner', t0);
  cashier = await tillCtxFor(db, shop, 'cashier', t0);
  await saveTaxRule(db, owner, { name: 'VAT', rateBp: 1500, levies: [], vatOnLevies: false, isDefault: true, active: true });
  await saveSellingSettings(db, owner, { taxEnabled: true, scaleLayout: WEIGHT_LAYOUT, modules: [] });
});
afterEach(async () => { await close(); });

it('finds a scanned barcode with its unit price and tax rate', async () => {
  const p = await productFor(db, owner);
  const { unitId } = await addUnit(db, owner, p.variantId, { name: 'carton', factor: '24', pricePesewas: 10000, sellable: true, purchasable: true }) as { unitId: string };
  await addBarcode(db, owner, unitId, '6009876543210');
  expect(await lookupTillItem(db, cashier, { code: '6009876543210', branchId: shop.branchId, customerId: null }, t0))
    .toMatchObject({ variantId: p.variantId, unitId, unitName: 'carton', quantity: '1.000', unitPricePesewas: 10000, taxRateBp: 1500, available: true });
});

it('finds a scale label with its weight', async () => {
  await productFor(db, owner, { baseUnit: 'kg', allowsFractions: true, variants: [{ basePricePesewas: 2000, costPesewas: 1000, scaleItemCode: 123 }] });
  expect(await lookupTillItem(db, cashier, { code: '2100123012503', branchId: shop.branchId, customerId: null }, t0))
    .toMatchObject({ quantity: '1.250', unitName: 'kg', unitPricePesewas: 2000, fractions: true });
});

it('prices a quantity break and the customer price list', async () => {
  const p = await productFor(db, owner);
  const { priceListId } = await createPriceList(db, owner, { name: 'Wholesale', kind: 'wholesale', branchId: null, startsOn: null, endsOn: null }) as { priceListId: string };
  await setPriceListItem(db, owner, { priceListId, unitId: p.baseUnitId, minQuantity: '1', pricePesewas: 400 });
  await setPriceListItem(db, owner, { priceListId, unitId: p.baseUnitId, minQuantity: '10', pricePesewas: 350 });
  const { customerId } = await addCustomer(db, cashier, { name: 'T', phone: '0241234567', priceListId }) as { customerId: string };
  const at = (quantity: string, who: string | null) => tillItemForVariant(db, cashier, { variantId: p.variantId, quantity, branchId: shop.branchId, customerId: who }, t0);
  expect((await at('1', null))!.unitPricePesewas).toBe(500);
  expect((await at('1', customerId))!.unitPricePesewas).toBe(400);
  expect((await at('10', customerId))!.unitPricePesewas).toBe(350);
});

it('returns null for an unknown code', async () => {
  expect(await lookupTillItem(db, cashier, { code: '999', branchId: shop.branchId, customerId: null }, t0)).toBeNull();
});

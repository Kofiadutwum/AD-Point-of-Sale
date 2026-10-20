import { afterEach, beforeEach, expect, it } from 'vitest';
import type { Db } from '@/db/client';
import type { Ctx } from '@/server/context';
import { setProductStatus } from '@/server/products';
import { parseScannedCode } from '@/server/scan';
import { saveSellingSettings } from '@/server/shop-settings';
import { addBarcode, addUnit } from '@/server/variants';
import { ctxFor, PRICE_LAYOUT, productFor, type SeededShop, seedShop, WEIGHT_LAYOUT } from '../helpers/fixtures';
import { createTestDb } from '../helpers/test-db';

const t0 = new Date('2026-10-20T10:00:00Z');
const kg = { baseUnit: 'kg', allowsFractions: true };
let db: Db;
let close: () => Promise<void>;
let shop: SeededShop;
let owner: Ctx;
beforeEach(async () => {
  ({ db, close } = await createTestDb());
  shop = await seedShop(db);
  owner = await ctxFor(db, shop, 'owner', t0);
});
afterEach(async () => { await close(); });

it('finds a barcode with quantity 1 in its unit', async () => {
  const p = await productFor(db, owner);
  const { unitId } = await addUnit(db, owner, p.variantId, { name: 'carton', factor: '24', pricePesewas: null, sellable: true, purchasable: true }) as { unitId: string };
  await addBarcode(db, owner, unitId, '6009876543210');
  expect(await parseScannedCode(db, owner, '6009876543210\r\n')).toEqual({
    found: true, productId: p.productId, variantId: p.variantId, unitId, quantity: '1.000', labelPricePesewas: null, available: true,
  });
});

it('finds a UPC-A code saved as EAN-13, and the other way round', async () => {
  const p = await productFor(db, owner, { variants: [{ barcodes: ['036000291452'], basePricePesewas: 1, costPesewas: 1 }] });
  expect(await parseScannedCode(db, owner, '0036000291452')).toMatchObject({ found: true, variantId: p.variantId, unitId: p.baseUnitId });
  expect(await parseScannedCode(db, owner, '036000291452')).toMatchObject({ found: true, variantId: p.variantId });
});

it('reads a weight label as kilograms', async () => {
  await saveSellingSettings(db, owner, { taxEnabled: false, scaleLayout: WEIGHT_LAYOUT, modules: [] });
  const beef = await productFor(db, owner, { ...kg, variants: [{ scaleItemCode: 123, basePricePesewas: 9000, costPesewas: 7000 }] });
  expect(await parseScannedCode(db, owner, '2100123012503'))
    .toMatchObject({ found: true, variantId: beef.variantId, unitId: beef.baseUnitId, quantity: '1.250', labelPricePesewas: null });
});

it('reads a price label as a price and a quantity', async () => {
  await saveSellingSettings(db, owner, { taxEnabled: false, scaleLayout: PRICE_LAYOUT, modules: [] });
  const cheese = await productFor(db, owner, { ...kg, variants: [{ scaleItemCode: 456, basePricePesewas: 900, costPesewas: 600 }] });
  expect(await parseScannedCode(db, owner, '2200456007501'))
    .toMatchObject({ found: true, variantId: cheese.variantId, quantity: '0.833', labelPricePesewas: 750 });
});

it('rejects a scale label with a wrong check digit', async () => {
  await saveSellingSettings(db, owner, { taxEnabled: false, scaleLayout: WEIGHT_LAYOUT, modules: [] });
  await productFor(db, owner, { ...kg, variants: [{ scaleItemCode: 123, basePricePesewas: 9000, costPesewas: 7000 }] });
  expect(await parseScannedCode(db, owner, '2100123012504')).toEqual({ found: false });
  expect(await parseScannedCode(db, owner, '2100999012508')).toEqual({ found: false }); // valid label, unknown item
});

it("does not find another shop's barcode", async () => {
  const other = await seedShop(db);
  await productFor(db, await ctxFor(db, other, 'owner', t0), { variants: [{ barcodes: ['6001111111111'], basePricePesewas: 1, costPesewas: 1 }] });
  expect(await parseScannedCode(db, owner, '6001111111111')).toEqual({ found: false });
  expect(await parseScannedCode(db, owner, 'not a code')).toEqual({ found: false });
});

it('marks archived items unavailable', async () => {
  const p = await productFor(db, owner, { variants: [{ barcodes: ['6002222222222'], basePricePesewas: 1, costPesewas: 1 }] });
  await setProductStatus(db, owner, p.productId, 'archived');
  expect(await parseScannedCode(db, owner, '6002222222222')).toMatchObject({ found: true, available: false });
});

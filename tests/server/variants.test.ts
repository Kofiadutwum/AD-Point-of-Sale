import { and, eq } from 'drizzle-orm';
import { afterEach, beforeEach, expect, it } from 'vitest';
import type { Db } from '@/db/client';
import { auditLog, barcodes, priceListItems, priceLists, variants } from '@/db/schema';
import { asPlatform, withTenant } from '@/db/tenant';
import type { Ctx } from '@/server/context';
import { getProduct } from '@/server/products';
import {
  addBarcode, addComponent, addUnit, addVariant, costOf, removeUnit, setVariantStatus, updateUnit, updateVariant,
} from '@/server/variants';
import { saveSellingSettings } from '@/server/shop-settings';
import { ctxFor, productFor, type SeededShop, seedShop, WEIGHT_LAYOUT } from '../helpers/fixtures';
import { createTestDb } from '../helpers/test-db';

const t0 = new Date('2026-10-20T10:00:00Z');
const unit = (name: string, factor: string, pricePesewas: number | null = null) => ({ name, factor, pricePesewas, sellable: true, purchasable: true });
const item = (sku: string, costPesewas: number, extra: Record<string, unknown> = {}) =>
  ({ ...extra, variants: [{ sku, basePricePesewas: costPesewas * 2, costPesewas }] });

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

it('sells by strip and pack: units carry factors and their own prices', async () => {
  const p = await productFor(db, owner, { baseUnit: 'tablet', variants: [{ basePricePesewas: 150, costPesewas: 100 }] });
  expect(await addUnit(db, owner, p.variantId, { name: 'strip', factor: '10', pricePesewas: 1200, sellable: true, purchasable: false })).toMatchObject({ ok: true });
  expect(await addUnit(db, owner, p.variantId, unit('pack', '30'))).toMatchObject({ ok: true });
  const d = await getProduct(db, owner, p.productId);
  expect(d!.variants[0].units.map((u) => [u.name, u.factor, u.pricePesewas]))
    .toEqual([['tablet', '1.000', null], ['strip', '10.000', 1200], ['pack', '30.000', null]]);
});

it('rejects unit factors of 1 or less and duplicate names', async () => {
  const p = await productFor(db, owner, { baseUnit: 'tablet' });
  expect(await addUnit(db, owner, p.variantId, unit('pair', '1'))).toEqual({ ok: false, error: 'invalid_input' });
  expect(await addUnit(db, owner, p.variantId, unit('half', '0.5'))).toEqual({ ok: false, error: 'invalid_input' });
  await addUnit(db, owner, p.variantId, unit('strip', '10'));
  expect(await addUnit(db, owner, p.variantId, unit('Strip', '12'))).toEqual({ ok: false, error: 'duplicate_name' });
  expect(await updateUnit(db, owner, p.baseUnitId, unit('tablet', '2'))).toEqual({ ok: false, error: 'invalid_input' });
  expect(await updateUnit(db, owner, p.baseUnitId, { ...unit('tab', '1'), purchasable: false })).toEqual({ ok: true });
});

it('removing a unit removes its barcodes and price list items; the base unit stays', async () => {
  const p = await productFor(db, owner);
  const { unitId } = await addUnit(db, owner, p.variantId, unit('carton', '24', 10000)) as { unitId: string };
  await addBarcode(db, owner, unitId, '6009876543210');
  await asPlatform(db, async (tx) => {
    const [list] = await tx.insert(priceLists).values({ tenantId: shop.tenantId, name: 'Retail', kind: 'retail' }).returning();
    await tx.insert(priceListItems).values({ tenantId: shop.tenantId, priceListId: list.id, variantId: p.variantId, unitId, pricePesewas: 9500 });
  });
  expect(await removeUnit(db, owner, unitId)).toEqual({ ok: true });
  expect(await asPlatform(db, (tx) => tx.select().from(barcodes).where(eq(barcodes.unitId, unitId)))).toEqual([]);
  expect(await asPlatform(db, (tx) => tx.select().from(priceListItems).where(eq(priceListItems.unitId, unitId)))).toEqual([]);
  expect(await removeUnit(db, owner, p.baseUnitId)).toEqual({ ok: false, error: 'base_unit' });
});

it('adds a carton barcode that points at the carton unit', async () => {
  const p = await productFor(db, owner);
  const { unitId } = await addUnit(db, owner, p.variantId, unit('carton', '24')) as { unitId: string };
  expect(await addBarcode(db, owner, unitId, ' 6009876543210 ')).toMatchObject({ ok: true });
  expect(await addBarcode(db, owner, p.baseUnitId, '6009876543210')).toEqual({ ok: false, error: 'duplicate_barcode', detail: '6009876543210' });
  const d = await getProduct(db, owner, p.productId);
  expect(d!.variants[0].units[1]).toMatchObject({ name: 'carton', barcodes: [{ code: '6009876543210' }] });
});

it('blocks bundles that contain themselves, directly or through another bundle', async () => {
  const a = await productFor(db, owner, { kind: 'bundle', ...item('A', 0) });
  await productFor(db, owner, { kind: 'bundle', ...item('B', 0) });
  const c = await productFor(db, owner, { kind: 'bundle', ...item('C', 0) });
  expect(await addComponent(db, owner, a.variantId, { code: 'A', quantity: '1' })).toEqual({ ok: false, error: 'contains_itself' });
  expect(await addComponent(db, owner, c.variantId, { code: 'A', quantity: '1' })).toMatchObject({ ok: true });
  expect(await addComponent(db, owner, a.variantId, { code: 'C', quantity: '1' })).toEqual({ ok: false, error: 'contains_itself' });
  expect(await addComponent(db, owner, a.variantId, { code: 'B', quantity: '1' })).toMatchObject({ ok: true });
  expect(await addComponent(db, owner, a.variantId, { code: 'b', quantity: '2' })).toEqual({ ok: false, error: 'duplicate_component' });
});

it('refuses components from another shop and fractions of whole items', async () => {
  const other = await seedShop(db);
  await productFor(db, await ctxFor(db, other, 'owner', t0), item('ONLYB', 100));
  const bundle = await productFor(db, owner, { kind: 'bundle', ...item('HAMPER', 0) });
  const piece = await productFor(db, owner, item('SOAP', 100));
  expect(await addComponent(db, owner, bundle.variantId, { code: 'ONLYB', quantity: '1' })).toEqual({ ok: false, error: 'unknown_component' });
  expect(await addComponent(db, owner, bundle.variantId, { code: 'SOAP', quantity: '0.5' })).toEqual({ ok: false, error: 'invalid_quantity' });
  expect(await addComponent(db, owner, piece.variantId, { code: 'HAMPER', quantity: '1' })).toEqual({ ok: false, error: 'not_a_bundle' });
});

it('works out recipe and bundle cost from component costs', async () => {
  const fractions = { baseUnit: 'kg', allowsFractions: true };
  await productFor(db, owner, { name: 'Rice', ...item('RICE', 1200, fractions) });
  await productFor(db, owner, { name: 'Oil', ...item('OIL', 3000, { baseUnit: 'litre', allowsFractions: true }) });
  await productFor(db, owner, { name: 'Chicken', ...item('CHICKEN', 1500) });
  await productFor(db, owner, { name: 'Milo', ...item('MILO', 3800) });
  const jollof = await productFor(db, owner, { name: 'Jollof', kind: 'recipe', ...item('JOLLOF', 0) });
  const pack = await productFor(db, owner, { name: 'Pack', kind: 'bundle', ...item('PACK', 0) });
  for (const [code, quantity] of [['RICE', '0.250'], ['OIL', '0.05'], ['CHICKEN', '1']]) {
    expect(await addComponent(db, owner, jollof.variantId, { code, quantity })).toMatchObject({ ok: true });
  }
  await addComponent(db, owner, pack.variantId, { code: 'JOLLOF', quantity: '2' });
  await addComponent(db, owner, pack.variantId, { code: 'MILO', quantity: '1' });
  expect(await withTenant(db, shop.tenantId, (tx) => costOf(tx, jollof.variantId))).toBe('1950.0000');
  expect(await withTenant(db, shop.tenantId, (tx) => costOf(tx, pack.variantId))).toBe('7700.0000');
});

it('refuses to archive the last active variant', async () => {
  const p = await productFor(db, owner);
  expect(await setVariantStatus(db, owner, p.variantId, 'archived')).toEqual({ ok: false, error: 'last_variant' });
  expect(await addVariant(db, owner, p.productId, { name: 'Large', basePricePesewas: 700, costPesewas: 500 })).toMatchObject({ ok: true });
  expect(await setVariantStatus(db, owner, p.variantId, 'archived')).toEqual({ ok: true });
  const d = await getProduct(db, owner, p.productId);
  expect(d!.variants.map((v) => [v.name, v.status, v.units[0].name])).toEqual([['', 'archived', 'piece'], ['Large', 'active', 'piece']]);
});

it('records price changes in the audit log', async () => {
  const p = await productFor(db, owner, { variants: [{ sku: 'M1', basePricePesewas: 4500, costPesewas: 3800 }] });
  const fields = { name: '', sku: 'M1', basePricePesewas: 5000, costPesewas: 3800, reorderLevel: null, scaleItemCode: null, sellable: true, allowsFractions: false };
  expect(await updateVariant(db, owner, p.variantId, fields)).toEqual({ ok: true });
  const [row] = await asPlatform(db, (tx) => tx.select().from(auditLog)
    .where(and(eq(auditLog.tenantId, shop.tenantId), eq(auditLog.action, 'variant_updated'))));
  expect(row.changes).toEqual({ basePricePesewas: [4500, 5000] });
  const other = await productFor(db, owner, { variants: [{ sku: 'M2', basePricePesewas: 1, costPesewas: 1 }] });
  expect(await updateVariant(db, owner, other.variantId, { ...fields, sku: 'm1' })).toEqual({ ok: false, error: 'duplicate_sku', detail: 'M1' });
});

it("will not rename a weighed item's base unit away from kg", async () => {
  await saveSellingSettings(db, owner, { taxEnabled: false, scaleLayout: WEIGHT_LAYOUT, modules: [] });
  const p = await productFor(db, owner, { baseUnit: 'kg', allowsFractions: true, variants: [{ scaleItemCode: 123, basePricePesewas: 9000, costPesewas: 7000 }] });
  expect(await updateUnit(db, owner, p.baseUnitId, unit('piece', '1'))).toEqual({ ok: false, error: 'invalid_input' });
  expect(await updateUnit(db, owner, p.baseUnitId, unit('KG', '1'))).toEqual({ ok: true });
});

it('keeps the scale code when an edit leaves it out', async () => {
  await saveSellingSettings(db, owner, { taxEnabled: false, scaleLayout: WEIGHT_LAYOUT, modules: [] });
  const p = await productFor(db, owner, { baseUnit: 'kg', allowsFractions: true, variants: [{ sku: 'BEEF', scaleItemCode: 123, basePricePesewas: 9000, costPesewas: 7000 }] });
  const fields = { name: '', sku: 'BEEF', basePricePesewas: 9500, costPesewas: null, reorderLevel: null, sellable: true, allowsFractions: true };
  expect(await updateVariant(db, owner, p.variantId, fields)).toEqual({ ok: true });
  expect((await getProduct(db, owner, p.productId))!.variants[0]).toMatchObject({ basePricePesewas: 9500, scaleItemCode: 123 });
});

it('keeps a fractional average cost when an edit leaves the cost out', async () => {
  const p = await productFor(db, owner, { variants: [{ sku: 'TAB', basePricePesewas: 10, costPesewas: 4 }] });
  await asPlatform(db, (tx) => tx.update(variants).set({ averageCost: '4.5000' }).where(eq(variants.id, p.variantId)));
  const fields = { name: '', sku: 'TAB', basePricePesewas: 12, costPesewas: null, reorderLevel: null, scaleItemCode: null, sellable: true, allowsFractions: false };
  expect(await updateVariant(db, owner, p.variantId, fields)).toEqual({ ok: true });
  expect((await getProduct(db, owner, p.productId))!.variants[0]).toMatchObject({ basePricePesewas: 12, averageCost: '4.5000' });
});

it('saves needs pack on a variant', async () => {
  const p = await productFor(db, owner, { variants: [{ basePricePesewas: 3000, costPesewas: 1500 }] });
  const fields = { name: '', sku: null, basePricePesewas: 3000, costPesewas: null, reorderLevel: null, sellable: true, allowsFractions: false };
  expect(await updateVariant(db, owner, p.variantId, { ...fields, needsPack: true })).toEqual({ ok: true });
  const read = async () => (await asPlatform(db, (tx) => tx.select({ needsPack: variants.needsPack }).from(variants).where(eq(variants.id, p.variantId))))[0].needsPack;
  expect(await read()).toBe(true);
  expect(await updateVariant(db, owner, p.variantId, fields)).toEqual({ ok: true }); // left out: kept
  expect(await read()).toBe(true);
});

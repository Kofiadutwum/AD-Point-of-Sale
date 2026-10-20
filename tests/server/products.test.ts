import { and, eq } from 'drizzle-orm';
import { afterEach, beforeEach, expect, it } from 'vitest';
import type { Db } from '@/db/client';
import { auditLog, products } from '@/db/schema';
import { asPlatform } from '@/db/tenant';
import type { Ctx } from '@/server/context';
import {
  addCategory, createProduct, getProduct, type NewProductInput, type NewVariantInput, searchCatalogue, setProductStatus, updateProduct,
} from '@/server/products';
import { saveSellingSettings } from '@/server/shop-settings';
import { saveTaxRule } from '@/server/tax-rules';
import { ctxFor, expectAccess, PRICE_LAYOUT, productFor, type SeededShop, seedShop, WEIGHT_LAYOUT } from '../helpers/fixtures';
import { createTestDb } from '../helpers/test-db';

const t0 = new Date('2026-10-20T10:00:00Z');
const input = (v: Partial<NewVariantInput> = {}, p: Partial<NewProductInput> = {}): NewProductInput => ({
  name: 'Item', kind: 'standard', tracking: 'none', baseUnit: 'piece', allowsFractions: false,
  variants: [{ basePricePesewas: 500, costPesewas: 400, ...v }], ...p,
});
const kg = { baseUnit: 'kg', allowsFractions: true };

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

it('creates a product with its default variant, base unit, and barcode', async () => {
  const r = await createProduct(db, owner, { name: 'Milo 400g', kind: 'standard', tracking: 'none', baseUnit: 'piece', allowsFractions: false,
    variants: [{ sku: 'milo-400', barcodes: ['6001234567890'], basePricePesewas: 4500, costPesewas: 3800 }] }) as { productId: string };
  expect(await getProduct(db, owner, r.productId)).toMatchObject({ name: 'Milo 400g', status: 'active', showOnStorefront: false,
    variants: [{ sku: 'MILO-400', basePricePesewas: 4500, averageCost: '3800.0000',
      units: [{ name: 'piece', factor: '1.000', isBase: true, barcodes: [{ code: '6001234567890' }] }] }] });
  const audit = await asPlatform(db, (tx) => tx.select().from(auditLog)
    .where(and(eq(auditLog.tenantId, shop.tenantId), eq(auditLog.action, 'product_created'))));
  expect(audit).toHaveLength(1);
});

it('rejects duplicate SKUs and barcodes within a shop, but not across shops', async () => {
  await productFor(db, owner, { variants: [{ sku: 'A1', barcodes: ['036000291452'], basePricePesewas: 1, costPesewas: 1 }] });
  expect(await createProduct(db, owner, input({ sku: 'a1' }))).toEqual({ ok: false, error: 'duplicate_sku', detail: 'A1' });
  expect(await createProduct(db, owner, input({ barcodes: ['0036000291452'] }))).toEqual({ ok: false, error: 'duplicate_barcode', detail: '0036000291452' });
  const other = await seedShop(db);
  const otherOwner = await ctxFor(db, other, 'owner', t0);
  expect(await createProduct(db, otherOwner, input({ sku: 'A1', barcodes: ['036000291452'] }))).toMatchObject({ ok: true });
});

it('rejects two variants sharing a barcode in one request', async () => {
  const twoVariants = input({}, { variants: [
    { name: 'Red', barcodes: ['111'], basePricePesewas: 1, costPesewas: 1 },
    { name: 'Blue', barcodes: [' 111 '], basePricePesewas: 1, costPesewas: 1 },
  ] });
  expect(await createProduct(db, owner, twoVariants)).toEqual({ ok: false, error: 'duplicate_barcode', detail: '111' });
});

it("refuses barcodes that look like the shop's scale labels", async () => {
  await saveSellingSettings(db, owner, { taxEnabled: false, scaleLayout: WEIGHT_LAYOUT, modules: [] });
  expect(await createProduct(db, owner, input({ barcodes: ['2100123012503'] })))
    .toEqual({ ok: false, error: 'looks_like_scale_label', detail: '2100123012503' });
});

it('validates tracking, kind, price, and scale rules', async () => {
  const invalid = { ok: false, error: 'invalid_input' };
  expect(await createProduct(db, owner, input({}, { tracking: 'serial', allowsFractions: true }))).toEqual(invalid);
  expect(await createProduct(db, owner, input({}, { kind: 'bundle', tracking: 'batch' }))).toEqual(invalid);
  expect(await createProduct(db, owner, input({ basePricePesewas: -1 }))).toEqual(invalid);
  expect(await createProduct(db, owner, input({ basePricePesewas: 1.5 }))).toEqual(invalid);
  expect(await createProduct(db, owner, input({ scaleItemCode: 123 }, kg))).toEqual({ ok: false, error: 'scale_not_set_up' });

  await saveSellingSettings(db, owner, { taxEnabled: false, scaleLayout: WEIGHT_LAYOUT, modules: [] });
  expect(await createProduct(db, owner, input({ scaleItemCode: 123 }, { baseUnit: 'piece', allowsFractions: true }))).toEqual(invalid);
  expect(await createProduct(db, owner, input({ scaleItemCode: 123 }, { baseUnit: 'kg', allowsFractions: false }))).toEqual(invalid);
  expect(await createProduct(db, owner, input({ scaleItemCode: 100000 }, kg))).toEqual(invalid);
  expect(await createProduct(db, owner, input({ scaleItemCode: 123 }, kg))).toMatchObject({ ok: true });
  expect(await createProduct(db, owner, input({ scaleItemCode: 123 }, kg))).toEqual({ ok: false, error: 'duplicate_scale_code', detail: '123' });

  await saveSellingSettings(db, owner, { taxEnabled: false, scaleLayout: PRICE_LAYOUT, modules: [] });
  expect(await createProduct(db, owner, input({ scaleItemCode: 456, basePricePesewas: 0 }, kg))).toEqual(invalid);
  expect(await createProduct(db, owner, input({ scaleItemCode: 456 }, { baseUnit: 'kg', allowsFractions: false }))).toEqual(invalid);
});

it('stops at the plan product limit, and restoring counts too', async () => {
  const trial = await seedShop(db, { subscription: { status: 'trial', endDate: '2026-11-03', planId: 'trial' } });
  const ctx = await ctxFor(db, trial, 'owner', t0);
  await asPlatform(db, (tx) => tx.insert(products).values(Array.from({ length: 499 }, (_, i) => ({ tenantId: trial.tenantId, name: `P${i}` }))));
  const last = await createProduct(db, ctx, input()) as { productId: string };
  expect(last).toMatchObject({ ok: true });
  expect(await createProduct(db, ctx, input())).toEqual({ ok: false, error: 'limit_reached' });
  expect(await setProductStatus(db, ctx, last.productId, 'archived')).toEqual({ ok: true });
  expect(await createProduct(db, ctx, input())).toMatchObject({ ok: true });
  expect(await setProductStatus(db, ctx, last.productId, 'active')).toEqual({ ok: false, error: 'limit_reached' });
});

it("refuses another shop's category or tax rule", async () => {
  const other = await seedShop(db);
  const otherOwner = await ctxFor(db, other, 'owner', t0);
  const { categoryId } = await addCategory(db, otherOwner, 'Drinks') as { categoryId: string };
  const { taxRuleId } = await saveTaxRule(db, otherOwner, { name: 'VAT', rateBp: 1500, levies: [], vatOnLevies: false, isDefault: false, active: true }) as { taxRuleId: string };
  expect(await createProduct(db, owner, input({}, { categoryId }))).toEqual({ ok: false, error: 'unknown_category' });
  expect(await createProduct(db, owner, input({}, { taxRuleId }))).toEqual({ ok: false, error: 'unknown_tax_rule' });
  const off = await saveTaxRule(db, owner, { name: 'Old', rateBp: 100, levies: [], vatOnLevies: false, isDefault: false, active: false }) as { taxRuleId: string };
  expect(await createProduct(db, owner, input({}, { taxRuleId: off.taxRuleId }))).toEqual({ ok: false, error: 'unknown_tax_rule' });
});

it('searches by name, generic name, SKU, barcode, and category, treating % and _ literally', async () => {
  const { categoryId } = await addCategory(db, owner, 'Dairy') as { categoryId: string };
  await productFor(db, owner, { name: 'Paracetamol 500mg', pharmacy: { genericName: 'acetaminophen' } });
  await productFor(db, owner, { name: '50% Off Soap', variants: [{ sku: 'SOAP-1', basePricePesewas: 1, costPesewas: 1 }] });
  await productFor(db, owner, { name: 'Milk', categoryId, variants: [{ barcodes: ['036000291452'], basePricePesewas: 1, costPesewas: 1 }] });
  const names = async (query: string) => (await searchCatalogue(db, owner, { query })).map((h) => h.productName);
  expect(await names('acetamin')).toEqual(['Paracetamol 500mg']);
  expect(await names('50%')).toEqual(['50% Off Soap']);
  expect(await names('_')).toEqual([]);
  expect(await names('dairy')).toEqual(['Milk']);
  expect(await names('soap-1')).toEqual(['50% Off Soap']);
  expect(await names('0036000291452')).toEqual(['Milk']);
  expect(await names('')).toEqual(['50% Off Soap', 'Milk', 'Paracetamol 500mg']);
});

it('archives and restores', async () => {
  const p = await productFor(db, owner, { name: 'Old stock' });
  expect(await setProductStatus(db, owner, p.productId, 'archived')).toEqual({ ok: true });
  expect(await searchCatalogue(db, owner, {})).toEqual([]);
  expect(await searchCatalogue(db, owner, { status: 'archived' })).toMatchObject([{ productName: 'Old stock', status: 'archived' }]);
  expect(await setProductStatus(db, owner, p.productId, 'active')).toEqual({ ok: true });
  expect(await searchCatalogue(db, owner, {})).toMatchObject([{ productName: 'Old stock', status: 'active' }]);
});

it('updates product fields, keeping tracking rules, and records what changed', async () => {
  const kgItem = await productFor(db, owner, { name: 'Rice', ...kg });
  expect(await updateProduct(db, owner, kgItem.productId, { name: 'Rice', tracking: 'serial' })).toEqual({ ok: false, error: 'invalid_input' });
  expect(await updateProduct(db, owner, kgItem.productId, { name: 'Jasmine rice', tracking: 'batch', brand: 'Royal' })).toEqual({ ok: true });
  expect(await getProduct(db, owner, kgItem.productId)).toMatchObject({ name: 'Jasmine rice', tracking: 'batch', brand: 'Royal' });
  const [audit] = await asPlatform(db, (tx) => tx.select().from(auditLog).where(eq(auditLog.action, 'product_updated')));
  expect(audit.changes).toEqual({ fields: ['name', 'brand', 'tracking'] });
  expect(await updateProduct(db, owner, '33333333-3333-4333-8333-333333333333', { name: 'X', tracking: 'none' })).toEqual({ ok: false, error: 'not_found' });
});

it('keeps fields an edit leaves out, such as pharmacy fields hidden with the module off', async () => {
  const { categoryId } = await addCategory(db, owner, 'Medicines') as { categoryId: string };
  const p = await productFor(db, owner, {
    name: 'Amoxicillin', categoryId, showOnStorefront: true, pharmacy: { genericName: 'amoxicillin', strength: '500 mg', prescriptionOnly: true },
  });
  expect(await updateProduct(db, owner, p.productId, { name: 'Amoxil 500', tracking: 'none' })).toEqual({ ok: true });
  expect(await getProduct(db, owner, p.productId)).toMatchObject({
    name: 'Amoxil 500', categoryId, showOnStorefront: true, genericName: 'amoxicillin', strength: '500 mg', prescriptionOnly: true,
  });
});

it('cashiers and read-only shops cannot change products', async () => {
  await expectAccess(createProduct(db, await ctxFor(db, shop, 'kofi', t0), input()), 'forbidden');
  const lapsed = await seedShop(db, { subscription: { status: 'active', endDate: '2026-09-01' } });
  await expectAccess(createProduct(db, await ctxFor(db, lapsed, 'owner', t0), input()), 'read_only');
});

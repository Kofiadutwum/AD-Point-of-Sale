import { getTableName } from 'drizzle-orm';
import type { PgTable } from 'drizzle-orm/pg-core';
import { afterEach, beforeEach, expect, it } from 'vitest';
import type { Db } from '@/db/client';
import {
  barcodes, categories, components, priceListItems, priceLists, productImages, products, taxRules, variants, variantUnits,
} from '@/db/schema';
import { asPlatform, withTenant } from '@/db/tenant';
import { type SeededShop, seedShop } from '../helpers/fixtures';
import { createTestDb, dbError } from '../helpers/test-db';

/** One row in every catalogue table (two variants and units), written as the owner role so RLS does not apply. */
function seedCatalogueRows(db: Db, shop: SeededShop) {
  const tenantId = shop.tenantId;
  return asPlatform(db, async (tx) => {
    const [rule] = await tx.insert(taxRules).values({ tenantId, name: 'VAT', rateBp: 1500 }).returning();
    const [category] = await tx.insert(categories).values({ tenantId, name: 'Gifts' }).returning();
    const [product] = await tx.insert(products).values({ tenantId, name: 'Hamper', categoryId: category.id, taxRuleId: rule.id }).returning();
    const [bundle] = await tx.insert(variants).values({ tenantId, productId: product.id, kind: 'bundle', basePricePesewas: 10000 }).returning();
    const [part] = await tx.insert(variants).values({ tenantId, productId: product.id, basePricePesewas: 500 }).returning();
    await tx.insert(variantUnits).values({ tenantId, variantId: bundle.id, name: 'piece', factor: '1', isBase: true });
    const [partUnit] = await tx.insert(variantUnits).values({ tenantId, variantId: part.id, name: 'piece', factor: '1', isBase: true }).returning();
    await tx.insert(barcodes).values({ tenantId, variantId: part.id, unitId: partUnit.id, code: '6001234567890' });
    await tx.insert(components).values({ tenantId, parentVariantId: bundle.id, componentVariantId: part.id, quantity: '2' });
    const [list] = await tx.insert(priceLists).values({ tenantId, name: 'Retail', kind: 'retail' }).returning();
    await tx.insert(priceListItems).values({ tenantId, priceListId: list.id, variantId: part.id, unitId: partUnit.id, minQuantity: '12', pricePesewas: 450 });
    await tx.insert(productImages).values({
      tenantId, productId: product.id, storageKey: `${tenantId}/${product.id}/a.webp`, bytes: 25000, width: 800, height: 600, sortOrder: 0,
    });
    return { productId: product.id, bundleVariantId: bundle.id, partVariantId: part.id, partUnitId: partUnit.id };
  });
}

let db: Db;
let close: () => Promise<void>;
let a: SeededShop;
let b: SeededShop;
let ra: Awaited<ReturnType<typeof seedCatalogueRows>>;
let rb: Awaited<ReturnType<typeof seedCatalogueRows>>;
beforeEach(async () => {
  ({ db, close } = await createTestDb());
  a = await seedShop(db, { slug: 'shop-a' });
  b = await seedShop(db, { slug: 'shop-b' });
  ra = await seedCatalogueRows(db, a);
  rb = await seedCatalogueRows(db, b);
});
afterEach(async () => { await close(); });

it('each shop sees only its own catalogue rows', async () => {
  const expected = new Map<PgTable, number>([[taxRules, 1], [categories, 1], [products, 1], [variants, 2], [variantUnits, 2], [barcodes, 1],
    [components, 1], [priceLists, 1], [priceListItems, 1], [productImages, 1]]);
  for (const [t, n] of expected) expect(await withTenant(db, a.tenantId, (tx) => tx.select().from(t)), getTableName(t)).toHaveLength(n);
});

it("composite keys stop links to another shop's rows", async () => {
  expect(await dbError(asPlatform(db, (tx) => tx.insert(variants)
    .values({ tenantId: a.tenantId, productId: rb.productId, basePricePesewas: 100 })))).toMatch(/foreign key/);
  expect(await dbError(asPlatform(db, (tx) => tx.insert(barcodes)
    .values({ tenantId: a.tenantId, variantId: ra.partVariantId, unitId: rb.partUnitId, code: 'X1' })))).toMatch(/foreign key/);
  expect(await dbError(asPlatform(db, (tx) => tx.insert(priceLists)
    .values({ tenantId: a.tenantId, name: 'B branch', kind: 'branch', branchId: b.branchId })))).toMatch(/foreign key/);
});

it('a barcode is unique within a shop but may repeat across shops', async () => {
  // both shops already hold 6001234567890
  expect(await dbError(asPlatform(db, (tx) => tx.insert(barcodes)
    .values({ tenantId: a.tenantId, variantId: ra.partVariantId, unitId: ra.partUnitId, code: '6001234567890' })))).toMatch(/duplicate key/);
});

it('keeps one base unit per variant, one Retail list per shop, and base units at factor 1', async () => {
  expect(await dbError(asPlatform(db, (tx) => tx.insert(variantUnits)
    .values({ tenantId: a.tenantId, variantId: ra.partVariantId, name: 'each', factor: '1', isBase: true })))).toMatch(/duplicate key/);
  expect(await dbError(asPlatform(db, (tx) => tx.insert(priceLists)
    .values({ tenantId: a.tenantId, name: 'Retail 2', kind: 'retail' })))).toMatch(/duplicate key/);
  expect(await dbError(asPlatform(db, (tx) => tx.insert(variantUnits)
    .values({ tenantId: a.tenantId, variantId: ra.partVariantId, name: 'pair', factor: '1', isBase: false })))).toMatch(/check constraint/);
});

import { afterEach, beforeEach, expect, it } from 'vitest';
import type { Db } from '@/db/client';
import { barcodes, products, variants, variantUnits } from '@/db/schema';
import { asPlatform } from '@/db/tenant';
import type { Module } from '@/lib/permissions';
import type { Ctx } from '@/server/context';
import { getSellingSettings, saveSellingSettings } from '@/server/shop-settings';
import { ctxFor, expectAccess, PRICE_LAYOUT, productFor, type SeededShop, seedShop, WEIGHT_LAYOUT } from '../helpers/fixtures';
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
    { key: 'manager', phone: '0241111111', rolePreset: 'manager' },
  ] });
  owner = await ctxFor(db, shop, 'owner', t0);
});
afterEach(async () => { await close(); });

it('starts with tax off, no scale labels, and the shop type modules', async () => {
  expect(await getSellingSettings(db, owner)).toEqual({ taxEnabled: false, scaleLayout: null, modules: ['serials', 'price_lists', 'scale_barcodes'] });
});

it('saves the tax switch, scale layout, and modules', async () => {
  expect(await saveSellingSettings(db, owner, { taxEnabled: true, scaleLayout: WEIGHT_LAYOUT, modules: ['batches', 'scale_barcodes', 'batches'] }))
    .toEqual({ ok: true });
  expect(await getSellingSettings(db, owner)).toEqual({ taxEnabled: true, scaleLayout: WEIGHT_LAYOUT, modules: ['batches', 'scale_barcodes'] });
});

it('rejects unknown modules and malformed layouts', async () => {
  expect(await saveSellingSettings(db, owner, { taxEnabled: false, scaleLayout: null, modules: ['fly' as Module] })).toEqual({ ok: false, error: 'invalid_input' });
  expect(await saveSellingSettings(db, owner, { taxEnabled: false, scaleLayout: { ...WEIGHT_LAYOUT, prefix: '9' }, modules: [] }))
    .toEqual({ ok: false, error: 'invalid_input' });
});

it('refuses a scale layout that clashes with saved barcodes', async () => {
  await asPlatform(db, async (tx) => {
    const tenantId = shop.tenantId;
    const [p] = await tx.insert(products).values({ tenantId, name: 'Rice' }).returning();
    const [v] = await tx.insert(variants).values({ tenantId, productId: p.id, basePricePesewas: 100 }).returning();
    const [u] = await tx.insert(variantUnits).values({ tenantId, variantId: v.id, name: 'bag', factor: '1', isBase: true }).returning();
    await tx.insert(barcodes).values({ tenantId, variantId: v.id, unitId: u.id, code: '2100123012503' });
  });
  expect(await saveSellingSettings(db, owner, { taxEnabled: false, scaleLayout: WEIGHT_LAYOUT, modules: [] }))
    .toEqual({ ok: false, error: 'barcodes_clash', codes: ['2100123012503'] });
  expect((await getSellingSettings(db, owner)).scaleLayout).toBeNull();
});

it('refuses a layout that would misread saved scale items', async () => {
  await saveSellingSettings(db, owner, { taxEnabled: false, scaleLayout: PRICE_LAYOUT, modules: [] });
  await productFor(db, owner, { baseUnit: 'bag', allowsFractions: true, variants: [{ scaleItemCode: 456, basePricePesewas: 900, costPesewas: 1 }] });
  const clash = { ok: false, error: 'scale_codes_clash', codes: ['456'] };
  expect(await saveSellingSettings(db, owner, { taxEnabled: false, scaleLayout: WEIGHT_LAYOUT, modules: [] })).toEqual(clash); // grams of a bag
  expect(await saveSellingSettings(db, owner, { taxEnabled: false, scaleLayout: { ...PRICE_LAYOUT, itemLength: 2, valueStart: 4 }, modules: [] }))
    .toEqual(clash); // 456 no longer fits two digits
  expect((await getSellingSettings(db, owner)).scaleLayout).toEqual(PRICE_LAYOUT);
  expect(await saveSellingSettings(db, owner, { taxEnabled: false, scaleLayout: null, modules: [] })).toEqual({ ok: true });
});

it('needs manage_shop_settings', async () => {
  await expectAccess(saveSellingSettings(db, await ctxFor(db, shop, 'manager', t0), { taxEnabled: true, scaleLayout: null, modules: [] }), 'forbidden');
});

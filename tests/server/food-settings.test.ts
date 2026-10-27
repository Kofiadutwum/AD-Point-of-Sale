import { eq } from 'drizzle-orm';
import { afterEach, beforeEach, expect, it } from 'vitest';
import type { Db } from '@/db/client';
import { branches, variants } from '@/db/schema';
import { asPlatform } from '@/db/tenant';
import { getFoodSettings, saveFoodSettings, setServiceModes } from '@/server/food-settings';
import { ctxFor, expectAccess, productFor, type SeededShop, seedShop } from '../helpers/fixtures';
import { createTestDb } from '../helpers/test-db';

const t0 = new Date('2026-10-26T10:00:00Z');
let db: Db;
let close: () => Promise<void>;
let shop: SeededShop;
beforeEach(async () => {
  ({ db, close } = await createTestDb());
  shop = await seedShop(db, { shopType: 'food', users: [
    { key: 'owner', email: 'o@x.test', rolePreset: 'owner' }, { key: 'cashier', email: 'c@x.test', rolePreset: 'cashier' },
  ] });
});
afterEach(async () => { await close(); });

it('saves the pack variant and fee mode', async () => {
  const owner = await ctxFor(db, shop, 'owner', t0);
  expect(await getFoodSettings(db, owner)).toEqual({ packVariantId: null, packFeeMode: 'per_order' });
  const pack = await productFor(db, owner, { name: 'Takeaway pack' });
  expect(await saveFoodSettings(db, owner, { packVariantId: pack.variantId, packFeeMode: 'per_item' })).toEqual({ ok: true });
  expect(await getFoodSettings(db, owner)).toEqual({ packVariantId: pack.variantId, packFeeMode: 'per_item' });
});

it("refuses a pack that is another shop's or archived", async () => {
  const owner = await ctxFor(db, shop, 'owner', t0);
  const other = await seedShop(db, { shopType: 'food' });
  const foreign = await productFor(db, await ctxFor(db, other, 'owner', t0));
  expect(await saveFoodSettings(db, owner, { packVariantId: foreign.variantId, packFeeMode: 'per_order' })).toMatchObject({ ok: false, error: 'unknown_item' });
  const archived = await productFor(db, owner);
  await asPlatform(db, (tx) => tx.update(variants).set({ status: 'archived' }).where(eq(variants.id, archived.variantId)));
  expect(await saveFoodSettings(db, owner, { packVariantId: archived.variantId, packFeeMode: 'per_order' })).toMatchObject({ ok: false, error: 'unknown_item' });
});

it('refuses food settings when the kitchen module is off', async () => {
  const retail = await seedShop(db);
  const owner = await ctxFor(db, retail, 'owner', t0);
  expect(await saveFoodSettings(db, owner, { packVariantId: null, packFeeMode: 'per_order' })).toMatchObject({ ok: false, error: 'module_off' });
  expect(await setServiceModes(db, owner, retail.branchId, ['counter'])).toMatchObject({ ok: false, error: 'module_off' });
});

it('saves service modes for a branch and refuses unknown modes', async () => {
  const owner = await ctxFor(db, shop, 'owner', t0);
  expect(await setServiceModes(db, owner, shop.branchId, ['quick', 'counter', 'quick'])).toEqual({ ok: true });
  const [b] = await asPlatform(db, (tx) => tx.select().from(branches).where(eq(branches.id, shop.branchId)));
  expect(b.serviceModes).toEqual(['quick', 'counter']);
  expect(await setServiceModes(db, owner, shop.branchId, ['drive_thru' as never])).toMatchObject({ ok: false, error: 'invalid_input' });
  const other = await seedShop(db, { shopType: 'food' });
  expect(await setServiceModes(db, owner, other.branchId, ['counter'])).toMatchObject({ ok: false, error: 'unknown_branch' });
});

it('a cashier cannot change food settings', async () => {
  const cashier = await ctxFor(db, shop, 'cashier', t0);
  await expectAccess(saveFoodSettings(db, cashier, { packVariantId: null, packFeeMode: 'per_order' }), 'forbidden');
  await expectAccess(setServiceModes(db, cashier, shop.branchId, ['counter']), 'forbidden');
});

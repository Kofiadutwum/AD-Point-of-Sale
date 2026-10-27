import { eq } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Db } from '@/db/client';
import { productImages, sessions, subscriptions, variants } from '@/db/schema';
import { asPlatform } from '@/db/tenant';
import { getDeviceCache, getDeviceCacheVersion, readDeviceImage } from '@/server/device-cache';
import { deregisterDevice, registerDevice, switchCashierWithPin } from '@/server/devices';
import { listHeldSales, reportHeldSale, resolveHeldSale } from '@/server/held-sales';
import { saveComboSlots } from '@/server/combos';
import { setServiceModes } from '@/server/food-settings';
import { createProduct } from '@/server/products';
import { setOfflineEnabled } from '@/server/shop-settings';
import { markSoldOut } from '@/server/sold-out';
import { addBarcode } from '@/server/variants';
import { ctxFor, expectAccess, foodShop, productFor, type SeededShop, seedShop, tillCtxFor } from '../helpers/fixtures';
import { memoryImageStore } from '../helpers/image-store';
import { createTestDb } from '../helpers/test-db';

const t0 = new Date('2026-10-20T10:00:00Z');
let db: Db;
let close: () => Promise<void>;
let shop: SeededShop;
let other: SeededShop;
let deviceToken: string;
let otherToken: string;
let productId: string;
const dev = (slug = 'shop-a', token: string | undefined = deviceToken) => ({ deviceToken: token, slug });

beforeEach(async () => {
  ({ db, close } = await createTestDb());
  shop = await seedShop(db, { slug: 'shop-a', users: [
    { key: 'owner', email: 'o@x.test', password: 'correct-horse-1', pin: '9999' },
    { key: 'kofi', phone: '0201234567', rolePreset: 'cashier', pin: '5678' },
    { key: 'esi', phone: '0207654321', rolePreset: 'cashier', pin: '1111', branchIds: [] },
    { key: 'yaw', phone: '0209999999', rolePreset: 'cashier', pin: '2222', status: 'inactive' },
  ] });
  other = await seedShop(db, { slug: 'shop-b' });
  const owner = await ctxFor(db, shop, 'owner', t0, 'manage_devices');
  deviceToken = (await registerDevice(db, owner, shop.registerId, t0) as { deviceToken: string }).deviceToken;
  otherToken = (await registerDevice(db, await ctxFor(db, other, 'owner', t0, 'manage_devices'), other.registerId, t0) as { deviceToken: string }).deviceToken;
  const products = await ctxFor(db, shop, 'owner', t0, 'manage_products');
  const p = await productFor(db, products, { name: 'Milo 400g' });
  productId = p.productId;
  expect(await addBarcode(db, products, p.baseUnitId, '6001234567890')).toMatchObject({ ok: true });
});
afterEach(async () => { await close(); });

const report = (saleId: string, status: 'held' | 'synced' = 'held') => ({
  saleId, receiptNumber: 'B1-T1-000007', cashierId: shop.users.kofi.id, totalPesewas: 2500, error: 'cashier_not_allowed',
  sale: { saleId }, deviceCreatedAt: t0.toISOString(), status,
});

it('gives a registered device its catalogue, settings, and branch staff with PIN hashes', async () => {
  const c = await getDeviceCache(db, dev(), t0);
  expect(c!.register).toMatchObject({ registerCode: 'T1', branchCode: 'B1', name: 'Till 1' });
  expect(c!.shop).toMatchObject({ offlineEnabled: true, canSell: true, taxMode: 'inclusive' });
  expect(c!.staff.map((s) => s.name).sort()).toEqual(['kofi', 'owner']);
  const kofi = c!.staff.find((s) => s.name === 'kofi')!;
  expect(kofi.pinHash).toMatch(/^\$argon2id\$/);
  expect(kofi.permissions).toEqual(['make_sale', 'mark_sold_out', 'run_kitchen', 'record_kitchen_stock', 'enter_channel_orders']);
  expect(c!.barcodes).toEqual([expect.objectContaining({ code: '6001234567890' })]);
  expect(c!.products[0]).toMatchObject({ name: 'Milo 400g', imageId: null });
  expect(c!.version).toBe(await getDeviceCacheVersion(db, dev()));
});

it('limits an owner to till permissions in the cache', async () => {
  const c = await getDeviceCache(db, dev(), t0);
  expect(c!.staff.find((s) => s.name === 'owner')!.permissions.sort()).toEqual(['approve_actions', 'enter_channel_orders', 'give_discount', 'make_sale', 'mark_sold_out', 'record_kitchen_stock', 'run_kitchen']);
});

it('sends no PIN hashes when the shop switched offline off', async () => {
  await setOfflineEnabled(db, await ctxFor(db, shop, 'owner', t0, 'manage_shop_settings'), false);
  const c = await getDeviceCache(db, dev(), t0);
  expect(c!.shop.offlineEnabled).toBe(false);
  expect(c!.staff.every((s) => s.pinHash === null)).toBe(true);
});

it('refuses unknown tokens, another shop slug, and removed devices', async () => {
  expect(await getDeviceCache(db, dev('shop-a', 'nope'), t0)).toBeNull();
  expect(await getDeviceCache(db, dev('shop-b'), t0)).toBeNull();
  const pin = await switchCashierWithPin(db, { deviceToken, staffId: shop.users.kofi.id, pin: '5678' }, t0);
  expect(pin.ok).toBe(true);
  expect(await deregisterDevice(db, await ctxFor(db, shop, 'owner', t0, 'manage_devices'), shop.registerId)).toEqual({ ok: true });
  expect(await getDeviceCache(db, dev(), t0)).toBeNull();
  expect(await getDeviceCacheVersion(db, dev())).toBeNull();
  const tillSessions = await asPlatform(db, (tx) => tx.select().from(sessions).where(eq(sessions.registerId, shop.registerId)));
  expect(tillSessions).toEqual([]);
});

it('reports canSell false when the subscription is read-only', async () => {
  await asPlatform(db, (tx) => tx.update(subscriptions).set({ endDate: '2026-01-01' }).where(eq(subscriptions.tenantId, shop.tenantId)));
  expect((await getDeviceCache(db, dev(), t0))!.shop.canSell).toBe(false);
});

it('records a held sale once, lists it for managers, and resolves it', async () => {
  const saleId = crypto.randomUUID();
  expect(await reportHeldSale(db, { ...dev(), report: report(saleId) }, t0)).toEqual({ ok: true });
  expect(await reportHeldSale(db, { ...dev(), report: report(saleId) }, t0)).toEqual({ ok: true });
  const owner = await ctxFor(db, shop, 'owner', t0);
  const held = await listHeldSales(db, owner);
  expect(held).toEqual([expect.objectContaining({ receiptNumber: 'B1-T1-000007', registerName: 'Till 1', cashierName: 'kofi', totalPesewas: 2500 })]);
  await expectAccess(listHeldSales(db, await ctxFor(db, shop, 'kofi', t0)), 'forbidden');
  expect(await resolveHeldSale(db, owner, held[0].id, 'Re-entered by hand', t0)).toEqual({ ok: true });
  expect(await listHeldSales(db, owner)).toEqual([]);
  expect((await getDeviceCache(db, dev(), t0))!.resolvedHeldSaleIds).toEqual([saleId]);
  expect(await reportHeldSale(db, { ...dev(), report: report(saleId) }, t0)).toEqual({ ok: true });
  expect(await listHeldSales(db, owner)).toEqual([]); // a resolved sale is never reopened
});

it('marks a held sale synced when the device later sends it', async () => {
  const saleId = crypto.randomUUID();
  await reportHeldSale(db, { ...dev(), report: report(saleId) }, t0);
  await reportHeldSale(db, { ...dev(), report: report(saleId, 'synced') }, t0);
  expect(await listHeldSales(db, await ctxFor(db, shop, 'owner', t0))).toEqual([]);
});

it('refuses malformed held sale reports and unknown devices', async () => {
  expect(await reportHeldSale(db, { ...dev(), report: report('nope') }, t0)).toEqual({ ok: false, error: 'invalid_input' });
  expect(await reportHeldSale(db, { ...dev(), report: { ...report(crypto.randomUUID()), totalPesewas: -1 } }, t0)).toEqual({ ok: false, error: 'invalid_input' });
  expect(await reportHeldSale(db, { ...dev('shop-a', 'nope'), report: report(crypto.randomUUID()) }, t0)).toEqual({ ok: false, error: 'device_not_registered' });
});

it('serves a photo only to a device of the same shop', async () => {
  const store = memoryImageStore();
  const key = `${shop.tenantId}/${productId}/${crypto.randomUUID()}.webp`;
  await store.put(key, new Uint8Array([1, 2, 3]));
  const [img] = await asPlatform(db, (tx) => tx.insert(productImages).values({
    tenantId: shop.tenantId, productId, storageKey: key, bytes: 3, width: 1, height: 1, sortOrder: 0,
  }).returning());
  expect(await readDeviceImage(db, store, { ...dev(), imageId: img.id })).toEqual(new Uint8Array([1, 2, 3]));
  expect(await readDeviceImage(db, store, { ...dev('shop-b', otherToken), imageId: img.id })).toBeNull();
  expect((await getDeviceCache(db, dev(), t0))!.products[0].imageId).toBe(img.id);
});

it('switches offline mode only with manage_shop_settings', async () => {
  await expectAccess(setOfflineEnabled(db, await ctxFor(db, shop, 'kofi', t0), false), 'forbidden');
});

describe('food', () => {
  const at = new Date('2026-10-26T12:00:00Z');
  async function foodDevice(modes: Array<'counter' | 'quick' | 'table'>) {
    const food = await foodShop(db, at, { slug: 'chop-bar' });
    const owner = await ctxFor(db, food, 'owner', at);
    await setServiceModes(db, owner, food.branchId, modes);
    const token = (await registerDevice(db, owner, food.registerId, at) as { deviceToken: string }).deviceToken;
    const jollof = await productFor(db, owner, { name: 'Jollof' });
    await asPlatform(db, (tx) => tx.update(variants).set({ needsPack: true }).where(eq(variants.id, jollof.variantId)));
    return { food, owner, token, jollof };
  }

  it("includes the branch food settings and today's sold-out items", async () => {
    const { food, owner, token, jollof } = await foodDevice(['counter', 'quick']);
    await markSoldOut(db, await tillCtxFor(db, food, 'owner', at), { branchId: food.branchId, variantId: jollof.variantId }, at);
    const c = await getDeviceCache(db, { deviceToken: token, slug: 'chop-bar' }, at);
    expect(c!.food).toEqual({
      serviceModes: ['counter', 'quick'], packVariantId: food.packVariantId, packFeeMode: 'per_order', businessDate: '2026-10-26', soldOutVariantIds: [jollof.variantId],
    });
    expect(c!.shop.businessDayCutoff).toBe('00:00');
    expect(c!.variants.find((v) => v.id === jollof.variantId)!.needsPack).toBe(true);
    expect(owner).toBeDefined();
  });

  it('includes combo slots and by-amount fields', async () => {
    const { food, owner, token } = await foodDevice(['counter']);
    const coke = await productFor(db, owner, { name: 'Coke' });
    const m = await createProduct(db, owner, { name: 'Meal 2', kind: 'combo', tracking: 'none', baseUnit: 'meal', allowsFractions: false, variants: [{ basePricePesewas: 4500, costPesewas: 0 }] });
    const meal = (m as { variants: Array<{ variantId: string }> }).variants[0];
    await saveComboSlots(db, owner, meal.variantId, [{ name: 'Drink', minChoices: 1, maxChoices: 1, choices: [{ variantId: coke.variantId, upgradePesewas: 0 }] }]);
    const c = await getDeviceCache(db, { deviceToken: token, slug: 'chop-bar' }, at);
    expect(c!.comboSlots).toMatchObject([{ comboVariantId: meal.variantId, name: 'Drink', minChoices: 1, maxChoices: 1, choiceNames: { [coke.variantId]: 'Coke' } }]);
    expect(c!.variants.find((v) => v.id === meal.variantId)).toMatchObject({ kind: 'combo', sellByAmount: false, minAmountPesewas: null });
    expect(food).toBeDefined();
  });

  it('food is null when the kitchen module is off', async () => {
    expect((await getDeviceCache(db, dev(), t0))!.food).toBeNull();
  });

  it("leaves table mode out of the till's service modes", async () => {
    const { token } = await foodDevice(['table', 'counter']);
    expect((await getDeviceCache(db, { deviceToken: token, slug: 'chop-bar' }, at))!.food!.serviceModes).toEqual(['counter']);
  });
});

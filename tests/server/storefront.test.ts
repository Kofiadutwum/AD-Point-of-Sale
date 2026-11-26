import { eq } from 'drizzle-orm';
import { afterEach, beforeEach, expect, it } from 'vitest';
import type { Db } from '@/db/client';
import { products, tenants } from '@/db/schema';
import { asPlatform } from '@/db/tenant';
import type { Ctx } from '@/server/context';
import { createPlatformAdmin, platformSignIn } from '@/server/platform-admin';
import { orderLink, publicProduct, publicStorefront, saveStorefront, setPublished, setTakenDown, storefrontStatsSummary } from '@/server/storefront';
import { ctxFor, expectAccess, productFor, type SeededShop, seedShop, stockFor, tillCtxFor } from '../helpers/fixtures';
import { createTestDb } from '../helpers/test-db';

const t0 = new Date('2026-11-26T09:00:00Z');
let db: Db;
let close: () => Promise<void>;
let shop: SeededShop;
let owner: Ctx;
let productId: string;
const settings = { about: 'Best shop in Osu', whatsapp: '024 400 0009', hours: 'Mon-Sat', themeColor: '#aa0000', facebook: '', instagram: '', showPrices: true, showStock: true, announcement: 'New stock', announcementUntil: '2026-11-30' };

beforeEach(async () => {
  ({ db, close } = await createTestDb());
  shop = await seedShop(db, { users: [{ key: 'owner', email: 'o@sf.test', password: 'correct-horse-1', rolePreset: 'owner' }, { key: 'cashier', phone: '0200000001', pin: '1234', rolePreset: 'cashier' }] });
  owner = await ctxFor(db, shop, 'owner', t0);
  const p = await productFor(db, owner); // GHS 5.00
  [{ productId }] = await asPlatform(db, (tx) => tx.select({ productId: products.id }).from(products));
  await stockFor(db, owner, shop.branchId, { variantId: p.variantId, unitId: p.baseUnitId, quantity: '3', totalCostPesewas: 900 }, t0);
});
afterEach(async () => { await close(); });

const show = (on = true) => asPlatform(db, (tx) => tx.update(products).set({ showOnStorefront: on }).where(eq(products.id, productId)));

it('stays hidden until published with at least one product, then shows only public details', async () => {
  expect(await saveStorefront(db, owner, settings)).toEqual({ ok: true });
  expect(await saveStorefront(db, owner, { ...settings, whatsapp: '12' })).toEqual({ ok: false, error: 'invalid_input' });
  await expectAccess(saveStorefront(db, await tillCtxFor(db, shop, 'cashier', t0), settings), 'forbidden');
  expect(await publicStorefront(db, shop.slug, t0)).toBeNull();
  expect(await setPublished(db, owner, true)).toEqual({ ok: false, error: 'no_products' });
  await show();
  expect(await setPublished(db, owner, true)).toEqual({ ok: true });
  const page = await publicStorefront(db, shop.slug, t0);
  expect(page).toMatchObject({ announcement: 'New stock', settings: { whatsapp: '233244000009' } });
  expect(page!.products).toEqual([expect.objectContaining({ id: productId, pricePesewas: 500, inStock: true })]);
  expect(JSON.stringify(page)).not.toMatch(/averageCost|onHand|cost/i);
  expect((await publicStorefront(db, shop.slug, new Date('2026-12-01T09:00:00Z')))!.announcement).toBeNull(); // ended
  await saveStorefront(db, owner, { ...settings, showPrices: false, showStock: false });
  expect((await publicProduct(db, shop.slug, productId, t0))!.product).toMatchObject({ pricePesewas: null, inStock: null });
  await show(false);
  expect(await publicProduct(db, shop.slug, productId, t0)).toBeNull();
});

it('WhatsApp links carry the product and price; prescription-only medicine gets none; clicks and views are counted', async () => {
  await saveStorefront(db, owner, settings);
  await show();
  await setPublished(db, owner, true);
  const url = `https://x.test/${shop.slug}/p/${productId}`;
  const wa = await orderLink(db, shop.slug, 'whatsapp', productId, url, t0);
  expect(decodeURIComponent(wa!)).toContain('https://wa.me/233244000009?text=Hello');
  expect(decodeURIComponent(wa!)).toContain('(GHS 5.00)');
  await publicStorefront(db, shop.slug, t0);
  await publicProduct(db, shop.slug, productId, t0);
  expect(await storefrontStatsSummary(db, owner, t0)).toEqual({ pageViews: 1, productViews: 1, whatsappClicks: 1, callClicks: 0 });
  await asPlatform(db, (tx) => tx.update(products).set({ prescriptionOnly: true }).where(eq(products.id, productId)));
  expect(await orderLink(db, shop.slug, 'whatsapp', productId, url, t0)).toBeNull();
});

it('a taken-down or suspended shop shows no storefront', async () => {
  await show();
  await setPublished(db, owner, true);
  await createPlatformAdmin(db, { email: 'admin@test.local', name: 'Admin', password: 'admin-password-1' });
  const admin = ((await platformSignIn(db, { email: 'admin@test.local', password: 'admin-password-1', ip: '1.1.1.1' }, t0)) as { token: string }).token;
  expect(await setTakenDown(db, admin, shop.tenantId, true, 'x', t0)).toEqual({ ok: false, error: 'reason_required' });
  expect(await setTakenDown(db, admin, shop.tenantId, true, 'Sells prohibited items', t0)).toEqual({ ok: true });
  expect(await publicStorefront(db, shop.slug, t0)).toBeNull();
  await setTakenDown(db, admin, shop.tenantId, false, '', t0);
  expect(await publicStorefront(db, shop.slug, t0)).not.toBeNull();
  await asPlatform(db, (tx) => tx.update(tenants).set({ status: 'suspended' }).where(eq(tenants.id, shop.tenantId)));
  expect(await publicStorefront(db, shop.slug, t0)).toBeNull();
});

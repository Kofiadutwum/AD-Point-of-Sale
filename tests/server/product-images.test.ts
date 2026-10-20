import { and, eq } from 'drizzle-orm';
import sharp from 'sharp';
import { afterEach, beforeAll, beforeEach, expect, it } from 'vitest';
import type { Db } from '@/db/client';
import { auditLog, productImages } from '@/db/schema';
import { asPlatform } from '@/db/tenant';
import type { Ctx } from '@/server/context';
import { makeMainImage, readProductImage, removeProductImage, uploadProductImage } from '@/server/product-images';
import { getProduct } from '@/server/products';
import { ctxFor, expectAccess, productFor, type SeededShop, seedShop } from '../helpers/fixtures';
import { memoryImageStore } from '../helpers/image-store';
import { createTestDb } from '../helpers/test-db';

const t0 = new Date('2026-10-20T10:00:00Z');
let jpeg: Uint8Array;
beforeAll(async () => {
  jpeg = new Uint8Array(await sharp({ create: { width: 1200, height: 900, channels: 3, background: '#808080', noise: { type: 'gaussian', mean: 128, sigma: 30 } } })
    .blur(6).jpeg().toBuffer());
});

let db: Db;
let close: () => Promise<void>;
let shop: SeededShop;
let owner: Ctx;
let store: ReturnType<typeof memoryImageStore>;
beforeEach(async () => {
  ({ db, close } = await createTestDb());
  shop = await seedShop(db, { users: [
    { key: 'owner', email: 'owner@a.test', rolePreset: 'owner' },
    { key: 'kofi', phone: '0201234567', rolePreset: 'cashier' },
  ] });
  owner = await ctxFor(db, shop, 'owner', t0);
  store = memoryImageStore();
});
afterEach(async () => { await close(); });

const order = async (productId: string) => (await getProduct(db, owner, productId))!.images.map((i) => [i.id, i.sortOrder]);

it('stores a compressed WebP under the shop and product; the first photo is main', async () => {
  const p = await productFor(db, owner);
  const r = await uploadProductImage(db, store, owner, p.productId, jpeg) as { ok: true; imageId: string };
  expect(r.ok).toBe(true);
  const [row] = await asPlatform(db, (tx) => tx.select().from(productImages));
  expect(row.storageKey).toMatch(new RegExp(`^${shop.tenantId}/${p.productId}/[0-9a-f-]{36}\\.webp$`));
  expect(row.bytes).toBeLessThanOrEqual(30720);
  expect(row.sortOrder).toBe(0);
  expect(store.keys()).toEqual([row.storageKey]);
  expect(await readProductImage(db, store, owner, r.imageId)).toEqual(await store.get(row.storageKey));
  const audit = await asPlatform(db, (tx) => tx.select().from(auditLog)
    .where(and(eq(auditLog.tenantId, shop.tenantId), eq(auditLog.action, 'product_image_added'))));
  expect(audit).toHaveLength(1);
});

it('allows 5 photos and refuses the sixth without storing it', async () => {
  const p = await productFor(db, owner);
  for (let i = 0; i < 5; i++) expect(await uploadProductImage(db, store, owner, p.productId, jpeg)).toMatchObject({ ok: true });
  expect(await uploadProductImage(db, store, owner, p.productId, jpeg)).toEqual({ ok: false, error: 'image_limit_reached' });
  expect(store.keys()).toHaveLength(5);
});

it('makes a photo main and keeps the order of the others', async () => {
  const p = await productFor(db, owner);
  const ids = [];
  for (let i = 0; i < 3; i++) ids.push((await uploadProductImage(db, store, owner, p.productId, jpeg) as { imageId: string }).imageId);
  expect(await makeMainImage(db, owner, ids[2])).toEqual({ ok: true });
  expect(await order(p.productId)).toEqual([[ids[2], 0], [ids[0], 1], [ids[1], 2]]);
});

it('removes a photo and its stored file', async () => {
  const p = await productFor(db, owner);
  const ids = [];
  for (let i = 0; i < 3; i++) ids.push((await uploadProductImage(db, store, owner, p.productId, jpeg) as { imageId: string }).imageId);
  expect(await removeProductImage(db, store, owner, ids[0])).toEqual({ ok: true });
  expect(await order(p.productId)).toEqual([[ids[1], 0], [ids[2], 1]]);
  expect(store.keys()).toHaveLength(2);
  expect(await removeProductImage(db, store, owner, ids[0])).toEqual({ ok: false, error: 'not_found' });
});

it("never serves another shop's photo", async () => {
  const p = await productFor(db, owner);
  const { imageId } = await uploadProductImage(db, store, owner, p.productId, jpeg) as { imageId: string };
  const other = await seedShop(db);
  const otherOwner = await ctxFor(db, other, 'owner', t0);
  expect(await readProductImage(db, store, otherOwner, imageId)).toBeNull();
  expect(await uploadProductImage(db, store, otherOwner, p.productId, jpeg)).toEqual({ ok: false, error: 'not_found' });
  expect(await removeProductImage(db, store, otherOwner, imageId)).toEqual({ ok: false, error: 'not_found' });
});

it('refuses files that are not photos and needs manage_products to upload', async () => {
  const p = await productFor(db, owner);
  expect(await uploadProductImage(db, store, owner, p.productId, new Uint8Array([1, 2, 3]))).toEqual({ ok: false, error: 'unsupported_type' });
  await expectAccess(uploadProductImage(db, store, await ctxFor(db, shop, 'kofi', t0), p.productId, jpeg), 'forbidden');
  expect(store.keys()).toEqual([]);
});

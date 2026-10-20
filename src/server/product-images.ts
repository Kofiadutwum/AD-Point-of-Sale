import 'server-only';
import { randomUUID } from 'node:crypto';
import { asc, count, eq } from 'drizzle-orm';
import type { Db, Tx } from '@/db/client';
import { productImages, products } from '@/db/schema';
import { withTenant } from '@/db/tenant';
import { writeAudit } from './audit';
import { assertPermission, type Ctx } from './context';
import type { ImageStore } from './image-store';
import { type ProcessError, processUpload } from './images';
import { type Fail, fail, isUuid } from './products';

export const MAX_IMAGES_PER_PRODUCT = 5;

async function imageCount(tx: Tx, productId: string): Promise<number> {
  const [{ n }] = await tx.select({ n: count() }).from(productImages).where(eq(productImages.productId, productId));
  return n;
}

/** Locks the product row so two uploads or reorders of one product run one after another. */
async function lockProduct(tx: Tx, productId: string): Promise<boolean> {
  const [p] = await tx.select({ id: products.id }).from(products).where(eq(products.id, productId)).for('update');
  return Boolean(p);
}

/** Writes sort_order 0..n-1 in the given order; 0 is the main photo. */
async function renumber(tx: Tx, ids: string[]): Promise<void> {
  for (const [i, id] of ids.entries()) await tx.update(productImages).set({ sortOrder: i }).where(eq(productImages.id, id));
}

const orderedIds = async (tx: Tx, productId: string) => (await tx.select({ id: productImages.id }).from(productImages)
  .where(eq(productImages.productId, productId)).orderBy(asc(productImages.sortOrder), asc(productImages.createdAt))).map((r) => r.id);

/** Spec 6.4: the server re-compresses every upload; the file is stored before its row, and removed if the row is refused. */
export async function uploadProductImage(
  db: Db, store: ImageStore, ctx: Ctx, productId: string, file: Uint8Array,
): Promise<{ ok: true; imageId: string } | Fail<'not_found' | 'image_limit_reached' | ProcessError>> {
  assertPermission(ctx, 'manage_products');
  if (!isUuid(productId)) return fail('not_found');
  const before = await withTenant(db, ctx.tenantId, async (tx) =>
    ((await lockProduct(tx, productId)) ? imageCount(tx, productId) : null));
  if (before === null) return fail('not_found');
  if (before >= MAX_IMAGES_PER_PRODUCT) return fail('image_limit_reached');

  const processed = await processUpload(file);
  if (!processed.ok) return fail(processed.error);
  const { image } = processed;
  const key = `${ctx.tenantId}/${productId}/${randomUUID()}.webp`;
  await store.put(key, image.webp);

  let imageId: string | null;
  try {
    imageId = await withTenant(db, ctx.tenantId, async (tx) => {
      if (!(await lockProduct(tx, productId))) return null;
      const n = await imageCount(tx, productId);
      if (n >= MAX_IMAGES_PER_PRODUCT) return null;
      const [row] = await tx.insert(productImages).values({
        tenantId: ctx.tenantId, productId, storageKey: key, bytes: image.bytes, width: image.width, height: image.height, sortOrder: n,
      }).returning({ id: productImages.id });
      await writeAudit(tx, {
        tenantId: ctx.tenantId, actorType: 'user', actorId: ctx.userId, action: 'product_image_added', recordType: 'product', recordId: productId,
        changes: { imageId: row.id, bytes: image.bytes },
      });
      return row.id;
    });
  } catch (e) {
    await store.remove(key);
    throw e;
  }
  if (!imageId) {
    await store.remove(key);
    return fail('image_limit_reached');
  }
  return { ok: true, imageId };
}

export async function removeProductImage(db: Db, store: ImageStore, ctx: Ctx, imageId: string): Promise<{ ok: true } | Fail<'not_found'>> {
  assertPermission(ctx, 'manage_products');
  if (!isUuid(imageId)) return fail('not_found');
  const key = await withTenant(db, ctx.tenantId, async (tx) => {
    const [img] = await tx.select({ productId: productImages.productId, key: productImages.storageKey }).from(productImages)
      .where(eq(productImages.id, imageId));
    if (!img) return null;
    await lockProduct(tx, img.productId);
    await tx.delete(productImages).where(eq(productImages.id, imageId));
    await renumber(tx, await orderedIds(tx, img.productId));
    await writeAudit(tx, {
      tenantId: ctx.tenantId, actorType: 'user', actorId: ctx.userId, action: 'product_image_removed', recordType: 'product', recordId: img.productId,
      changes: { imageId },
    });
    return img.key;
  });
  if (!key) return fail('not_found');
  try {
    await store.remove(key);
  } catch (e) {
    // the photo is already gone from the product; a failed delete only leaves an orphan file in storage
    console.error('product photo file not removed', key, e);
  }
  return { ok: true };
}

export async function makeMainImage(db: Db, ctx: Ctx, imageId: string): Promise<{ ok: true } | Fail<'not_found'>> {
  assertPermission(ctx, 'manage_products');
  if (!isUuid(imageId)) return fail('not_found');
  return withTenant(db, ctx.tenantId, async (tx) => {
    const [img] = await tx.select({ productId: productImages.productId }).from(productImages).where(eq(productImages.id, imageId));
    if (!img) return fail('not_found');
    await lockProduct(tx, img.productId);
    await renumber(tx, [imageId, ...(await orderedIds(tx, img.productId)).filter((id) => id !== imageId)]);
    await writeAudit(tx, {
      tenantId: ctx.tenantId, actorType: 'user', actorId: ctx.userId, action: 'product_image_main', recordType: 'product', recordId: img.productId,
      changes: { imageId },
    });
    return { ok: true } as const;
  });
}

/** The stored WebP for a photo of this shop, or null. Any signed-in member: the till shows photos too. */
export async function readProductImage(db: Db, store: ImageStore, ctx: Ctx, imageId: string): Promise<Uint8Array | null> {
  if (!isUuid(imageId)) return null;
  const [img] = await withTenant(db, ctx.tenantId, (tx) => tx.select({ key: productImages.storageKey }).from(productImages)
    .where(eq(productImages.id, imageId)));
  return img ? store.get(img.key) : null;
}

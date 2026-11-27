import 'server-only';
import { and, asc, desc, eq, gte, ilike, inArray, sql } from 'drizzle-orm';
import type { Db, Tx } from '@/db/client';
import { categories, productImages, products, type StorefrontSettings, storefrontStats, stockBalances, subscriptions, tenants, users, variants } from '@/db/schema';
import { asPlatform, withTenant } from '@/db/tenant';
import { normaliseGhanaPhone } from '@/lib/contact';
import { addDays, todayIn } from '@/lib/dates';
import { subscriptionState } from '@/lib/subscription';
import { writeAudit } from './audit';
import { assertPermission, type Ctx } from './context';
import { sendEmail } from './email';
import type { ImageStore } from './image-store';
import { requirePlatformAdmin } from './platform-admin';
import { type Fail, fail, isUuid } from './products';

const COLOUR = /^#[0-9a-fA-F]{6}$/;
const URL_OK = /^https:\/\/[^\s]{3,200}$/;
const DAY = /^\d{4}-\d{2}-\d{2}$/;

export type StorefrontAdmin = { published: boolean; takenDown: boolean; settings: StorefrontSettings; shownProducts: number };

export async function getStorefront(db: Db, ctx: Ctx): Promise<StorefrontAdmin> {
  assertPermission(ctx, 'manage_storefront');
  return withTenant(db, ctx.tenantId, async (tx) => {
    const [t] = await tx.select({ published: tenants.storefrontPublished, takenDown: tenants.storefrontTakenDown, settings: tenants.storefront }).from(tenants).where(eq(tenants.id, ctx.tenantId));
    const [{ n }] = await tx.select({ n: sql<number>`count(*)::int` }).from(products).where(and(eq(products.showOnStorefront, true), eq(products.status, 'active')));
    return { ...t, shownProducts: n };
  });
}

/** Spec 6.18: validates the shop section; a WhatsApp number is stored in 233 format. */
export function cleanSettings(input: Record<string, unknown>): StorefrontSettings | null {
  const text = (k: string, max: number) => (typeof input[k] === 'string' ? (input[k] as string).trim().slice(0, max) : '');
  const about = typeof input.about === 'string' ? input.about.trim() : '';
  if (about.length > 500) return null;
  const wa = text('whatsapp', 20);
  const whatsapp = wa ? normaliseGhanaPhone(wa) : null;
  if (wa && !whatsapp) return null;
  const themeColor = text('themeColor', 7) || '#1e40af';
  if (!COLOUR.test(themeColor)) return null;
  const links = ['facebook', 'instagram'].map((k) => text(k, 200));
  if (links.some((l) => l && !URL_OK.test(l))) return null;
  const announcementUntil = text('announcementUntil', 10);
  if (announcementUntil && !DAY.test(announcementUntil)) return null;
  return {
    about, whatsapp: whatsapp ?? '', hours: text('hours', 200), themeColor, facebook: links[0], instagram: links[1],
    showPrices: input.showPrices === true, showStock: input.showStock === true, announcement: text('announcement', 140), announcementUntil,
  };
}

export async function saveStorefront(db: Db, ctx: Ctx, input: Record<string, unknown>): Promise<{ ok: true } | Fail<'invalid_input'>> {
  assertPermission(ctx, 'manage_storefront');
  const settings = cleanSettings(input);
  if (!settings) return fail('invalid_input');
  return withTenant(db, ctx.tenantId, async (tx) => {
    await tx.update(tenants).set({ storefront: settings }).where(eq(tenants.id, ctx.tenantId));
    await writeAudit(tx, { tenantId: ctx.tenantId, actorType: 'user', actorId: ctx.userId, action: 'storefront_saved', changes: settings });
    return { ok: true as const };
  });
}

/** Spec 6.18: publishing needs at least one product marked "Show on storefront". */
export async function setPublished(db: Db, ctx: Ctx, published: boolean): Promise<{ ok: true } | Fail<'no_products'>> {
  assertPermission(ctx, 'manage_storefront');
  return withTenant(db, ctx.tenantId, async (tx) => {
    if (published) {
      const [{ n }] = await tx.select({ n: sql<number>`count(*)::int` }).from(products).where(and(eq(products.showOnStorefront, true), eq(products.status, 'active')));
      if (n === 0) return fail('no_products');
    }
    await tx.update(tenants).set({ storefrontPublished: published }).where(eq(tenants.id, ctx.tenantId));
    await writeAudit(tx, { tenantId: ctx.tenantId, actorType: 'user', actorId: ctx.userId, action: published ? 'storefront_published' : 'storefront_unpublished' });
    return { ok: true as const };
  });
}

/** Spec 4.12: the platform takes a storefront down (or restores it); logged and the owner is emailed. */
export async function setTakenDown(db: Db, adminToken: string | undefined, tenantId: string, down: boolean, reason: string, now: Date): Promise<{ ok: true } | Fail<'reason_required' | 'not_found'>> {
  const admin = await requirePlatformAdmin(db, adminToken, now);
  const why = typeof reason === 'string' ? reason.trim() : '';
  if (down && why.length < 5) return fail('reason_required');
  if (!isUuid(tenantId)) return fail('not_found');
  const shop = await asPlatform(db, async (tx) => {
    const [t] = await tx.update(tenants).set({ storefrontTakenDown: down }).where(eq(tenants.id, tenantId)).returning({ name: tenants.name });
    if (!t) return null;
    await writeAudit(tx, { tenantId, actorType: 'platform', actorId: admin.adminId, action: down ? 'storefront_taken_down' : 'storefront_restored', reason: why || undefined });
    const owners = await tx.select({ email: users.email }).from(users).where(and(eq(users.tenantId, tenantId), eq(users.rolePreset, 'owner')));
    return { name: t.name, emails: owners.map((o) => o.email).filter((e): e is string => !!e) };
  });
  if (!shop) return fail('not_found');
  for (const to of shop.emails) {
    await sendEmail({ to, subject: down ? `Your storefront ${shop.name} was taken down` : `Your storefront ${shop.name} is back`, text: down ? `The platform took your storefront down. Reason: ${why}\nReply to this email to ask for a review.` : 'Your storefront is visible again.' });
  }
  return { ok: true };
}

export type LiveShop = { id: string; slug: string; name: string; phone: string | null; address: string | null; taxMode: string; settings: StorefrontSettings; today: string };

/** Spec 6.18: a missing, suspended, unpublished, taken-down, or read-only shop has no storefront (the grace period still shows it). */
export async function liveShop(tx: Tx, slug: string, now: Date): Promise<LiveShop | null> {
  const [row] = await tx.select({ t: tenants, s: subscriptions }).from(tenants).innerJoin(subscriptions, eq(subscriptions.tenantId, tenants.id)).where(eq(tenants.slug, slug));
  if (!row) return null;
  const { t, s } = row;
  const today = todayIn(t.timezone, now);
  if (t.status !== 'active' || !t.storefrontPublished || t.storefrontTakenDown || subscriptionState(s, today) === 'read_only') return null;
  return { id: t.id, slug: t.slug, name: t.name, phone: t.phone, address: t.address, taxMode: t.taxMode, settings: t.storefront, today };
}

export type PublicProduct = {
  id: string; name: string; description: string | null; category: string | null; featured: boolean; prescriptionOnly: boolean;
  pricePesewas: number | null; inStock: boolean | null; imageIds: string[];
};
export type PublicShop = Omit<LiveShop, 'id' | 'taxMode' | 'today'> & { announcement: string | null; categories: string[]; products: PublicProduct[]; page: number; hasMore: boolean };
export const STOREFRONT_PAGE = 40; // keeps the page light on mobile data

/** The public catalogue: active products marked for the storefront only; never cost, exact stock, suppliers, staff, or sales. */
async function catalogue(tx: Tx, shop: LiveShop, where: { productId?: string; q?: string; category?: string; page?: number }): Promise<PublicProduct[]> {
  const rows = await tx.select({ p: products, category: categories.name }).from(products).leftJoin(categories, eq(categories.id, products.categoryId))
    .where(and(eq(products.showOnStorefront, true), eq(products.status, 'active'), where.productId ? eq(products.id, where.productId) : undefined,
      where.q ? ilike(products.name, `%${where.q.replace(/[%_\\]/g, '')}%`) : undefined, where.category ? eq(categories.name, where.category) : undefined))
    .orderBy(desc(products.featured), asc(products.name), asc(products.id)).limit(STOREFRONT_PAGE + 1).offset((where.page ?? 0) * STOREFRONT_PAGE); // one extra row says whether a next page exists
  const ids = rows.map((r) => r.p.id);
  if (!ids.length) return [];
  const prices = await tx.select({ productId: variants.productId, min: sql<number>`min(${variants.basePricePesewas})::int` }).from(variants)
    .where(and(inArray(variants.productId, ids), eq(variants.status, 'active'), eq(variants.sellable, true))).groupBy(variants.productId);
  const stock = await tx.select({ productId: variants.productId, onHand: sql<string>`sum(${stockBalances.onHand} - ${stockBalances.reserved})` }).from(stockBalances)
    .innerJoin(variants, eq(variants.id, stockBalances.variantId)).where(inArray(variants.productId, ids)).groupBy(variants.productId);
  const images = await tx.select({ productId: productImages.productId, id: productImages.id }).from(productImages).where(inArray(productImages.productId, ids)).orderBy(asc(productImages.sortOrder));
  return rows.map(({ p, category }) => {
    const s = stock.find((x) => x.productId === p.id);
    return {
      id: p.id, name: p.name, description: p.description, category, featured: p.featured, prescriptionOnly: p.prescriptionOnly,
      // shortcut: shows the base price, which is the shelf price for tax-inclusive shops; tax-exclusive shops show it before tax.
      pricePesewas: shop.settings.showPrices ? (prices.find((x) => x.productId === p.id)?.min ?? null) : null,
      inStock: shop.settings.showStock ? (!p.trackStock || !s ? true : Number(s.onHand) > 0) : null, // not counted, or no stock records: available
      imageIds: images.filter((i) => i.productId === p.id).map((i) => i.id),
    };
  });
}

const announcementOf = (shop: LiveShop) => (shop.settings.announcement && (!shop.settings.announcementUntil || shop.settings.announcementUntil >= shop.today) ? shop.settings.announcement : null);

async function bump(tx: Tx, tenantId: string, day: string, key: string) {
  await tx.insert(storefrontStats).values({ tenantId, day, key, count: 1 })
    .onConflictDoUpdate({ target: [storefrontStats.tenantId, storefrontStats.day, storefrontStats.key], set: { count: sql`${storefrontStats.count} + 1` } });
}

/** Spec 6.18: the storefront page; counts a page view (date and count only). */
export async function publicStorefront(db: Db, slug: string, now: Date, filter: { q?: string; category?: string; count?: boolean; page?: number } = {}): Promise<PublicShop | null> {
  const page = Number.isInteger(filter.page) && filter.page! > 0 ? Math.min(filter.page!, 500) : 0;
  const shop = await asPlatform(db, (tx) => liveShop(tx, slug, now));
  if (!shop) return null;
  return withTenant(db, shop.id, async (tx) => {
    const list = await catalogue(tx, shop, { ...filter, page });
    const cats = await tx.selectDistinct({ name: categories.name }).from(categories).innerJoin(products, eq(products.categoryId, categories.id))
      .where(and(eq(products.showOnStorefront, true), eq(products.status, 'active'))).orderBy(asc(categories.name));
    if (filter.count !== false) await bump(tx, shop.id, shop.today, 'view');
    return { slug: shop.slug, name: shop.name, phone: shop.phone, address: shop.address, settings: shop.settings, announcement: announcementOf(shop), categories: cats.map((c) => c.name), products: list.slice(0, STOREFRONT_PAGE), page, hasMore: list.length > STOREFRONT_PAGE };
  });
}

/** Spec 6.18: one product page; counts a product view. */
export async function publicProduct(db: Db, slug: string, productId: string, now: Date, count = true): Promise<{ shop: Omit<PublicShop, 'products' | 'categories' | 'page' | 'hasMore'>; product: PublicProduct } | null> {
  if (!isUuid(productId)) return null;
  const shop = await asPlatform(db, (tx) => liveShop(tx, slug, now));
  if (!shop) return null;
  return withTenant(db, shop.id, async (tx) => {
    const [product] = await catalogue(tx, shop, { productId });
    if (!product) return null;
    if (count) await bump(tx, shop.id, shop.today, `product:${productId}`);
    return { shop: { slug: shop.slug, name: shop.name, phone: shop.phone, address: shop.address, settings: shop.settings, announcement: announcementOf(shop) }, product };
  });
}

/** Spec 6.19: counts the click and returns where to send the visitor; prescription-only medicine never gets an order link. */
export async function orderLink(db: Db, slug: string, kind: 'whatsapp' | 'call', productId: string | null, productUrl: string, now: Date): Promise<string | null> {
  const shop = await asPlatform(db, (tx) => liveShop(tx, slug, now));
  if (!shop) return null;
  return withTenant(db, shop.id, async (tx) => {
    const product = productId && isUuid(productId) ? (await catalogue(tx, shop, { productId }))[0] : undefined;
    if (productId && (!product || product.prescriptionOnly)) return null;
    if (kind === 'call') {
      if (!shop.phone) return null;
      await bump(tx, shop.id, shop.today, product ? `call:${product.id}` : 'call');
      return `tel:+${shop.phone.replace(/\D/g, '')}`;
    }
    if (!shop.settings.whatsapp) return null;
    const price = product?.pricePesewas != null ? ` (GHS ${(product.pricePesewas / 100).toFixed(2)})` : '';
    const text = product ? `Hello ${shop.name}, I would like to order ${product.name}${price}. ${productUrl}` : `Hello ${shop.name}, I found you on your page. ${productUrl}`;
    await bump(tx, shop.id, shop.today, product ? `whatsapp:${product.id}` : 'whatsapp');
    return `https://wa.me/${shop.settings.whatsapp}?text=${encodeURIComponent(text)}`;
  });
}

/** A storefront photo: only of a product shown on a live storefront. */
export async function publicImage(db: Db, store: ImageStore, slug: string, imageId: string, now: Date): Promise<Uint8Array | null> {
  if (!isUuid(imageId)) return null;
  const shop = await asPlatform(db, (tx) => liveShop(tx, slug, now));
  if (!shop) return null;
  const [img] = await withTenant(db, shop.id, (tx) => tx.select({ key: productImages.storageKey }).from(productImages).innerJoin(products, eq(products.id, productImages.productId))
    .where(and(eq(productImages.id, imageId), eq(products.showOnStorefront, true), eq(products.status, 'active'))));
  return img ? store.get(img.key) : null;
}

/** Spec 4.12: counts only, last 30 days. */
export async function storefrontStatsSummary(db: Db, ctx: Ctx, now: Date) {
  assertPermission(ctx, 'manage_storefront');
  return withTenant(db, ctx.tenantId, async (tx) => {
    const [t] = await tx.select({ tz: tenants.timezone }).from(tenants).where(eq(tenants.id, ctx.tenantId));
    const from = addDays(todayIn(t.tz, now), -29);
    const rows = await tx.select({ key: storefrontStats.key, n: sql<number>`sum(${storefrontStats.count})::int` }).from(storefrontStats).where(gte(storefrontStats.day, from)).groupBy(storefrontStats.key);
    const sum = (prefix: string) => rows.filter((r) => r.key === prefix || r.key.startsWith(`${prefix}:`)).reduce((s, r) => s + r.n, 0);
    return { pageViews: sum('view'), productViews: sum('product'), whatsappClicks: sum('whatsapp'), callClicks: sum('call') };
  });
}

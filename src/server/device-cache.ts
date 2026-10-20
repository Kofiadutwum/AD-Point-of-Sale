import 'server-only';
import { and, arrayContains, asc, desc, eq, isNotNull } from 'drizzle-orm';
import type { Db } from '@/db/client';
import {
  barcodes, branches, deviceCacheVersions, heldSales, productImages, products, registers, subscriptions, taxRules, tenants, users, variants, variantUnits,
} from '@/db/schema';
import { withTenant } from '@/db/tenant';
import { todayIn } from '@/lib/dates';
import type { DeviceCache } from '@/lib/device-contract';
import { type Permission, TILL_PERMISSIONS } from '@/lib/permissions';
import { subscriptionState } from '@/lib/subscription';
import { effectiveRateBp } from '@/lib/tax';
import { type DeviceRegister, findDeviceRegister } from './devices';
import type { ImageStore } from './image-store';
import { loadPriceRules } from './price-lists';
import { isUuid } from './products';

// Device-token services: the pos_device cookie is the credential, so a till loads before anyone signs in.
export type DeviceInput = { deviceToken: string | undefined; slug: string };

/** The till behind this cookie, only when it belongs to the shop in the URL. */
export async function deviceFor(db: Db, input: DeviceInput): Promise<DeviceRegister | null> {
  const device = await findDeviceRegister(db, input.deviceToken);
  return device && device.slug === input.slug ? device : null;
}

export async function getDeviceCache(db: Db, input: DeviceInput, now: Date): Promise<DeviceCache | null> {
  const device = await deviceFor(db, input);
  if (!device) return null;
  return withTenant(db, device.tenantId, async (tx) => {
    const [shop] = await tx.select({ t: tenants, sub: subscriptions }).from(tenants)
      .innerJoin(subscriptions, eq(subscriptions.tenantId, tenants.id)).where(eq(tenants.id, device.tenantId));
    const [till] = await tx.select({ r: registers, b: branches }).from(registers)
      .innerJoin(branches, eq(branches.id, registers.branchId)).where(eq(registers.id, device.registerId));
    const [ver] = await tx.select().from(deviceCacheVersions).where(eq(deviceCacheVersions.tenantId, device.tenantId));
    const staff = await tx.select().from(users).where(and(
      eq(users.status, 'active'), isNotNull(users.pinHash),
      arrayContains(users.permissions, ['make_sale']), arrayContains(users.branchIds, [device.branchId]),
    )).orderBy(asc(users.name));
    const photos = await tx.select({ id: productImages.id, productId: productImages.productId }).from(productImages).where(eq(productImages.sortOrder, 0));
    const resolved = await tx.select({ saleId: heldSales.saleId }).from(heldSales)
      .where(and(eq(heldSales.registerId, device.registerId), isNotNull(heldSales.resolvedAt))).orderBy(desc(heldSales.resolvedAt)).limit(200);
    const offline = shop.t.offlineEnabled;
    return {
      version: ver?.version ?? 0,
      generatedAt: now.toISOString(),
      shop: {
        name: shop.t.name, timezone: shop.t.timezone, taxMode: shop.t.taxMode, taxEnabled: shop.t.taxEnabled,
        scaleLayout: shop.t.scaleBarcode ?? null, offlineEnabled: offline,
        canSell: subscriptionState(shop.sub, todayIn(shop.t.timezone, now)) !== 'read_only',
      },
      register: {
        id: till.r.id, name: till.r.name, registerCode: till.r.registerCode, branchId: till.b.id, branchCode: till.b.branchCode, branchName: till.b.name,
      },
      staff: staff.map((s) => ({
        id: s.id, name: s.name, permissions: (s.permissions as Permission[]).filter((p) => TILL_PERMISSIONS.includes(p)),
        // no offline selling means no reason to hand PIN hashes to a device
        pinHash: offline ? s.pinHash : null, pinLockedUntil: s.pinLockedUntil?.toISOString() ?? null,
      })),
      taxRules: (await tx.select().from(taxRules)).map((r) => ({ id: r.id, isDefault: r.isDefault, rateBp: effectiveRateBp(r) })),
      priceRules: await loadPriceRules(tx),
      products: (await tx.select().from(products)).map((p) => ({
        id: p.id, name: p.name, genericName: p.genericName, taxRuleId: p.taxRuleId, tracking: p.tracking, status: p.status,
        imageId: photos.find((i) => i.productId === p.id)?.id ?? null,
      })),
      variants: await tx.select({
        id: variants.id, productId: variants.productId, name: variants.name, sku: variants.sku, allowsFractions: variants.allowsFractions,
        basePricePesewas: variants.basePricePesewas, scaleItemCode: variants.scaleItemCode, sellable: variants.sellable, status: variants.status,
      }).from(variants),
      units: await tx.select({
        id: variantUnits.id, variantId: variantUnits.variantId, name: variantUnits.name, factor: variantUnits.factor,
        pricePesewas: variantUnits.pricePesewas, sellable: variantUnits.sellable, isBase: variantUnits.isBase,
      }).from(variantUnits),
      barcodes: await tx.select({ code: barcodes.code, variantId: barcodes.variantId, unitId: barcodes.unitId }).from(barcodes),
      resolvedHeldSaleIds: resolved.map((r) => r.saleId),
    };
  });
}

export async function getDeviceCacheVersion(db: Db, input: DeviceInput): Promise<number | null> {
  const device = await deviceFor(db, input);
  if (!device) return null;
  const [ver] = await withTenant(db, device.tenantId, (tx) => tx.select().from(deviceCacheVersions)
    .where(eq(deviceCacheVersions.tenantId, device.tenantId)));
  return ver?.version ?? 0;
}

export async function readDeviceImage(db: Db, store: ImageStore, input: DeviceInput & { imageId: string }): Promise<Uint8Array | null> {
  if (!isUuid(input.imageId)) return null;
  const device = await deviceFor(db, input);
  if (!device) return null;
  const [img] = await withTenant(db, device.tenantId, (tx) => tx.select({ key: productImages.storageKey }).from(productImages)
    .where(eq(productImages.id, input.imageId)));
  return img ? store.get(img.key) : null;
}

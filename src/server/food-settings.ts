import 'server-only';
import { and, asc, eq } from 'drizzle-orm';
import { z } from 'zod';
import type { Db, Tx } from '@/db/client';
import { branches, foodSettings, products, tenants, variants } from '@/db/schema';
import { withTenant } from '@/db/tenant';
import { SERVICE_MODES, type ServiceMode } from '@/lib/food';
import { writeAudit } from './audit';
import { assertPermission, type Ctx } from './context';
import { type Fail, itemLabel } from './products';

export type FoodSettings = { packVariantId: string | null; packFeeMode: 'per_item' | 'per_order' };

const DEFAULTS: FoodSettings = { packVariantId: null, packFeeMode: 'per_order' };
const isUuid = (value: string) => z.uuid().safeParse(value).success;

/** Food features are on when the shop has the kitchen module (a food default). */
export async function foodEnabled(tx: Tx): Promise<boolean> {
  const [t] = await tx.select({ modules: tenants.modules }).from(tenants);
  return t?.modules.includes('kitchen') ?? false;
}

export async function getFoodSettings(db: Db, ctx: Ctx): Promise<FoodSettings> {
  return withTenant(db, ctx.tenantId, async (tx) => {
    const [row] = await tx.select({ packVariantId: foodSettings.packVariantId, packFeeMode: foodSettings.packFeeMode }).from(foodSettings);
    return row ?? DEFAULTS;
  });
}

/** Spec 6.56: the pack is a catalogue item, so its price, tax, and container stock come from the catalogue. */
export async function saveFoodSettings(
  db: Db, ctx: Ctx, input: FoodSettings,
): Promise<{ ok: true } | Fail<'invalid_input' | 'unknown_item' | 'module_off'>> {
  assertPermission(ctx, 'manage_shop_settings');
  const { packVariantId, packFeeMode } = input;
  if (!['per_item', 'per_order'].includes(packFeeMode) || (packVariantId !== null && typeof packVariantId !== 'string')) {
    return { ok: false, error: 'invalid_input' };
  }
  return withTenant(db, ctx.tenantId, async (tx) => {
    if (!(await foodEnabled(tx))) return { ok: false, error: 'module_off' } as const;
    if (packVariantId) {
      const [pack] = isUuid(packVariantId) ? await tx.select({ id: variants.id }).from(variants).where(and(
        eq(variants.id, packVariantId), eq(variants.status, 'active'), eq(variants.sellable, true), eq(variants.kind, 'standard'),
      )) : [];
      if (!pack) return { ok: false, error: 'unknown_item' } as const;
    }
    const values = { packVariantId, packFeeMode, updatedAt: new Date() };
    await tx.insert(foodSettings).values({ tenantId: ctx.tenantId, ...values }).onConflictDoUpdate({ target: foodSettings.tenantId, set: values });
    await writeAudit(tx, { tenantId: ctx.tenantId, actorType: 'user', actorId: ctx.userId, action: 'food_settings_saved', changes: { packVariantId, packFeeMode } });
    return { ok: true } as const;
  });
}

/** Spec 4.24: a branch can use several service modes; an empty list sells without food controls. */
export async function setServiceModes(
  db: Db, ctx: Ctx, branchId: string, modes: ServiceMode[],
): Promise<{ ok: true } | Fail<'invalid_input' | 'unknown_branch' | 'module_off'>> {
  assertPermission(ctx, 'manage_shop_settings');
  if (!Array.isArray(modes) || !modes.every((m) => SERVICE_MODES.includes(m))) return { ok: false, error: 'invalid_input' };
  const unique = [...new Set(modes)];
  return withTenant(db, ctx.tenantId, async (tx) => {
    if (!(await foodEnabled(tx))) return { ok: false, error: 'module_off' } as const;
    const updated = isUuid(branchId)
      ? await tx.update(branches).set({ serviceModes: unique }).where(eq(branches.id, branchId)).returning({ id: branches.id })
      : [];
    if (updated.length === 0) return { ok: false, error: 'unknown_branch' } as const;
    await writeAudit(tx, {
      tenantId: ctx.tenantId, actorType: 'user', actorId: ctx.userId, action: 'service_modes_saved', recordType: 'branch', recordId: branchId, changes: { modes: unique },
    });
    return { ok: true } as const;
  });
}

/** Items that can be the takeaway pack: active, sellable, standard variants. */
export async function listPackChoices(db: Db, ctx: Ctx): Promise<Array<{ variantId: string; label: string }>> {
  assertPermission(ctx, 'manage_shop_settings');
  return withTenant(db, ctx.tenantId, async (tx) => (await tx.select({ variantId: variants.id, productName: products.name, variantName: variants.name })
    .from(variants).innerJoin(products, eq(products.id, variants.productId))
    .where(and(eq(variants.status, 'active'), eq(products.status, 'active'), eq(variants.sellable, true), eq(variants.kind, 'standard')))
    .orderBy(asc(products.name), asc(variants.name))).map((v) => ({ variantId: v.variantId, label: itemLabel(v.productName, v.variantName) })));
}

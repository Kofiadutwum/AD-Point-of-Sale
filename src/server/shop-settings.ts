import 'server-only';
import { and, asc, eq, isNotNull, like, sql } from 'drizzle-orm';
import type { Db } from '@/db/client';
import { barcodes, products, tenants, variants, variantUnits } from '@/db/schema';
import { withTenant } from '@/db/tenant';
import { type ScaleLayout, validScaleLayout } from '@/lib/barcode';
import { type Module, MODULES } from '@/lib/permissions';
import { writeAudit } from './audit';
import { assertPermission, type Ctx } from './context';
import { scaleCodeProblem } from './products';

export type SellingSettings = { taxEnabled: boolean; scaleLayout: ScaleLayout | null; modules: Module[] };

const isModule = (m: string): m is Module => (MODULES as readonly string[]).includes(m);

/** Readable by any signed-in member: the till and catalogue pages need them. */
export async function getSellingSettings(db: Db, ctx: Ctx): Promise<SellingSettings> {
  const [t] = await withTenant(db, ctx.tenantId, (tx) => tx
    .select({ taxEnabled: tenants.taxEnabled, scaleBarcode: tenants.scaleBarcode, modules: tenants.modules })
    .from(tenants).where(eq(tenants.id, ctx.tenantId)));
  return { taxEnabled: t.taxEnabled, scaleLayout: t.scaleBarcode ?? null, modules: t.modules.filter(isModule) };
}

export async function getOfflineEnabled(db: Db, ctx: Ctx): Promise<boolean> {
  const [t] = await withTenant(db, ctx.tenantId, (tx) => tx.select({ on: tenants.offlineEnabled }).from(tenants).where(eq(tenants.id, ctx.tenantId)));
  return t.on;
}

/** Spec 4.9: a shop can switch offline selling off; tills then stop receiving PIN hashes. */
export async function setOfflineEnabled(db: Db, ctx: Ctx, enabled: boolean): Promise<{ ok: true }> {
  assertPermission(ctx, 'manage_shop_settings');
  return withTenant(db, ctx.tenantId, async (tx) => {
    await tx.update(tenants).set({ offlineEnabled: enabled === true }).where(eq(tenants.id, ctx.tenantId));
    await writeAudit(tx, { tenantId: ctx.tenantId, actorType: 'user', actorId: ctx.userId, action: 'offline_setting_saved', changes: { offlineEnabled: enabled === true } });
    return { ok: true } as const;
  });
}

export async function saveSellingSettings(
  db: Db, ctx: Ctx, input: SellingSettings,
): Promise<{ ok: true } | { ok: false; error: 'invalid_input' } | { ok: false; error: 'barcodes_clash' | 'scale_codes_clash'; codes: string[] }> {
  assertPermission(ctx, 'manage_shop_settings');
  const modules = [...new Set(input.modules)];
  const l = input.scaleLayout;
  if (typeof input.taxEnabled !== 'boolean' || !modules.every(isModule) || (l && !validScaleLayout(l))) return { ok: false, error: 'invalid_input' };
  const layout: ScaleLayout | null = l && {
    prefix: l.prefix, itemStart: l.itemStart, itemLength: l.itemLength, valueStart: l.valueStart, valueLength: l.valueLength, carries: l.carries,
  };

  return withTenant(db, ctx.tenantId, async (tx) => {
    if (layout) {
      // a saved barcode the layout would capture could never be found again by scanning
      const clash = await tx.select({ code: barcodes.code }).from(barcodes).where(and(
        eq(barcodes.tenantId, ctx.tenantId), sql`${barcodes.code} ~ '^[0-9]{13}$'`, like(barcodes.code, `${layout.prefix}%`),
      )).orderBy(asc(barcodes.code)).limit(5);
      if (clash.length) return { ok: false, error: 'barcodes_clash', codes: clash.map((c) => c.code) } as const;
      // saved scale items must still read correctly: a weight layout needs kg items, and every code must fit the item digits
      const weighed = await tx.select({
        code: variants.scaleItemCode, kind: variants.kind, allowsFractions: variants.allowsFractions, basePricePesewas: variants.basePricePesewas,
        tracking: products.tracking, baseUnit: variantUnits.name,
      }).from(variants)
        .innerJoin(products, eq(products.id, variants.productId))
        .innerJoin(variantUnits, and(eq(variantUnits.variantId, variants.id), eq(variantUnits.isBase, true)))
        .where(isNotNull(variants.scaleItemCode)).orderBy(asc(variants.scaleItemCode));
      const misread = weighed.filter((v) => scaleCodeProblem(v.code!, layout, v) !== null).slice(0, 5);
      if (misread.length) return { ok: false, error: 'scale_codes_clash', codes: misread.map((v) => String(v.code)) } as const;
    }
    await tx.update(tenants).set({ taxEnabled: input.taxEnabled, scaleBarcode: layout, modules }).where(eq(tenants.id, ctx.tenantId));
    await writeAudit(tx, {
      tenantId: ctx.tenantId, actorType: 'user', actorId: ctx.userId, action: 'selling_settings_saved',
      changes: { taxEnabled: input.taxEnabled, scaleLayout: layout, modules },
    });
    return { ok: true } as const;
  });
}

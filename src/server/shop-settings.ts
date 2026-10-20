import 'server-only';
import { and, asc, eq, like, sql } from 'drizzle-orm';
import type { Db } from '@/db/client';
import { barcodes, tenants } from '@/db/schema';
import { withTenant } from '@/db/tenant';
import { type ScaleLayout, validScaleLayout } from '@/lib/barcode';
import { type Module, MODULES } from '@/lib/permissions';
import { writeAudit } from './audit';
import { assertPermission, type Ctx } from './context';

export type SellingSettings = { taxEnabled: boolean; scaleLayout: ScaleLayout | null; modules: Module[] };

const isModule = (m: string): m is Module => (MODULES as readonly string[]).includes(m);

/** Readable by any signed-in member: the till and catalogue pages need them. */
export async function getSellingSettings(db: Db, ctx: Ctx): Promise<SellingSettings> {
  const [t] = await withTenant(db, ctx.tenantId, (tx) => tx
    .select({ taxEnabled: tenants.taxEnabled, scaleBarcode: tenants.scaleBarcode, modules: tenants.modules })
    .from(tenants).where(eq(tenants.id, ctx.tenantId)));
  return { taxEnabled: t.taxEnabled, scaleLayout: t.scaleBarcode ?? null, modules: t.modules.filter(isModule) };
}

export async function saveSellingSettings(
  db: Db, ctx: Ctx, input: SellingSettings,
): Promise<{ ok: true } | { ok: false; error: 'invalid_input' } | { ok: false; error: 'barcodes_clash'; codes: string[] }> {
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
    }
    await tx.update(tenants).set({ taxEnabled: input.taxEnabled, scaleBarcode: layout, modules }).where(eq(tenants.id, ctx.tenantId));
    await writeAudit(tx, {
      tenantId: ctx.tenantId, actorType: 'user', actorId: ctx.userId, action: 'selling_settings_saved',
      changes: { taxEnabled: input.taxEnabled, scaleLayout: layout, modules },
    });
    return { ok: true } as const;
  });
}

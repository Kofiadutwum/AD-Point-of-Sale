import { CASH_ROUNDING_STEPS } from '@/lib/cash-rounding';
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

export type SalesSettings = { allowNegativeStock: boolean; taxNumber: string | null; receiptFooter: string | null; cashRoundingStep: number };

/** Readable by any signed-in member: receipts and the till need them. */
export async function getSalesSettings(db: Db, ctx: Ctx): Promise<SalesSettings> {
  const [t] = await withTenant(db, ctx.tenantId, (tx) => tx
    .select({ allowNegativeStock: tenants.allowNegativeStock, taxNumber: tenants.taxNumber, receiptFooter: tenants.receiptFooter, cashRoundingStep: tenants.cashRoundingStep })
    .from(tenants).where(eq(tenants.id, ctx.tenantId)));
  return t;
}

export async function saveSalesSettings(db: Db, ctx: Ctx, input: SalesSettings): Promise<{ ok: true } | { ok: false; error: 'invalid_input' }> {
  assertPermission(ctx, 'manage_shop_settings');
  const clean = (v: string | null, max: number) => (typeof v === 'string' && v.trim() ? v.trim() : null) ?? (v === null || typeof v === 'string' ? null : undefined);
  const taxNumber = clean(input.taxNumber, 30);
  const receiptFooter = clean(input.receiptFooter, 300);
  if (typeof input.allowNegativeStock !== 'boolean' || taxNumber === undefined || receiptFooter === undefined
    || (taxNumber?.length ?? 0) > 30 || (receiptFooter?.length ?? 0) > 300
    || !(CASH_ROUNDING_STEPS as readonly number[]).includes(input.cashRoundingStep)) return { ok: false, error: 'invalid_input' };
  const next = { allowNegativeStock: input.allowNegativeStock, taxNumber, receiptFooter, cashRoundingStep: input.cashRoundingStep };
  return withTenant(db, ctx.tenantId, async (tx) => {
    await tx.update(tenants).set(next).where(eq(tenants.id, ctx.tenantId));
    await writeAudit(tx, { tenantId: ctx.tenantId, actorType: 'user', actorId: ctx.userId, action: 'sales_settings_saved', changes: next });
    return { ok: true } as const;
  });
}

export type ReturnSettings = { refundLimitPesewas: number; allowNoReceiptReturns: boolean; noReceiptMonthlyLimit: number };

/** Readable by anyone who takes returns: the returns screen shows the no-receipt form only when it is on. */
export async function getReturnSettings(db: Db, ctx: Ctx): Promise<ReturnSettings> {
  const [t] = await withTenant(db, ctx.tenantId, (tx) => tx.select({
    refundLimitPesewas: tenants.refundLimitPesewas, allowNoReceiptReturns: tenants.allowNoReceiptReturns, noReceiptMonthlyLimit: tenants.noReceiptMonthlyLimit,
  }).from(tenants).where(eq(tenants.id, ctx.tenantId)));
  return t;
}

/** Spec 6.12, 6.33: the refund a cashier may give without a manager (0 = always ask), and no-receipt returns. */
export async function saveReturnSettings(db: Db, ctx: Ctx, input: ReturnSettings): Promise<{ ok: true } | { ok: false; error: 'invalid_input' }> {
  assertPermission(ctx, 'manage_shop_settings');
  const { refundLimitPesewas: limit, allowNoReceiptReturns: allow, noReceiptMonthlyLimit: monthly } = input;
  if (!Number.isInteger(limit) || limit < 0 || limit > 100_000_000 || typeof allow !== 'boolean'
    || !Number.isInteger(monthly) || monthly < 0 || monthly > 31) return { ok: false, error: 'invalid_input' };
  const next = { refundLimitPesewas: limit, allowNoReceiptReturns: allow, noReceiptMonthlyLimit: monthly };
  return withTenant(db, ctx.tenantId, async (tx) => {
    await tx.update(tenants).set(next).where(eq(tenants.id, ctx.tenantId));
    await writeAudit(tx, { tenantId: ctx.tenantId, actorType: 'user', actorId: ctx.userId, action: 'return_settings_saved', changes: next });
    return { ok: true } as const;
  });
}

export type PharmacySettings = { otcOnly: boolean; expiryWarningDays: number };

/** Readable by any signed-in member: the till and reports need them. */
export async function getPharmacySettings(db: Db, ctx: Ctx): Promise<PharmacySettings> {
  const [t] = await withTenant(db, ctx.tenantId, (tx) => tx.select({ otcOnly: tenants.otcOnly, expiryWarningDays: tenants.expiryWarningDays })
    .from(tenants).where(eq(tenants.id, ctx.tenantId)));
  return t;
}

/** Spec 4.17, 4.23: a licensed chemical seller sells over-the-counter medicine only; the near-expiry window in days. */
export async function savePharmacySettings(db: Db, ctx: Ctx, input: PharmacySettings): Promise<{ ok: true } | { ok: false; error: 'invalid_input' }> {
  assertPermission(ctx, 'manage_shop_settings');
  const days = input.expiryWarningDays;
  if (typeof input.otcOnly !== 'boolean' || !Number.isInteger(days) || days < 1 || days > 365) return { ok: false, error: 'invalid_input' };
  const next = { otcOnly: input.otcOnly, expiryWarningDays: days };
  return withTenant(db, ctx.tenantId, async (tx) => {
    await tx.update(tenants).set(next).where(eq(tenants.id, ctx.tenantId));
    await writeAudit(tx, { tenantId: ctx.tenantId, actorType: 'user', actorId: ctx.userId, action: 'pharmacy_settings_saved', changes: next });
    return { ok: true } as const;
  });
}

export type CashSettings = { requireShifts: boolean; cashVarianceLimitPesewas: number; expenseApprovalLimitPesewas: number };

/** Readable by any signed-in member: the till checks whether a shift is required. */
export async function getCashSettings(db: Db, ctx: Ctx): Promise<CashSettings> {
  const [t] = await withTenant(db, ctx.tenantId, (tx) => tx.select({
    requireShifts: tenants.requireShifts, cashVarianceLimitPesewas: tenants.cashVarianceLimitPesewas, expenseApprovalLimitPesewas: tenants.expenseApprovalLimitPesewas,
  }).from(tenants).where(eq(tenants.id, ctx.tenantId)));
  return t;
}

/** Spec 4.6, 6.14, 6.43: require shifts; the till variance and the expense a person may leave or record without a manager (0 = always ask). */
export async function saveCashSettings(db: Db, ctx: Ctx, input: CashSettings): Promise<{ ok: true } | { ok: false; error: 'invalid_input' }> {
  assertPermission(ctx, 'manage_shop_settings');
  const ok = (n: number) => Number.isInteger(n) && n >= 0 && n <= 100_000_000;
  if (typeof input.requireShifts !== 'boolean' || !ok(input.cashVarianceLimitPesewas) || !ok(input.expenseApprovalLimitPesewas)) return { ok: false, error: 'invalid_input' };
  const next = { requireShifts: input.requireShifts, cashVarianceLimitPesewas: input.cashVarianceLimitPesewas, expenseApprovalLimitPesewas: input.expenseApprovalLimitPesewas };
  return withTenant(db, ctx.tenantId, async (tx) => {
    await tx.update(tenants).set(next).where(eq(tenants.id, ctx.tenantId));
    await writeAudit(tx, { tenantId: ctx.tenantId, actorType: 'user', actorId: ctx.userId, action: 'cash_settings_saved', changes: next });
    return { ok: true } as const;
  });
}

export type ReportSettings = { smsReports: boolean; reportTime: string; weeklyReportDay: number };

export async function getReportSettings(db: Db, ctx: Ctx): Promise<ReportSettings> {
  assertPermission(ctx, 'manage_shop_settings');
  const [t] = await withTenant(db, ctx.tenantId, (tx) => tx.select({ smsReports: tenants.smsReports, reportTime: tenants.reportTime, weeklyReportDay: tenants.weeklyReportDay })
    .from(tenants).where(eq(tenants.id, ctx.tenantId)));
  return t;
}

/** Spec 4.8: the daily sales and weekly stock SMS go to the manager phone at this shop time. */
export async function saveReportSettings(db: Db, ctx: Ctx, input: ReportSettings): Promise<{ ok: true } | { ok: false; error: 'invalid_input' }> {
  assertPermission(ctx, 'manage_shop_settings');
  if (typeof input.smsReports !== 'boolean' || !/^([01]\d|2[0-3]):[0-5]\d$/.test(input.reportTime) || !Number.isInteger(input.weeklyReportDay)
    || input.weeklyReportDay < 0 || input.weeklyReportDay > 6) return { ok: false, error: 'invalid_input' };
  const next = { smsReports: input.smsReports, reportTime: input.reportTime, weeklyReportDay: input.weeklyReportDay };
  return withTenant(db, ctx.tenantId, async (tx) => {
    await tx.update(tenants).set(next).where(eq(tenants.id, ctx.tenantId));
    await writeAudit(tx, { tenantId: ctx.tenantId, actorType: 'user', actorId: ctx.userId, action: 'report_settings_saved', changes: next });
    return { ok: true } as const;
  });
}

import 'server-only';
import { alias } from 'drizzle-orm/pg-core';
import { and, asc, between, desc, eq, gt, lte, type SQL, sql } from 'drizzle-orm';
import { z } from 'zod';
import type { Db } from '@/db/client';
import { branches, prescriptions, products, saleLines, sales, stockBatches, tenants, users, variants } from '@/db/schema';
import { withTenant } from '@/db/tenant';
import { todayIn } from '@/lib/dates';
import { assertPermission, type Ctx } from './context';
import { type Fail, fail, itemLabel } from './products';

export type BatchRow = { batchId: string; branchName: string; name: string; batchNumber: string; expiryDate: string; onHand: string; valuePesewas: number };
export type PrescriptionRow = {
  saleId: string; receiptNumber: string; businessDate: string; medicine: string; quantity: string;
  patientName: string; prescriberName: string; facility: string; prescriptionDate: string; soldBy: string; approvedBy: string | null;
};
export type PharmacyReport = {
  warningDays: number; nearExpiry: BatchRow[]; nearExpiryValuePesewas: number; expired: BatchRow[]; expiredValuePesewas: number;
  prescriptions: PrescriptionRow[] | null; // null for people who may not dispense: prescriptions are health data
};
const MAX_DAYS = 92;
const day = z.iso.date();
const inputSchema = z.object({ from: day, to: day, branchId: z.uuid().optional() });

/** Spec 4.17, 4.23: near-expiry and expired stock (values at average cost) and the log of prescription-only sales. */
export async function pharmacyReport(db: Db, ctx: Ctx, input: { from: string; to: string; branchId?: string }, now: Date): Promise<
  { ok: true; report: PharmacyReport } | Fail<'invalid_input' | 'range_too_long'>
> {
  assertPermission(ctx, 'view_reports');
  const parsed = inputSchema.safeParse(input);
  if (!parsed.success || parsed.data.to < parsed.data.from) return fail('invalid_input');
  const f = parsed.data;
  if ((Date.parse(f.to) - Date.parse(f.from)) / 86_400_000 + 1 > MAX_DAYS) return fail('range_too_long');
  return withTenant(db, ctx.tenantId, async (tx) => {
    const [shop] = await tx.select({ timezone: tenants.timezone, warningDays: tenants.expiryWarningDays }).from(tenants).where(eq(tenants.id, ctx.tenantId));
    const today = todayIn(shop.timezone, now);
    const horizon = new Date(Date.parse(`${today}T00:00:00Z`) + shop.warningDays * 86_400_000).toISOString().slice(0, 10);
    const batches = async (expiry: SQL | undefined): Promise<BatchRow[]> => (await tx.select({
      batchId: stockBatches.id, branchName: branches.name, productName: products.name, variantName: variants.name, batchNumber: stockBatches.batchNumber,
      expiryDate: stockBatches.expiryDate, onHand: stockBatches.onHand, valuePesewas: sql<number>`round(${stockBatches.onHand} * ${variants.averageCost})::int`,
    }).from(stockBatches).innerJoin(variants, eq(variants.id, stockBatches.variantId)).innerJoin(products, eq(products.id, variants.productId))
      .innerJoin(branches, eq(branches.id, stockBatches.branchId))
      .where(and(gt(stockBatches.onHand, '0'), expiry, f.branchId ? eq(stockBatches.branchId, f.branchId) : undefined))
      .orderBy(asc(stockBatches.expiryDate), asc(products.name))).map((r) => ({
      batchId: r.batchId, branchName: r.branchName, name: itemLabel(r.productName, r.variantName), batchNumber: r.batchNumber,
      expiryDate: r.expiryDate, onHand: r.onHand, valuePesewas: Number(r.valuePesewas),
    }));
    const nearExpiry = await batches(and(gt(stockBatches.expiryDate, today), lte(stockBatches.expiryDate, horizon)));
    const expired = await batches(lte(stockBatches.expiryDate, today));
    let log: PrescriptionRow[] | null = null;
    if (ctx.permissions.includes('dispense_prescription')) {
      const seller = alias(users, 'seller');
      const approver = alias(users, 'approver');
      log = await tx.select({
        saleId: sales.id, receiptNumber: sales.receiptNumber, businessDate: sales.businessDate, medicine: saleLines.name, quantity: saleLines.quantity,
        patientName: prescriptions.patientName, prescriberName: prescriptions.prescriberName, facility: prescriptions.facility,
        prescriptionDate: prescriptions.prescriptionDate, soldBy: seller.name, approvedBy: approver.name,
      }).from(prescriptions).innerJoin(sales, eq(sales.id, prescriptions.saleId)).innerJoin(saleLines, eq(saleLines.id, prescriptions.saleLineId))
        .innerJoin(seller, eq(seller.id, prescriptions.recordedBy)).leftJoin(approver, eq(approver.id, prescriptions.approvedBy))
        .where(and(between(sales.businessDate, f.from, f.to), f.branchId ? eq(sales.branchId, f.branchId) : undefined))
        .orderBy(desc(sales.businessDate), desc(prescriptions.createdAt));
    }
    const sum = (rows: BatchRow[]) => rows.reduce((s, r) => s + r.valuePesewas, 0);
    return {
      ok: true as const,
      report: { warningDays: shop.warningDays, nearExpiry, nearExpiryValuePesewas: sum(nearExpiry), expired, expiredValuePesewas: sum(expired), prescriptions: log },
    };
  });
}

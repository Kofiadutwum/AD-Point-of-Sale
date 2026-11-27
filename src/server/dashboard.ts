import 'server-only';
import { and, asc, desc, eq, gte, isNotNull, sql } from 'drizzle-orm';
import type { Db } from '@/db/client';
import { branches, payments, potRecords, products, registers, sales, stockBalances, TENDER_METHODS, type TenderMethod, tenants, variants } from '@/db/schema';
import { withTenant } from '@/db/tenant';
import { addDays, businessDate } from '@/lib/dates';
import { assertPermission, type Ctx } from './context';
import { potReminders } from './pots';
import { itemLabel } from './products';

const ORDER: readonly string[] = [...TENDER_METHODS, 'deposit', 'paystack', 'exchange_credit']; // display order; server-only tenders last

export type Dashboard = {
  businessDate: string; salesCount: number; grossPesewas: number; discountPesewas: number; netPesewas: number; taxPesewas: number;
  totalPesewas: number; averagePesewas: number; payments: Array<{ method: TenderMethod; amountPesewas: number }>;
  lowStock: Array<{ variantId: string; name: string; branchName: string; onHand: string; reorderLevel: string }>;
  negativeStock: Array<{ variantId: string; name: string; branchName: string; onHand: string }>;
  needsReview: number;
  registers: Array<{ name: string; branchName: string; salesCount: number; totalPesewas: number }>; // Phase 6: several tills per branch
  potReminders: Array<{ name: string; businessDate: string }>;
  potVariances: Array<{ name: string; businessDate: string; expectedPesewas: number; actualPesewas: number; variancePesewas: number }>;
};

/** Spec 4.7 basics: today's completed sales (by business day), how they were paid, and stock that needs attention. */
export async function getDashboard(db: Db, ctx: Ctx, now: Date): Promise<Dashboard> {
  assertPermission(ctx, 'view_dashboard');
  return withTenant(db, ctx.tenantId, async (tx) => {
    const [shop] = await tx.select({ timezone: tenants.timezone, cutoff: tenants.businessDayCutoff }).from(tenants).where(eq(tenants.id, ctx.tenantId));
    const day = businessDate(shop.timezone, shop.cutoff, now);
    const today = and(eq(sales.businessDate, day), eq(sales.status, 'completed'));
    const int = (col: unknown) => sql<number>`coalesce(sum(${col}), 0)::int`;
    const [t] = await tx.select({
      n: sql<number>`count(*)::int`, gross: int(sales.subtotalPesewas), discount: int(sales.discountPesewas), tax: int(sales.taxPesewas),
      total: int(sales.totalPesewas), change: int(sales.changeDuePesewas),
    }).from(sales).where(today);
    const byMethod = await tx.select({ method: payments.method, amount: int(payments.amountPesewas) }).from(payments)
      .innerJoin(sales, eq(sales.id, payments.saleId)).where(today).groupBy(payments.method);
    const paid = byMethod.map((m) => ({
      method: m.method as TenderMethod, amountPesewas: m.amount - (m.method === 'cash' ? t.change : 0), // cash collected, after change given
    })).filter((m) => m.amountPesewas > 0).sort((a, b) => ORDER.indexOf(a.method) - ORDER.indexOf(b.method));
    const tills = await tx.select({ name: registers.name, branchName: branches.name, n: sql<number>`count(*)::int`, total: int(sales.totalPesewas) }).from(sales)
      .innerJoin(registers, eq(registers.id, sales.registerId)).innerJoin(branches, eq(branches.id, registers.branchId))
      .where(today).groupBy(registers.name, branches.name).orderBy(asc(branches.name), asc(registers.name));
    const [{ review }] = await tx.select({ review: sql<number>`count(*)::int` }).from(sales).where(eq(sales.needsReview, true));
    const stockCols = {
      variantId: variants.id, productName: products.name, variantName: variants.name, branchName: branches.name, onHand: stockBalances.onHand,
      reorderLevel: variants.reorderLevel,
    };
    const stockFrom = () => tx.select(stockCols).from(stockBalances)
      .innerJoin(variants, eq(variants.id, stockBalances.variantId)).innerJoin(products, eq(products.id, variants.productId))
      .innerJoin(branches, eq(branches.id, stockBalances.branchId));
    const low = await stockFrom().where(and(eq(products.trackStock, true), isNotNull(variants.reorderLevel), sql`${stockBalances.onHand} >= 0`, sql`${stockBalances.onHand} <= ${variants.reorderLevel}`))
      .orderBy(asc(products.name)).limit(50);
    const negative = await stockFrom().where(and(eq(products.trackStock, true), sql`${stockBalances.onHand} < 0`)).orderBy(asc(products.name)).limit(50);
    // spec 6.54: pots still waiting for a closing count, and flagged gaps of the last 7 days
    const reminders = await potReminders(tx, day);
    const variances = await tx.select({ name: products.name, businessDate: potRecords.businessDate, expectedPesewas: potRecords.expectedPesewas,
      actualPesewas: potRecords.actualPesewas, variancePesewas: potRecords.variancePesewas }).from(potRecords)
      .innerJoin(variants, eq(variants.id, potRecords.variantId)).innerJoin(products, eq(products.id, variants.productId))
      .where(and(eq(potRecords.flagged, true), gte(potRecords.businessDate, addDays(day, -7)))).orderBy(desc(potRecords.businessDate)).limit(50);
    return {
      businessDate: day, salesCount: t.n, grossPesewas: t.gross, discountPesewas: t.discount, netPesewas: t.gross - t.discount, taxPesewas: t.tax,
      totalPesewas: t.total, averagePesewas: t.n ? Math.floor((2 * t.total + t.n) / (2 * t.n)) : 0, payments: paid,
      lowStock: low.map((r) => ({ variantId: r.variantId, name: itemLabel(r.productName, r.variantName), branchName: r.branchName, onHand: r.onHand, reorderLevel: r.reorderLevel! })),
      negativeStock: negative.map((r) => ({ variantId: r.variantId, name: itemLabel(r.productName, r.variantName), branchName: r.branchName, onHand: r.onHand })),
      needsReview: review,
      registers: tills.map((r) => ({ name: r.name, branchName: r.branchName, salesCount: r.n, totalPesewas: r.total })),
      potReminders: reminders.map((r) => ({ name: r.name, businessDate: r.businessDate })),
      potVariances: variances.map((v) => ({ name: v.name, businessDate: v.businessDate, expectedPesewas: v.expectedPesewas!, actualPesewas: v.actualPesewas!, variancePesewas: v.variancePesewas! })),
    };
  });
}

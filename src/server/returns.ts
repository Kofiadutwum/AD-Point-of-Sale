import 'server-only';
import { and, asc, desc, eq, inArray, isNotNull, sql } from 'drizzle-orm';
import { z } from 'zod';
import type { Db, Tx } from '@/db/client';
import {
  payments, products, returnLines, returns, saleLines, sales, stockBatches, stockMovements, tenants, users, variants, type TenderMethod,
} from '@/db/schema';
import { withTenant } from '@/db/tenant';
import { divHalfUp, fromMilli, parseQuantity, toMilli } from '@/lib/decimal';
import { type ApprovalAction, consumeApproval } from './approvals';
import { writeAudit } from './audit';
import { assertPermission, type Ctx } from './context';
import { creditStoreCredit } from './customers';
import { type Fail, fail, isUuid } from './products';
import { changeBalance } from './stock';

export type RefundMethod = 'cash' | 'momo_manual' | 'card_terminal' | 'bank_transfer' | 'store_credit';
export type ReturnItem = { saleLineId: string; quantity: string; condition: 'saleable' | 'damaged' | 'expired' };
export type ReturnLineView = { saleLineId: string; name: string; unitName: string; sold: string; returned: string; returnable: string; unitRefundPesewas: number };

const REFUND_METHODS = ['cash', 'momo_manual', 'card_terminal', 'bank_transfer', 'store_credit'] as const;
const itemSchema = z.object({ saleLineId: z.string(), quantity: z.string(), condition: z.enum(['saleable', 'damaged', 'expired']) });
const quoteSchema = z.object({ saleId: z.uuid(), items: z.array(itemSchema).min(1).max(100), refundMethod: z.enum(REFUND_METHODS) });
const processSchema = quoteSchema.extend({
  reason: z.string().trim().min(1).max(200), reference: z.string().trim().max(100).optional(), approvalToken: z.string().max(200).optional(),
});

const myBranches = async (tx: Tx, ctx: Ctx) => (await tx.select({ branchIds: users.branchIds }).from(users).where(eq(users.id, ctx.userId)))[0]?.branchIds ?? [];
const refundKey = (saleId: string, pesewas: number) => `${saleId}:${pesewas}`;

/** A completed sale at one of the user's branches, its lines, and what each has had back so far. `lock` holds the sale row so two returns queue. */
async function loadSale(tx: Tx, ctx: Ctx, where: { saleId: string } | { receiptNumber: string }, lock: boolean) {
  const q = tx.select().from(sales).where('saleId' in where ? eq(sales.id, where.saleId) : eq(sales.receiptNumber, where.receiptNumber));
  const [sale] = lock ? await q.for('update') : await q;
  if (!sale || sale.status !== 'completed' || !(await myBranches(tx, ctx)).includes(sale.branchId)) return null;
  const lines = await tx.select({
    id: saleLines.id, variantId: saleLines.variantId, unitId: saleLines.unitId, name: saleLines.name, unitName: saleLines.unitName,
    quantity: saleLines.quantity, baseQuantity: saleLines.baseQuantity, totalPesewas: saleLines.totalPesewas, byAmount: saleLines.byAmount,
    choices: saleLines.choices, kind: variants.kind, tracking: products.tracking,
  }).from(saleLines).innerJoin(variants, eq(variants.id, saleLines.variantId)).innerJoin(products, eq(products.id, variants.productId))
    .where(eq(saleLines.saleId, sale.id)).orderBy(asc(saleLines.lineNo));
  const done = lines.length ? await tx.select({
    saleLineId: returnLines.saleLineId, quantity: sql<string>`sum(${returnLines.quantity})::numeric(14,3)::text`, refund: sql<number>`sum(${returnLines.refundPesewas})::int`,
  }).from(returnLines).where(inArray(returnLines.saleLineId, lines.map((l) => l.id))).groupBy(returnLines.saleLineId) : [];
  const [main] = await tx.select({ method: payments.method }).from(payments).where(eq(payments.saleId, sale.id)).orderBy(desc(payments.amountPesewas)).limit(1);
  return {
    sale, method: (main?.method ?? 'cash') as TenderMethod,
    lines: lines.map((l) => {
      const d = done.find((x) => x.saleLineId === l.id);
      // shortcut: bundles, recipes, combos, serial and by-amount items come back with exchanges (Plan 1b-8)
      const returnableKind = l.kind === 'standard' && l.tracking !== 'serial' && !l.byAmount && l.choices.length === 0;
      return { ...l, returnableKind, returnedMilli: toMilli(d?.quantity ?? '0'), refundedPesewas: d?.refund ?? 0 };
    }),
  };
}
type Loaded = NonNullable<Awaited<ReturnType<typeof loadSale>>>;

type PlanError = 'invalid_input' | 'not_found' | 'too_many' | 'not_returnable';
/** Each line's refund is its share of the line total, rounded half up; the last of a line gets exactly what is left of it. */
function planReturn(loaded: Loaded, items: ReturnItem[]) {
  const seen = new Set<string>();
  const planned = [];
  for (const item of items) {
    const l = loaded.lines.find((x) => x.id === item.saleLineId);
    if (!isUuid(item.saleLineId) || !l) return fail<PlanError>('not_found');
    const qty = parseQuantity(item.quantity);
    if (!qty || toMilli(qty) <= 0n || seen.has(l.id)) return fail<PlanError>('invalid_input');
    seen.add(l.id);
    if (!l.returnableKind) return fail<PlanError>('not_returnable');
    const q = toMilli(qty), sold = toMilli(l.quantity);
    if (l.returnedMilli + q > sold) return fail<PlanError>('too_many');
    const refund = l.returnedMilli + q === sold ? l.totalPesewas - l.refundedPesewas : Number(divHalfUp(BigInt(l.totalPesewas) * q, sold));
    planned.push({ line: l, item, quantity: qty, baseQuantity: fromMilli(divHalfUp(toMilli(l.baseQuantity) * q, sold)), refund });
  }
  return { ok: true as const, planned, total: planned.reduce((s, x) => s + x.refund, 0) };
}

/** Spec 6.12: another method than the sale's main tender, or a total above the shop's limit, needs a manager unless the user may do it freely. */
async function approvalFor(tx: Tx, ctx: Ctx, loaded: Loaded, method: RefundMethod, total: number): Promise<{ action: ApprovalAction; contextKey: string } | null> {
  const [t] = await tx.select({ limit: tenants.refundLimitPesewas }).from(tenants).where(eq(tenants.id, ctx.tenantId));
  const contextKey = refundKey(loaded.sale.id, total);
  if (method !== loaded.method && !ctx.permissions.includes('refund_other_method')) return { action: 'refund_other_method', contextKey };
  if (total > (t?.limit ?? 0) && !ctx.permissions.includes('refund_without_approval')) return { action: 'refund', contextKey };
  return null;
}

export async function findReturnableSale(db: Db, ctx: Ctx, receiptNumber: string): Promise<{
  saleId: string; receiptNumber: string; method: TenderMethod; customerId: string | null; lines: ReturnLineView[];
} | null> {
  assertPermission(ctx, 'process_return');
  if (typeof receiptNumber !== 'string' || !receiptNumber.trim() || receiptNumber.length > 40) return null;
  return withTenant(db, ctx.tenantId, async (tx) => {
    const loaded = await loadSale(tx, ctx, { receiptNumber: receiptNumber.trim().toUpperCase() }, false);
    if (!loaded) return null;
    return {
      saleId: loaded.sale.id, receiptNumber: loaded.sale.receiptNumber, method: loaded.method, customerId: loaded.sale.customerId,
      lines: loaded.lines.map((l) => {
        const sold = toMilli(l.quantity);
        return {
          saleLineId: l.id, name: l.name, unitName: l.unitName, sold: l.quantity, returned: fromMilli(l.returnedMilli),
          returnable: l.returnableKind ? fromMilli(sold - l.returnedMilli) : '0.000', unitRefundPesewas: Number(divHalfUp(BigInt(l.totalPesewas) * 1000n, sold)),
        };
      }),
    };
  });
}

export async function quoteReturn(db: Db, ctx: Ctx, input: { saleId: string; items: ReturnItem[]; refundMethod: RefundMethod }): Promise<
  { ok: true; refundPesewas: number; approval: { action: ApprovalAction; contextKey: string } | null } | Fail<PlanError>
> {
  assertPermission(ctx, 'process_return');
  const parsed = quoteSchema.safeParse(input);
  if (!parsed.success) return fail('invalid_input');
  return withTenant(db, ctx.tenantId, async (tx) => {
    const loaded = await loadSale(tx, ctx, { saleId: parsed.data.saleId }, false);
    if (!loaded) return fail<PlanError>('not_found');
    const plan = planReturn(loaded, parsed.data.items);
    if (!plan.ok) return plan;
    return { ok: true as const, refundPesewas: plan.total, approval: await approvalFor(tx, ctx, loaded, parsed.data.refundMethod, plan.total) };
  });
}

type ProcessError = PlanError | 'approval_required' | 'reference_required' | 'needs_customer';

/** Spec 6.12: records the return, puts saleable stock back (into the batches it was sold from), and refunds, all in one transaction. */
export async function processReturn(db: Db, ctx: Ctx, input: {
  saleId: string; items: ReturnItem[]; reason: string; refundMethod: RefundMethod; reference?: string; approvalToken?: string;
}, now: Date): Promise<{ ok: true; returnId: string; refundPesewas: number } | Fail<ProcessError>> {
  assertPermission(ctx, 'process_return');
  const parsed = processSchema.safeParse(input);
  if (!parsed.success) return fail('invalid_input');
  const s = parsed.data;
  return withTenant(db, ctx.tenantId, async (tx) => {
    const loaded = await loadSale(tx, ctx, { saleId: s.saleId }, true);
    if (!loaded) return fail<ProcessError>('not_found');
    const plan = planReturn(loaded, s.items);
    if (!plan.ok) return plan;
    const reference = s.reference || null;
    if (s.refundMethod !== 'cash' && s.refundMethod !== 'store_credit' && !reference) return fail<ProcessError>('reference_required');
    if (s.refundMethod === 'store_credit' && !loaded.sale.customerId) return fail<ProcessError>('needs_customer');
    const needed = await approvalFor(tx, ctx, loaded, s.refundMethod, plan.total);
    const approval = needed ? await consumeApproval(tx, ctx, { token: s.approvalToken ?? '', ...needed }, now) : null;
    if (needed && !approval) return fail<ProcessError>('approval_required');

    const [ret] = await tx.insert(returns).values({
      tenantId: ctx.tenantId, branchId: loaded.sale.branchId, saleId: loaded.sale.id, customerId: loaded.sale.customerId, kind: 'receipt', reason: s.reason,
      refundMethod: s.refundMethod, refundPesewas: plan.total, reference, requestedBy: ctx.userId, approvedBy: approval?.approverId ?? null,
    }).returning({ id: returns.id });
    await tx.insert(returnLines).values(plan.planned.map((x) => ({
      tenantId: ctx.tenantId, returnId: ret.id, saleLineId: x.line.id, variantId: x.line.variantId, unitId: x.line.unitId,
      quantity: x.quantity, baseQuantity: x.baseQuantity, condition: x.item.condition, refundPesewas: x.refund,
    })));
    for (const x of plan.planned) {
      if (x.item.condition === 'saleable') await restock(tx, ctx, { branchId: loaded.sale.branchId, returnId: ret.id, saleLineId: x.line.id, variantId: x.line.variantId, tracking: x.line.tracking, baseQuantity: x.baseQuantity });
    }
    if (s.refundMethod === 'store_credit' && loaded.sale.customerId && plan.total > 0) {
      await creditStoreCredit(tx, { tenantId: ctx.tenantId, customerId: loaded.sale.customerId, amountPesewas: plan.total, source: 'refund', userId: ctx.userId, saleId: loaded.sale.id, reason: s.reason });
    }
    await writeAudit(tx, {
      tenantId: ctx.tenantId, actorType: 'user', actorId: ctx.userId, action: 'return_processed', recordType: 'sale', recordId: loaded.sale.id,
      reason: s.reason, changes: { returnId: ret.id, refundPesewas: plan.total, refundMethod: s.refundMethod, approvedBy: approval?.approverId ?? null },
    });
    return { ok: true as const, returnId: ret.id, refundPesewas: plan.total };
  });
}

/** Back on hand; a batch item goes back into the batches its sale line took from, up to what each gave and has not already had back. */
async function restock(tx: Tx, ctx: Ctx, r: { branchId: string; returnId: string; saleLineId: string; variantId: string; tracking: string; baseQuantity: string }) {
  const move = (quantity: string, batchId: string | null = null) => tx.insert(stockMovements).values({
    tenantId: ctx.tenantId, branchId: r.branchId, variantId: r.variantId, type: 'return_restock', quantity, batchId,
    referenceType: 'return', referenceId: r.returnId, saleLineId: r.saleLineId, userId: ctx.userId,
  });
  let left = toMilli(r.baseQuantity);
  if (r.tracking === 'batch') {
    const byBatch = await tx.select({ batchId: stockMovements.batchId, net: sql<string>`sum(${stockMovements.quantity})::numeric(14,3)::text`, first: sql<number>`min(${stockMovements.id})` })
      .from(stockMovements).where(and(eq(stockMovements.saleLineId, r.saleLineId), isNotNull(stockMovements.batchId), inArray(stockMovements.type, ['sale', 'return_restock'])))
      .groupBy(stockMovements.batchId).orderBy(sql`min(${stockMovements.id})`);
    for (const b of byBatch) {
      const room = -toMilli(b.net); // taken by the sale minus already returned
      const put = left < room ? left : room;
      if (put <= 0n || !b.batchId) continue;
      await tx.update(stockBatches).set({ onHand: sql`${stockBatches.onHand} + ${fromMilli(put)}::numeric` }).where(eq(stockBatches.id, b.batchId));
      await move(fromMilli(put), b.batchId);
      left -= put;
    }
  }
  if (left > 0n) await move(fromMilli(left));
  await changeBalance(tx, ctx.tenantId, r.branchId, r.variantId, r.baseQuantity);
}

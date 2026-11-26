import 'server-only';
import { and, asc, desc, eq, gt, inArray, isNull, lte, ne, sql } from 'drizzle-orm';
import type { Db, Tx } from '@/db/client';
import {
  type AdjustmentReason, barcodes, branches, categories, products, stockAdjustments, stockBalances, stockBatches, stockCountLines, stockCounts, stockMovements, stockTransferLines, stockTransfers,
  supplierItems, suppliers, tenants, variants, variantUnits,
} from '@/db/schema';
import { withTenant } from '@/db/tenant';
import { fromMilli, parseQuantity, toMilli } from '@/lib/decimal';
import { consumeApproval } from './approvals';
import { writeAudit } from './audit';
import { assertPermission, type Ctx } from './context';
import { type Fail, fail, isUuid, itemLabel } from './products';
import { lookupStockItem } from './stock';
import { type LineError, type MoveLine, putStock, resolveLine, takeStock, valueOf } from './stock-moves';

const audit = (tx: Tx, ctx: Ctx, action: string, recordType: string, recordId: string, changes?: Record<string, unknown>) =>
  writeAudit(tx, { tenantId: ctx.tenantId, actorType: 'user', actorId: ctx.userId, action, recordType, recordId, changes });
const text = (v: unknown, max: number) => (typeof v === 'string' ? v.trim().slice(0, max) : '');
class Stop extends Error { constructor(readonly code: string, readonly at?: string) { super(code); } }
async function stopping<T>(run: () => Promise<T>): Promise<T | { ok: false; error: never; detail?: string }> {
  try { return await run(); } catch (e) { if (e instanceof Stop) return fail(e.code as never, e.at); throw e; }
}
type MoveError = LineError | 'not_enough_stock' | 'unknown_batch';

// ---- Transfers (spec 6.25) -------------------------------------------------

export async function sendTransfer(db: Db, ctx: Ctx, input: { fromBranchId: string; toBranchId: string; lines: MoveLine[]; note?: string }, now: Date): Promise<
  { ok: true; transferId: string; number: string } | Fail<'invalid_input' | 'not_found' | 'same_branch' | MoveError>
> {
  assertPermission(ctx, 'transfer_stock');
  if (!isUuid(input.fromBranchId) || !isUuid(input.toBranchId) || !Array.isArray(input.lines) || !input.lines.length || input.lines.length > 100) return fail('invalid_input');
  if (input.fromBranchId === input.toBranchId) return fail('same_branch');
  return stopping(() => withTenant(db, ctx.tenantId, async (tx) => {
    const found = await tx.select({ id: branches.id }).from(branches).where(inArray(branches.id, [input.fromBranchId, input.toBranchId]));
    if (found.length !== 2) return fail('not_found');
    await tx.select({ id: tenants.id }).from(tenants).where(eq(tenants.id, ctx.tenantId)).for('update');
    const [{ n }] = await tx.select({ n: sql<number>`count(*)::int` }).from(stockTransfers);
    const number = `TR-${String(n + 1).padStart(4, '0')}`;
    const [tr] = await tx.insert(stockTransfers).values({ tenantId: ctx.tenantId, number, fromBranchId: input.fromBranchId, toBranchId: input.toBranchId, note: text(input.note, 200) || null, sentBy: ctx.userId, sentAt: now })
      .returning({ id: stockTransfers.id });
    for (const [i, l] of input.lines.entries()) {
      const r = await resolveLine(tx, l);
      if (typeof r === 'string') throw new Stop(r, String(i));
      const took = await takeStock(tx, ctx, input.fromBranchId, r, { type: 'transfer_out', referenceType: 'transfer', referenceId: tr.id }, true);
      if (!took.ok) throw new Stop(took.error, String(i));
      await tx.insert(stockTransferLines).values({ tenantId: ctx.tenantId, transferId: tr.id, variantId: r.variantId, batchNumber: r.batchNumber, expiryDate: took.expiryDate, quantity: r.baseQty, unitCost: r.averageCost });
    }
    await audit(tx, ctx, 'transfer_sent', 'stock_transfer', tr.id, { number, lines: input.lines.length });
    return { ok: true as const, transferId: tr.id, number };
  }));
}

/** The receiving branch confirms what arrived; any difference needs a reason and stays on the transfer for both managers to see. */
export async function receiveTransfer(db: Db, ctx: Ctx, input: { transferId: string; lines: Array<{ lineId: string; receivedQuantity: string; reason?: string }> }, now: Date): Promise<
  { ok: true; differences: number } | Fail<'invalid_input' | 'not_found' | 'already_received' | 'reason_required'>
> {
  assertPermission(ctx, 'receive_stock');
  if (!isUuid(input.transferId) || !Array.isArray(input.lines)) return fail('invalid_input');
  return stopping(() => withTenant(db, ctx.tenantId, async (tx) => {
    const [tr] = await tx.select().from(stockTransfers).where(eq(stockTransfers.id, input.transferId)).for('update');
    if (!tr) return fail('not_found');
    if (tr.status !== 'sent') return fail('already_received');
    const lines = await tx.select().from(stockTransferLines).where(eq(stockTransferLines.transferId, tr.id));
    let differences = 0;
    for (const l of lines) {
      const given = input.lines.find((x) => x.lineId === l.id);
      const received = given ? parseQuantity(given.receivedQuantity) : l.quantity;
      if (received === null || toMilli(received) < 0n) throw new Stop('invalid_input');
      const reason = text(given?.reason, 200) || null;
      if (toMilli(received) !== toMilli(l.quantity)) {
        if (!reason) throw new Stop('reason_required', l.id);
        differences++;
      }
      if (toMilli(received) > 0n) {
        await putStock(tx, ctx, tr.toBranchId, l.variantId, received, l.batchNumber && l.expiryDate ? { number: l.batchNumber, expiry: l.expiryDate } : null,
          { type: 'transfer_in', referenceType: 'transfer', referenceId: tr.id });
      }
      await tx.update(stockTransferLines).set({ receivedQuantity: received, differenceReason: reason }).where(eq(stockTransferLines.id, l.id));
    }
    await tx.update(stockTransfers).set({ status: 'received', receivedBy: ctx.userId, receivedAt: now }).where(eq(stockTransfers.id, tr.id));
    await audit(tx, ctx, 'transfer_received', 'stock_transfer', tr.id, { differences });
    return { ok: true as const, differences };
  }));
}

export async function listTransfers(db: Db, ctx: Ctx) {
  assertPermission(ctx, 'receive_stock');
  return withTenant(db, ctx.tenantId, async (tx) => {
    const rows = await tx.select().from(stockTransfers).orderBy(desc(stockTransfers.sentAt)).limit(50);
    const names = new Map((await tx.select({ id: branches.id, name: branches.name }).from(branches)).map((b) => [b.id, b.name]));
    return rows.map((r) => ({ ...r, fromName: names.get(r.fromBranchId) ?? '', toName: names.get(r.toBranchId) ?? '' }));
  });
}

export async function getTransfer(db: Db, ctx: Ctx, id: string) {
  assertPermission(ctx, 'receive_stock');
  if (!isUuid(id)) return null;
  return withTenant(db, ctx.tenantId, async (tx) => {
    const [tr] = await tx.select().from(stockTransfers).where(eq(stockTransfers.id, id));
    if (!tr) return null;
    const lines = await tx.select({ l: stockTransferLines, p: products.name, v: variants.name }).from(stockTransferLines)
      .innerJoin(variants, eq(variants.id, stockTransferLines.variantId)).innerJoin(products, eq(products.id, variants.productId)).where(eq(stockTransferLines.transferId, id));
    return { ...tr, lines: lines.map((x) => ({ ...x.l, name: itemLabel(x.p, x.v) })) };
  });
}

// ---- Stock counts (spec 6.26) ---------------------------------------------

/** Takes the snapshot: every stocked item at the branch (or just the listed ones), batch by batch for batch-tracked items. */
export async function startCount(db: Db, ctx: Ctx, input: { branchId: string; variantIds?: string[]; note?: string }, now: Date): Promise<{ ok: true; countId: string; lines: number } | Fail<'invalid_input' | 'not_found' | 'nothing_to_count'>> {
  assertPermission(ctx, 'stock_count');
  if (!isUuid(input.branchId) || (input.variantIds && (!Array.isArray(input.variantIds) || !input.variantIds.every(isUuid)))) return fail('invalid_input');
  return withTenant(db, ctx.tenantId, async (tx) => {
    const [b] = await tx.select({ id: branches.id }).from(branches).where(eq(branches.id, input.branchId));
    if (!b) return fail('not_found');
    const only = input.variantIds?.length ? inArray(variants.id, input.variantIds) : undefined;
    const items = await tx.select({ id: variants.id, tracking: products.tracking, onHand: stockBalances.onHand }).from(variants).innerJoin(products, eq(products.id, variants.productId))
      .leftJoin(stockBalances, and(eq(stockBalances.variantId, variants.id), eq(stockBalances.branchId, input.branchId)))
      .where(and(eq(variants.kind, 'standard'), ne(products.tracking, 'serial'), eq(variants.status, 'active'), only));
    const batchRows = await tx.select().from(stockBatches).where(and(eq(stockBatches.branchId, input.branchId), gt(stockBatches.onHand, '0')));
    const [count] = await tx.insert(stockCounts).values({ tenantId: ctx.tenantId, branchId: input.branchId, note: text(input.note, 200) || null, startedBy: ctx.userId, startedAt: now }).returning({ id: stockCounts.id });
    let n = 0;
    for (const it of items) {
      if (it.tracking === 'batch') {
        for (const bt of batchRows.filter((x) => x.variantId === it.id)) {
          await tx.insert(stockCountLines).values({ tenantId: ctx.tenantId, countId: count.id, variantId: it.id, batchId: bt.id, expected: bt.onHand });
          n++;
        }
      } else if (it.onHand !== null || only) {
        await tx.insert(stockCountLines).values({ tenantId: ctx.tenantId, countId: count.id, variantId: it.id, expected: it.onHand ?? '0' });
        n++;
      }
    }
    if (n === 0) { await tx.delete(stockCounts).where(eq(stockCounts.id, count.id)); return fail('nothing_to_count'); }
    await audit(tx, ctx, 'stock_count_started', 'stock_count', count.id, { lines: n });
    return { ok: true as const, countId: count.id, lines: n };
  });
}

/** Records a counted quantity (base units); 'add' lets repeat scans add up. */
export async function recordCount(db: Db, ctx: Ctx, input: { countId: string; variantId: string; batchNumber?: string; quantity: string; mode: 'set' | 'add' }, now: Date): Promise<{ ok: true; counted: string } | Fail<'invalid_input' | 'not_found' | 'not_open' | 'not_in_count'>> {
  assertPermission(ctx, 'stock_count');
  const q = parseQuantity(input.quantity);
  if (!isUuid(input.countId) || !isUuid(input.variantId) || q === null || toMilli(q) < 0n) return fail('invalid_input');
  return withTenant(db, ctx.tenantId, async (tx) => {
    const [c] = await tx.select().from(stockCounts).where(eq(stockCounts.id, input.countId));
    if (!c) return fail('not_found');
    if (c.status !== 'open') return fail('not_open');
    const batch = input.batchNumber?.trim();
    const [line] = await tx.select({ l: stockCountLines }).from(stockCountLines).leftJoin(stockBatches, eq(stockBatches.id, stockCountLines.batchId))
      .where(and(eq(stockCountLines.countId, c.id), eq(stockCountLines.variantId, input.variantId), batch ? eq(stockBatches.batchNumber, batch) : isNull(stockCountLines.batchId)));
    if (!line) return fail('not_in_count');
    const counted = input.mode === 'add' && line.l.counted !== null ? fromMilli(toMilli(line.l.counted) + toMilli(q)) : q;
    await tx.update(stockCountLines).set({ counted, countedAt: now }).where(eq(stockCountLines.id, line.l.id));
    return { ok: true as const, counted };
  });
}

/** Spec 6.26: expected = snapshot + stock moved since the count started up to when the item was counted; differences adjust stock. Uncounted items are left alone. */
export async function finishCount(db: Db, ctx: Ctx, input: { countId: string; approvalToken?: string }, now: Date): Promise<
  { ok: true; counted: number; notCounted: number; differenceValuePesewas: number } | Fail<'not_found' | 'not_open' | 'approval_required'>
> {
  assertPermission(ctx, 'stock_count');
  if (!isUuid(input.countId)) return fail('not_found');
  return withTenant(db, ctx.tenantId, async (tx) => {
    const [c] = await tx.select().from(stockCounts).where(eq(stockCounts.id, input.countId)).for('update');
    if (!c) return fail('not_found');
    if (c.status !== 'open') return fail('not_open');
    const lines = await tx.select({ l: stockCountLines, avg: variants.averageCost, batchNumber: stockBatches.batchNumber, expiry: stockBatches.expiryDate }).from(stockCountLines)
      .innerJoin(variants, eq(variants.id, stockCountLines.variantId)).leftJoin(stockBatches, eq(stockBatches.id, stockCountLines.batchId)).where(eq(stockCountLines.countId, c.id));
    const plan = [];
    let value = 0;
    for (const x of lines.filter((y) => y.l.counted !== null)) {
      const [m] = await tx.select({ net: sql<string>`coalesce(sum(${stockMovements.quantity}), 0)::numeric(14,3)::text` }).from(stockMovements).where(and(
        eq(stockMovements.branchId, c.branchId), eq(stockMovements.variantId, x.l.variantId), x.l.batchId ? eq(stockMovements.batchId, x.l.batchId) : undefined,
        gt(stockMovements.createdAt, c.startedAt), lte(stockMovements.createdAt, x.l.countedAt!)));
      const diff = toMilli(x.l.counted!) - (toMilli(x.l.expected) + toMilli(m.net));
      plan.push({ x, diff });
      value += valueOf(fromMilli(diff < 0n ? -diff : diff), x.avg);
    }
    const [t] = await tx.select({ limit: tenants.countApprovalLimitPesewas }).from(tenants).where(eq(tenants.id, ctx.tenantId));
    let approvedBy: string | null = null;
    if (value > t.limit && !ctx.permissions.includes('approve_actions')) {
      const a = input.approvalToken ? await consumeApproval(tx, ctx, { token: input.approvalToken, action: 'stock_count', contextKey: c.id }, now) : null;
      if (!a) return fail('approval_required');
      approvedBy = a.approverId;
    }
    for (const { x, diff } of plan) {
      await tx.update(stockCountLines).set({ difference: fromMilli(diff) }).where(eq(stockCountLines.id, x.l.id));
      if (diff === 0n) continue;
      const ref = { type: 'count_adjustment' as const, referenceType: 'stock_count' as const, referenceId: c.id };
      if (diff > 0n) {
        await putStock(tx, ctx, c.branchId, x.l.variantId, fromMilli(diff), x.batchNumber && x.expiry ? { number: x.batchNumber, expiry: x.expiry } : null, ref);
      } else {
        await takeStock(tx, ctx, c.branchId, { variantId: x.l.variantId, baseQty: fromMilli(-diff), tracking: x.batchNumber ? 'batch' : 'none', averageCost: x.avg, name: '', batchNumber: x.batchNumber }, ref, false);
      }
    }
    await tx.update(stockCounts).set({ status: 'completed', completedBy: ctx.userId, completedAt: now, approvedBy, differenceValuePesewas: value }).where(eq(stockCounts.id, c.id));
    await audit(tx, ctx, 'stock_count_completed', 'stock_count', c.id, { counted: plan.length, differenceValuePesewas: value });
    return { ok: true as const, counted: plan.length, notCounted: lines.length - plan.length, differenceValuePesewas: value };
  });
}

export async function cancelCount(db: Db, ctx: Ctx, countId: string): Promise<{ ok: true } | Fail<'not_found'>> {
  assertPermission(ctx, 'stock_count');
  if (!isUuid(countId)) return fail('not_found');
  return withTenant(db, ctx.tenantId, async (tx) => {
    const [c] = await tx.update(stockCounts).set({ status: 'cancelled' }).where(and(eq(stockCounts.id, countId), eq(stockCounts.status, 'open'))).returning({ id: stockCounts.id });
    return c ? { ok: true as const } : fail('not_found');
  });
}

export async function getCount(db: Db, ctx: Ctx, countId: string) {
  assertPermission(ctx, 'stock_count');
  if (!isUuid(countId)) return null;
  return withTenant(db, ctx.tenantId, async (tx) => {
    const [c] = await tx.select({ c: stockCounts, branchName: branches.name }).from(stockCounts).innerJoin(branches, eq(branches.id, stockCounts.branchId)).where(eq(stockCounts.id, countId));
    if (!c) return null;
    const lines = await tx.select({ l: stockCountLines, p: products.name, v: variants.name, batchNumber: stockBatches.batchNumber }).from(stockCountLines)
      .innerJoin(variants, eq(variants.id, stockCountLines.variantId)).innerJoin(products, eq(products.id, variants.productId)).leftJoin(stockBatches, eq(stockBatches.id, stockCountLines.batchId))
      .where(eq(stockCountLines.countId, countId)).orderBy(asc(products.name));
    return { ...c.c, branchName: c.branchName, lines: lines.map((x) => ({ ...x.l, name: itemLabel(x.p, x.v), batchNumber: x.batchNumber })) };
  });
}

export async function listCounts(db: Db, ctx: Ctx) {
  assertPermission(ctx, 'stock_count');
  return withTenant(db, ctx.tenantId, (tx) => tx.select({ id: stockCounts.id, status: stockCounts.status, startedAt: stockCounts.startedAt, branchName: branches.name, value: stockCounts.differenceValuePesewas })
    .from(stockCounts).innerJoin(branches, eq(branches.id, stockCounts.branchId)).orderBy(desc(stockCounts.startedAt)).limit(30));
}

// ---- Adjustments (spec 6.26) ----------------------------------------------

export const ADJUSTMENT_REASONS: Record<AdjustmentReason, string> = { damage: 'Damaged', loss: 'Lost', theft: 'Stolen', own_use: 'Own use', found: 'Found', expiry_disposal: 'Expired, thrown away' };

export async function adjustStock(db: Db, ctx: Ctx, input: { branchId: string; line: MoveLine; reason: AdjustmentReason; note?: string; approvalToken?: string }, now: Date): Promise<
  { ok: true; adjustmentId: string; valuePesewas: number } | Fail<'invalid_input' | 'not_found' | 'approval_required' | MoveError>
> {
  assertPermission(ctx, 'adjust_stock');
  if (!isUuid(input.branchId) || !Object.hasOwn(ADJUSTMENT_REASONS, input.reason)) return fail('invalid_input');
  return stopping(() => withTenant(db, ctx.tenantId, async (tx) => {
    const [b] = await tx.select({ id: branches.id }).from(branches).where(eq(branches.id, input.branchId));
    if (!b) return fail('not_found');
    const r = await resolveLine(tx, input.line);
    if (typeof r === 'string') return fail(r);
    const value = valueOf(r.baseQty, r.averageCost);
    const [t] = await tx.select({ limit: tenants.adjustmentApprovalLimitPesewas }).from(tenants).where(eq(tenants.id, ctx.tenantId));
    let approvedBy: string | null = null;
    if (value > t.limit && !ctx.permissions.includes('approve_actions')) {
      const a = input.approvalToken ? await consumeApproval(tx, ctx, { token: input.approvalToken, action: 'stock_adjustment', contextKey: adjustmentKey(input.branchId, input.line, input.reason) }, now) : null;
      if (!a) return fail('approval_required');
      approvedBy = a.approverId;
    }
    const found = input.reason === 'found';
    const [adj] = await tx.insert(stockAdjustments).values({
      tenantId: ctx.tenantId, branchId: input.branchId, variantId: r.variantId, quantity: found ? r.baseQty : `-${r.baseQty}`, reason: input.reason, note: text(input.note, 200) || null, valuePesewas: value, approvedBy, createdBy: ctx.userId,
    }).returning({ id: stockAdjustments.id });
    const ref = { type: 'adjustment' as const, referenceType: 'adjustment' as const, referenceId: adj.id };
    if (found) {
      let batch = null;
      if (r.tracking === 'batch') {
        const [bt] = await tx.select().from(stockBatches).where(and(eq(stockBatches.branchId, input.branchId), eq(stockBatches.variantId, r.variantId), eq(stockBatches.batchNumber, r.batchNumber!)));
        if (!bt) throw new Stop('unknown_batch');
        batch = { number: bt.batchNumber, expiry: bt.expiryDate };
      }
      await putStock(tx, ctx, input.branchId, r.variantId, r.baseQty, batch, ref);
    } else {
      const took = await takeStock(tx, ctx, input.branchId, r, ref, true);
      if (!took.ok) throw new Stop(took.error);
      if (took.batchId) await tx.update(stockAdjustments).set({ batchId: took.batchId }).where(eq(stockAdjustments.id, adj.id));
    }
    await audit(tx, ctx, 'stock_adjusted', 'stock_adjustment', adj.id, { reason: input.reason, quantity: r.baseQty, valuePesewas: value, approvedBy });
    return { ok: true as const, adjustmentId: adj.id, valuePesewas: value };
  }));
}

/** The approval context for an adjustment: the same branch, item, quantity, and reason the manager approved. */
export const adjustmentKey = (branchId: string, line: MoveLine, reason: string) => `${branchId}:${line.variantId}:${line.unitId}:${line.quantity}:${line.batchNumber ?? ''}:${reason}`;

// ---- Valuation and low stock ------------------------------------------------

export type Valuation = { branches: Array<{ branchId: string; name: string; valuePesewas: number }>; categories: Array<{ name: string; valuePesewas: number }>; inTransitPesewas: number; totalPesewas: number };

/** Stock value at average cost; stock below zero counts as nothing (spec 4.7). */
export async function inventoryValuation(db: Db, ctx: Ctx): Promise<Valuation> {
  assertPermission(ctx, 'view_reports');
  return withTenant(db, ctx.tenantId, async (tx) => {
    const rows = await tx.select({ branchId: stockBalances.branchId, branch: branches.name, category: categories.name, value: sql<number>`sum(greatest(${stockBalances.onHand}, 0) * ${variants.averageCost})::float` })
      .from(stockBalances).innerJoin(branches, eq(branches.id, stockBalances.branchId)).innerJoin(variants, eq(variants.id, stockBalances.variantId))
      .innerJoin(products, eq(products.id, variants.productId)).leftJoin(categories, eq(categories.id, products.categoryId))
      .groupBy(stockBalances.branchId, branches.name, categories.name);
    const [transit] = await tx.select({ v: sql<number>`coalesce(sum(${stockTransferLines.quantity} * ${stockTransferLines.unitCost}), 0)::float` }).from(stockTransferLines)
      .innerJoin(stockTransfers, eq(stockTransfers.id, stockTransferLines.transferId)).where(eq(stockTransfers.status, 'sent'));
    const branchMap = new Map<string, { name: string; v: number }>();
    const catMap = new Map<string, number>();
    for (const r of rows) {
      branchMap.set(r.branchId, { name: r.branch, v: (branchMap.get(r.branchId)?.v ?? 0) + Number(r.value) });
      catMap.set(r.category ?? 'No category', (catMap.get(r.category ?? 'No category') ?? 0) + Number(r.value));
    }
    const branchList = [...branchMap].map(([branchId, b]) => ({ branchId, name: b.name, valuePesewas: Math.round(b.v) }));
    const inTransitPesewas = Math.round(Number(transit.v));
    return {
      branches: branchList, categories: [...catMap].map(([name, v]) => ({ name, valuePesewas: Math.round(v) })).sort((a, b) => b.valuePesewas - a.valuePesewas),
      inTransitPesewas, totalPesewas: branchList.reduce((s, b) => s + b.valuePesewas, 0) + inTransitPesewas,
    };
  });
}

/** Low-stock alert list: at or below the reorder level at each branch, with the main supplier. */
export async function lowStock(db: Db, ctx: Ctx) {
  assertPermission(ctx, 'receive_stock');
  return withTenant(db, ctx.tenantId, async (tx) => {
    const rows = await tx.select({ branch: branches.name, p: products.name, v: variants.name, variantId: variants.id, onHand: stockBalances.onHand, reorder: variants.reorderLevel })
      .from(stockBalances).innerJoin(branches, eq(branches.id, stockBalances.branchId)).innerJoin(variants, eq(variants.id, stockBalances.variantId)).innerJoin(products, eq(products.id, variants.productId))
      .where(and(eq(variants.status, 'active'), sql`${stockBalances.onHand} <= coalesce(${variants.reorderLevel}, 0)`)).orderBy(asc(stockBalances.onHand));
    const mains = await tx.select({ variantId: supplierItems.variantId, name: suppliers.name }).from(supplierItems).innerJoin(suppliers, eq(suppliers.id, supplierItems.supplierId)).where(eq(supplierItems.isMain, true));
    return rows.map((r) => ({ branch: r.branch, name: itemLabel(r.p, r.v), onHand: r.onHand, reorderLevel: r.reorder, supplier: mains.find((m) => m.variantId === r.variantId)?.name ?? null }));
  });
}

// ---- Labels -------------------------------------------------------------------

/** Spec 4.19: what a printed label shows for a scanned or typed code: name, unit price, and the code to print (its barcode, else the SKU). */
export async function labelItems(db: Db, ctx: Ctx, codes: string[]): Promise<Array<{ code: string; name: string; unitName: string; pricePesewas: number; printCode: string | null }>> {
  assertPermission(ctx, 'manage_products');
  const out = [];
  for (const code of codes.slice(0, 50)) {
    const item = await lookupStockItem(db, ctx, code, 'manage_products');
    if (!item) continue;
    const row = await withTenant(db, ctx.tenantId, async (tx) => {
      const [u] = await tx.select({ price: variantUnits.pricePesewas, factor: variantUnits.factor, base: variants.basePricePesewas, sku: variants.sku }).from(variantUnits)
        .innerJoin(variants, eq(variants.id, variantUnits.variantId)).where(eq(variantUnits.id, item.unitId));
      const [bc] = await tx.select({ code: barcodes.code }).from(barcodes).where(eq(barcodes.unitId, item.unitId)).limit(1);
      return { pricePesewas: u.price ?? Math.round(u.base * Number(u.factor)), printCode: bc?.code ?? u.sku };
    });
    out.push({ code, name: item.name, unitName: item.unitName, ...row });
  }
  return out;
}

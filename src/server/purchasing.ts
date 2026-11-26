import 'server-only';
import { and, asc, desc, eq, gte, inArray, ne, sql } from 'drizzle-orm';
import type { Db, Tx } from '@/db/client';
import {
  branches, products, purchaseOrderLines, purchaseOrders, stockBalances, stockMovements, supplierBills, supplierItems, supplierPayments, supplierReturns, suppliers, tenants, variants, variantUnits,
} from '@/db/schema';
import { withTenant } from '@/db/tenant';
import { normaliseEmail, normaliseGhanaPhone } from '@/lib/contact';
import { addDays, todayIn } from '@/lib/dates';
import { fromMilli, parseQuantity, toMilli } from '@/lib/decimal';
import { writeAudit } from './audit';
import { assertPermission, type Ctx } from './context';
import { type Fail, fail, isUuid, itemLabel } from './products';
import { type ReceiveError, receiveStockTx } from './stock';
import { type LineError, type MoveLine, resolveLine, takeStock, valueOf } from './stock-moves';

const audit = (tx: Tx, ctx: Ctx, action: string, recordType: string, recordId: string, changes?: Record<string, unknown>) =>
  writeAudit(tx, { tenantId: ctx.tenantId, actorType: 'user', actorId: ctx.userId, action, recordType, recordId, changes });
const can = (ctx: Ctx) => assertPermission(ctx, 'manage_purchasing');
const text = (v: unknown, max: number) => (typeof v === 'string' ? v.trim().slice(0, max) : '');

/** Thrown inside a transaction to roll it back with a reason. */
class Stop extends Error { constructor(readonly code: string, readonly at?: string) { super(code); } }
async function stopping<T>(run: () => Promise<T>): Promise<T | { ok: false; error: never; detail?: string }> {
  try { return await run(); } catch (e) { if (e instanceof Stop) return fail(e.code as never, e.at); throw e; }
}

async function nextNumber(tx: Tx, ctx: Ctx): Promise<string> {
  await tx.select({ id: tenants.id }).from(tenants).where(eq(tenants.id, ctx.tenantId)).for('update'); // numbers stay unique under concurrent creates
  const [{ n }] = await tx.select({ n: sql<number>`count(*)::int` }).from(purchaseOrders);
  return `PO-${String(n + 1).padStart(4, '0')}`;
}

// ---- Suppliers -------------------------------------------------------------

export type SupplierInput = { id?: string; name: string; phone?: string; email?: string; paymentTermsDays: number; leadTimeDays: number; note?: string };

export async function saveSupplier(db: Db, ctx: Ctx, input: SupplierInput): Promise<{ ok: true; supplierId: string } | Fail<'invalid_input' | 'duplicate_name' | 'not_found'>> {
  can(ctx);
  const name = text(input.name, 80);
  const phone = input.phone?.trim() ? normaliseGhanaPhone(input.phone) : null;
  const email = input.email?.trim() ? normaliseEmail(input.email) : null;
  const days = (n: number) => Number.isInteger(n) && n >= 0 && n <= 365;
  if (!name || (input.phone?.trim() && !phone) || (input.email?.trim() && !email) || !days(input.paymentTermsDays) || !days(input.leadTimeDays)) return fail('invalid_input');
  const values = { name, phone, email, paymentTermsDays: input.paymentTermsDays, leadTimeDays: input.leadTimeDays, note: text(input.note, 300) || null };
  return withTenant(db, ctx.tenantId, async (tx) => {
    const [clash] = await tx.select({ id: suppliers.id }).from(suppliers).where(sql`lower(${suppliers.name}) = lower(${name})`);
    if (clash && clash.id !== input.id) return fail('duplicate_name');
    let id = input.id;
    if (id) {
      if (!isUuid(id)) return fail('not_found');
      const [u] = await tx.update(suppliers).set(values).where(eq(suppliers.id, id)).returning({ id: suppliers.id });
      if (!u) return fail('not_found');
    } else {
      [{ id }] = await tx.insert(suppliers).values({ tenantId: ctx.tenantId, ...values }).returning({ id: suppliers.id });
    }
    await audit(tx, ctx, 'supplier_saved', 'supplier', id!, values);
    return { ok: true as const, supplierId: id! };
  });
}

export type SupplierRow = { id: string; name: string; phone: string | null; email: string | null; paymentTermsDays: number; leadTimeDays: number; owedPesewas: number; creditPesewas: number };

export async function listSuppliers(db: Db, ctx: Ctx): Promise<SupplierRow[]> {
  can(ctx);
  return withTenant(db, ctx.tenantId, async (tx) => {
    const rows = await tx.select().from(suppliers).orderBy(asc(suppliers.name));
    const owed = await tx.select({ id: supplierBills.supplierId, n: sql<number>`sum(${supplierBills.amountPesewas} - ${supplierBills.paidPesewas})::int` }).from(supplierBills).groupBy(supplierBills.supplierId);
    const credit = await tx.select({ id: supplierReturns.supplierId, n: sql<number>`sum(${supplierReturns.creditPesewas} - ${supplierReturns.creditUsedPesewas})::int` }).from(supplierReturns).groupBy(supplierReturns.supplierId);
    return rows.map((s) => ({
      id: s.id, name: s.name, phone: s.phone, email: s.email, paymentTermsDays: s.paymentTermsDays, leadTimeDays: s.leadTimeDays,
      owedPesewas: owed.find((o) => o.id === s.id)?.n ?? 0, creditPesewas: credit.find((c) => c.id === s.id)?.n ?? 0,
    }));
  });
}

/** Spec 4.19: what a supplier sells, in which pack, at what last cost; the main supplier gets suggested orders. */
export async function setSupplierItem(db: Db, ctx: Ctx, input: { supplierId: string; variantId: string; unitId: string; lastCostPesewas?: number; isMain: boolean }): Promise<{ ok: true } | Fail<'invalid_input' | 'not_found'>> {
  can(ctx);
  if (![input.supplierId, input.variantId, input.unitId].every(isUuid) || (input.lastCostPesewas !== undefined && (!Number.isInteger(input.lastCostPesewas) || input.lastCostPesewas < 0))) return fail('invalid_input');
  return withTenant(db, ctx.tenantId, async (tx) => {
    const [unit] = await tx.select({ factor: variantUnits.factor }).from(variantUnits).where(and(eq(variantUnits.id, input.unitId), eq(variantUnits.variantId, input.variantId), eq(variantUnits.purchasable, true)));
    const [sup] = await tx.select({ id: suppliers.id }).from(suppliers).where(eq(suppliers.id, input.supplierId));
    if (!unit || !sup) return fail('not_found');
    if (input.isMain) await tx.update(supplierItems).set({ isMain: false }).where(eq(supplierItems.variantId, input.variantId));
    await tx.insert(supplierItems).values({ tenantId: ctx.tenantId, supplierId: input.supplierId, variantId: input.variantId, unitId: input.unitId, packFactor: unit.factor, lastCostPesewas: input.lastCostPesewas ?? null, isMain: input.isMain })
      .onConflictDoUpdate({ target: [supplierItems.tenantId, supplierItems.supplierId, supplierItems.variantId], set: { unitId: input.unitId, packFactor: unit.factor, isMain: input.isMain, ...(input.lastCostPesewas !== undefined ? { lastCostPesewas: input.lastCostPesewas } : {}) } });
    return { ok: true as const };
  });
}

// ---- Purchase orders -------------------------------------------------------

export type PoLineInput = { variantId: string; unitId: string; quantity: string; unitCostPesewas: number };

async function insertLines(tx: Tx, ctx: Ctx, poId: string, lines: PoLineInput[]): Promise<void> {
  for (const [i, l] of lines.entries()) {
    if (!isUuid(l.variantId) || !isUuid(l.unitId) || !Number.isInteger(l.unitCostPesewas) || l.unitCostPesewas < 0) throw new Stop('invalid_line', String(i));
    const q = parseQuantity(l.quantity);
    if (!q || toMilli(q) <= 0n) throw new Stop('invalid_line', String(i));
    const [u] = await tx.select({ factor: variantUnits.factor, kind: variants.kind }).from(variantUnits).innerJoin(variants, eq(variants.id, variantUnits.variantId))
      .where(and(eq(variantUnits.id, l.unitId), eq(variantUnits.variantId, l.variantId), eq(variantUnits.purchasable, true)));
    if (!u || u.kind !== 'standard') throw new Stop('invalid_line', String(i));
    await tx.insert(purchaseOrderLines).values({ tenantId: ctx.tenantId, purchaseOrderId: poId, variantId: l.variantId, unitId: l.unitId, factor: u.factor, quantity: q, unitCostPesewas: l.unitCostPesewas });
  }
}

export async function createPurchaseOrder(db: Db, ctx: Ctx, input: { branchId: string; supplierId: string; lines: PoLineInput[]; note?: string }): Promise<
  { ok: true; purchaseOrderId: string; number: string } | Fail<'invalid_input' | 'not_found' | 'invalid_line'>
> {
  can(ctx);
  if (!isUuid(input.branchId) || !isUuid(input.supplierId) || !Array.isArray(input.lines) || input.lines.length === 0 || input.lines.length > 100) return fail('invalid_input');
  return stopping(() => withTenant(db, ctx.tenantId, async (tx) => {
    const [b] = await tx.select({ id: branches.id }).from(branches).where(eq(branches.id, input.branchId));
    const [s] = await tx.select({ id: suppliers.id }).from(suppliers).where(eq(suppliers.id, input.supplierId));
    if (!b || !s) return fail('not_found');
    const number = await nextNumber(tx, ctx);
    const [po] = await tx.insert(purchaseOrders).values({ tenantId: ctx.tenantId, number, branchId: input.branchId, supplierId: input.supplierId, note: text(input.note, 300) || null, createdBy: ctx.userId }).returning({ id: purchaseOrders.id });
    await insertLines(tx, ctx, po.id, input.lines);
    await audit(tx, ctx, 'purchase_order_created', 'purchase_order', po.id, { number, lines: input.lines.length });
    return { ok: true as const, purchaseOrderId: po.id, number };
  }));
}

export type PurchaseOrderDetail = {
  id: string; shopName: string; number: string; status: string; suggested: boolean; branchId: string; branchName: string; supplierId: string; supplierName: string; supplierPhone: string | null; supplierEmail: string | null; note: string | null; createdAt: Date;
  lines: Array<{ id: string; variantId: string; unitId: string; name: string; unitName: string; quantity: string; receivedQuantity: string; unitCostPesewas: number; tracking: string }>;
};

export async function getPurchaseOrder(db: Db, ctx: Ctx, id: string): Promise<PurchaseOrderDetail | null> {
  can(ctx);
  if (!isUuid(id)) return null;
  return withTenant(db, ctx.tenantId, async (tx) => {
    const [po] = await tx.select({ po: purchaseOrders, branchName: branches.name, s: suppliers }).from(purchaseOrders)
      .innerJoin(branches, eq(branches.id, purchaseOrders.branchId)).innerJoin(suppliers, eq(suppliers.id, purchaseOrders.supplierId)).where(eq(purchaseOrders.id, id));
    if (!po) return null;
    const [shop] = await tx.select({ name: tenants.name }).from(tenants).where(eq(tenants.id, ctx.tenantId));
    const lines = await tx.select({ l: purchaseOrderLines, p: products.name, v: variants.name, unitName: variantUnits.name, tracking: products.tracking }).from(purchaseOrderLines)
      .innerJoin(variants, eq(variants.id, purchaseOrderLines.variantId)).innerJoin(products, eq(products.id, variants.productId)).innerJoin(variantUnits, eq(variantUnits.id, purchaseOrderLines.unitId))
      .where(eq(purchaseOrderLines.purchaseOrderId, id)).orderBy(asc(products.name));
    return {
      id: po.po.id, shopName: shop.name, number: po.po.number, status: po.po.status, suggested: po.po.suggested, branchId: po.po.branchId, branchName: po.branchName, supplierId: po.s.id, supplierName: po.s.name,
      supplierPhone: po.s.phone, supplierEmail: po.s.email, note: po.po.note, createdAt: po.po.createdAt,
      lines: lines.map((x) => ({ id: x.l.id, variantId: x.l.variantId, unitId: x.l.unitId, name: itemLabel(x.p, x.v), unitName: x.unitName, quantity: x.l.quantity, receivedQuantity: x.l.receivedQuantity, unitCostPesewas: x.l.unitCostPesewas, tracking: x.tracking })),
    };
  });
}

export async function listPurchaseOrders(db: Db, ctx: Ctx) {
  can(ctx);
  return withTenant(db, ctx.tenantId, (tx) => tx.select({ id: purchaseOrders.id, number: purchaseOrders.number, status: purchaseOrders.status, suggested: purchaseOrders.suggested, supplierName: suppliers.name, createdAt: purchaseOrders.createdAt })
    .from(purchaseOrders).innerJoin(suppliers, eq(suppliers.id, purchaseOrders.supplierId)).orderBy(desc(purchaseOrders.createdAt)).limit(50));
}

/** The order as text for WhatsApp or email. */
export function purchaseOrderMessage(po: PurchaseOrderDetail): string {
  return [`${po.shopName}: purchase order ${po.number}`, `Deliver to ${po.branchName}`, ...po.lines.map((l) => `- ${Number(l.quantity)} ${l.unitName} ${l.name}`), po.note ?? ''].filter(Boolean).join('\n');
}

/** Spec 4.19: a reviewed draft is marked sent (the page then opens WhatsApp or email with the text). */
export async function markPurchaseOrderSent(db: Db, ctx: Ctx, id: string, now: Date): Promise<{ ok: true } | Fail<'not_found' | 'not_draft'>> {
  can(ctx);
  if (!isUuid(id)) return fail('not_found');
  return withTenant(db, ctx.tenantId, async (tx) => {
    const [po] = await tx.select({ status: purchaseOrders.status }).from(purchaseOrders).where(eq(purchaseOrders.id, id)).for('update');
    if (!po) return fail('not_found');
    if (po.status !== 'draft') return fail('not_draft');
    await tx.update(purchaseOrders).set({ status: 'sent', sentAt: now }).where(eq(purchaseOrders.id, id));
    await audit(tx, ctx, 'purchase_order_sent', 'purchase_order', id);
    return { ok: true as const };
  });
}

export async function closePurchaseOrder(db: Db, ctx: Ctx, id: string): Promise<{ ok: true } | Fail<'not_found'>> {
  can(ctx);
  if (!isUuid(id)) return fail('not_found');
  return withTenant(db, ctx.tenantId, async (tx) => {
    const [po] = await tx.update(purchaseOrders).set({ status: 'closed' }).where(and(eq(purchaseOrders.id, id), ne(purchaseOrders.status, 'closed'))).returning({ id: purchaseOrders.id });
    if (!po) return fail('not_found');
    await audit(tx, ctx, 'purchase_order_closed', 'purchase_order', id);
    return { ok: true as const };
  });
}

export type ReceivePoLine = { lineId: string; quantity: string; totalCostPesewas: number; batchNumber?: string; expiryDate?: string; serials?: string[] };

/** Spec 6.23: receive all or part of an order; stock, average cost, and last cost update; an unpaid delivery becomes a supplier bill. */
export async function receivePurchaseOrder(db: Db, ctx: Ctx, input: { purchaseOrderId: string; lines: ReceivePoLine[]; paidNow: boolean; billReference?: string }, now: Date): Promise<
  { ok: true; receiptId: string; status: string; billId: string | null } | Fail<ReceiveError | 'not_found' | 'not_open' | 'over_received'>
> {
  can(ctx);
  assertPermission(ctx, 'receive_stock');
  if (!isUuid(input.purchaseOrderId) || !Array.isArray(input.lines)) return fail('invalid_input');
  const lines = input.lines.filter((l) => parseQuantity(l.quantity) && toMilli(parseQuantity(l.quantity)!) > 0n);
  if (!lines.length) return fail('invalid_input');
  return withTenant(db, ctx.tenantId, async (tx) => {
    const [po] = await tx.select({ po: purchaseOrders, s: suppliers }).from(purchaseOrders).innerJoin(suppliers, eq(suppliers.id, purchaseOrders.supplierId)).where(eq(purchaseOrders.id, input.purchaseOrderId)).for('update');
    if (!po) return fail('not_found');
    if (po.po.status !== 'sent' && po.po.status !== 'partly_received') return fail('not_open');
    const poLines = await tx.select().from(purchaseOrderLines).where(eq(purchaseOrderLines.purchaseOrderId, po.po.id));
    const receiveLines = [];
    for (const l of lines) {
      const pl = poLines.find((x) => x.id === l.lineId);
      if (!pl) return fail('invalid_input');
      if (toMilli(pl.receivedQuantity) + toMilli(parseQuantity(l.quantity)!) > toMilli(pl.quantity)) return fail('over_received');
      receiveLines.push({ variantId: pl.variantId, unitId: pl.unitId, quantity: l.quantity, totalCostPesewas: l.totalCostPesewas, batchNumber: l.batchNumber, expiryDate: l.expiryDate, serials: l.serials });
    }
    // receiveStockTx checks every line before writing, so a refusal here leaves nothing behind
    const r = await receiveStockTx(tx, ctx, { branchId: po.po.branchId, kind: 'received', supplierName: po.s.name, supplierId: po.s.id, purchaseOrderId: po.po.id, lines: receiveLines }, todayIn(ctx.timezone, now));
    if (!r.ok) return r;
    for (const l of lines) {
      const pl = poLines.find((x) => x.id === l.lineId)!;
      pl.receivedQuantity = fromMilli(toMilli(pl.receivedQuantity) + toMilli(parseQuantity(l.quantity)!));
      await tx.update(purchaseOrderLines).set({ receivedQuantity: pl.receivedQuantity }).where(eq(purchaseOrderLines.id, pl.id));
      const perUnit = Math.round(l.totalCostPesewas / Number(l.quantity));
      await tx.update(supplierItems).set({ lastCostPesewas: perUnit }).where(and(eq(supplierItems.supplierId, po.s.id), eq(supplierItems.variantId, pl.variantId), eq(supplierItems.unitId, pl.unitId)));
    }
    const status = poLines.every((x) => toMilli(x.receivedQuantity) >= toMilli(x.quantity)) ? 'received' : 'partly_received';
    await tx.update(purchaseOrders).set({ status }).where(eq(purchaseOrders.id, po.po.id));
    const total = lines.reduce((s, l) => s + l.totalCostPesewas, 0);
    let billId: string | null = null;
    if (!input.paidNow && total > 0) {
      [{ id: billId }] = await tx.insert(supplierBills).values({
        tenantId: ctx.tenantId, supplierId: po.s.id, receiptId: r.receiptId, reference: text(input.billReference, 60) || null, amountPesewas: total, dueDate: addDays(todayIn(ctx.timezone, now), po.s.paymentTermsDays), createdBy: ctx.userId,
      }).returning({ id: supplierBills.id });
    }
    await audit(tx, ctx, 'purchase_order_received', 'purchase_order', po.po.id, { receiptId: r.receiptId, status, totalPesewas: total, billId });
    return { ok: true as const, receiptId: r.receiptId, status, billId };
  });
}

/** Spec 6.24: drafts from reorder levels and the last 28 days' sales, rounded up to whole packs, one per main supplier. Earlier unsent suggestions are replaced. */
export async function suggestPurchaseOrders(db: Db, ctx: Ctx, branchId: string, now: Date): Promise<
  { ok: true; created: Array<{ purchaseOrderId: string; number: string; supplierName: string; lines: number }>; noSupplier: string[] } | Fail<'not_found'>
> {
  can(ctx);
  if (!isUuid(branchId)) return fail('not_found');
  return withTenant(db, ctx.tenantId, async (tx) => {
    const [t] = await tx.select({ cover: tenants.reorderCoverDays }).from(tenants).where(eq(tenants.id, ctx.tenantId));
    const [b] = await tx.select({ id: branches.id }).from(branches).where(eq(branches.id, branchId));
    if (!b) return fail('not_found');
    const old = await tx.select({ id: purchaseOrders.id }).from(purchaseOrders).where(and(eq(purchaseOrders.branchId, branchId), eq(purchaseOrders.suggested, true), eq(purchaseOrders.status, 'draft')));
    if (old.length) await tx.delete(purchaseOrders).where(inArray(purchaseOrders.id, old.map((o) => o.id)));
    const since = new Date(now.getTime() - 28 * 86_400_000);
    const sold = await tx.select({ variantId: stockMovements.variantId, qty: sql<string>`(0 - sum(${stockMovements.quantity}))::text` }).from(stockMovements)
      .where(and(eq(stockMovements.branchId, branchId), eq(stockMovements.type, 'sale'), gte(stockMovements.createdAt, since))).groupBy(stockMovements.variantId);
    const items = await tx.select({ v: variants, p: products.name, onHand: stockBalances.onHand }).from(variants).innerJoin(products, eq(products.id, variants.productId))
      .leftJoin(stockBalances, and(eq(stockBalances.variantId, variants.id), eq(stockBalances.branchId, branchId)))
      .where(and(eq(variants.kind, 'standard'), eq(variants.status, 'active')));
    const open = await tx.select({ variantId: purchaseOrderLines.variantId, qty: sql<string>`sum((${purchaseOrderLines.quantity} - ${purchaseOrderLines.receivedQuantity}) * ${purchaseOrderLines.factor})::text` })
      .from(purchaseOrderLines).innerJoin(purchaseOrders, eq(purchaseOrders.id, purchaseOrderLines.purchaseOrderId))
      .where(and(eq(purchaseOrders.branchId, branchId), inArray(purchaseOrders.status, ['draft', 'sent', 'partly_received']))).groupBy(purchaseOrderLines.variantId);
    const mains = await tx.select({ si: supplierItems, s: suppliers }).from(supplierItems).innerJoin(suppliers, eq(suppliers.id, supplierItems.supplierId)).where(eq(supplierItems.isMain, true));
    const bySupplier = new Map<string, { name: string; lines: PoLineInput[] }>();
    const noSupplier: string[] = [];
    for (const it of items) {
      const daily = Number(sold.find((s) => s.variantId === it.v.id)?.qty ?? 0) / 28;
      if (!it.v.reorderLevel && daily <= 0) continue;
      const main = mains.find((m) => m.si.variantId === it.v.id);
      const target = Math.max(Number(it.v.reorderLevel ?? 0), daily * ((main?.s.leadTimeDays ?? 7) + t.cover));
      const need = target - (Number(it.onHand ?? 0) + Number(open.find((o) => o.variantId === it.v.id)?.qty ?? 0));
      if (need <= 0) continue;
      if (!main) { noSupplier.push(itemLabel(it.p, it.v.name)); continue; }
      const entry = bySupplier.get(main.s.id) ?? { name: main.s.name, lines: [] };
      entry.lines.push({ variantId: it.v.id, unitId: main.si.unitId, quantity: String(Math.ceil(need / Number(main.si.packFactor))), unitCostPesewas: main.si.lastCostPesewas ?? 0 });
      bySupplier.set(main.s.id, entry);
    }
    const created = [];
    for (const [supplierId, e] of bySupplier) {
      const number = await nextNumber(tx, ctx);
      const [po] = await tx.insert(purchaseOrders).values({ tenantId: ctx.tenantId, number, branchId, supplierId, suggested: true, createdBy: ctx.userId }).returning({ id: purchaseOrders.id });
      await insertLines(tx, ctx, po.id, e.lines);
      created.push({ purchaseOrderId: po.id, number, supplierName: e.name, lines: e.lines.length });
    }
    return { ok: true as const, created, noSupplier };
  });
}

// ---- Bills, payments, and supplier returns ----------------------------------

export async function listBills(db: Db, ctx: Ctx, now: Date) {
  can(ctx);
  const today = todayIn(ctx.timezone, now);
  return withTenant(db, ctx.tenantId, async (tx) => (await tx.select({ b: supplierBills, supplierName: suppliers.name }).from(supplierBills)
    .innerJoin(suppliers, eq(suppliers.id, supplierBills.supplierId)).orderBy(asc(supplierBills.dueDate)).limit(200))
    .map(({ b, supplierName }) => ({ ...b, supplierName, owedPesewas: b.amountPesewas - b.paidPesewas, status: b.paidPesewas >= b.amountPesewas ? 'paid' : b.dueDate < today ? 'overdue' : 'due' })));
}

export type SupplierPayMethod = 'cash' | 'momo_manual' | 'bank_transfer' | 'cheque' | 'credit';

/** Records what was paid on a bill; method 'credit' uses credit from supplier returns, oldest first. */
export async function payBill(db: Db, ctx: Ctx, input: { billId: string; amountPesewas: number; method: SupplierPayMethod; reference?: string }): Promise<
  { ok: true; owedPesewas: number } | Fail<'invalid_input' | 'not_found' | 'too_much' | 'not_enough_credit' | 'reference_required'>
> {
  can(ctx);
  if (!isUuid(input.billId) || !Number.isInteger(input.amountPesewas) || input.amountPesewas <= 0 || !['cash', 'momo_manual', 'bank_transfer', 'cheque', 'credit'].includes(input.method)) return fail('invalid_input');
  const reference = text(input.reference, 100) || null;
  if (['momo_manual', 'bank_transfer', 'cheque'].includes(input.method) && !reference) return fail('reference_required');
  return withTenant(db, ctx.tenantId, async (tx) => {
    const [bill] = await tx.select().from(supplierBills).where(eq(supplierBills.id, input.billId)).for('update');
    if (!bill) return fail('not_found');
    if (bill.paidPesewas + input.amountPesewas > bill.amountPesewas) return fail('too_much');
    if (input.method === 'credit') {
      const credits = await tx.select().from(supplierReturns).where(and(eq(supplierReturns.supplierId, bill.supplierId), sql`${supplierReturns.creditPesewas} > ${supplierReturns.creditUsedPesewas}`))
        .orderBy(asc(supplierReturns.createdAt)).for('update');
      let left = input.amountPesewas;
      if (credits.reduce((s, c) => s + c.creditPesewas - c.creditUsedPesewas, 0) < left) return fail('not_enough_credit');
      for (const c of credits) {
        if (left === 0) break;
        const use = Math.min(left, c.creditPesewas - c.creditUsedPesewas);
        await tx.update(supplierReturns).set({ creditUsedPesewas: c.creditUsedPesewas + use }).where(eq(supplierReturns.id, c.id));
        left -= use;
      }
    }
    await tx.insert(supplierPayments).values({ tenantId: ctx.tenantId, supplierId: bill.supplierId, billId: bill.id, amountPesewas: input.amountPesewas, method: input.method, reference, createdBy: ctx.userId });
    await tx.update(supplierBills).set({ paidPesewas: bill.paidPesewas + input.amountPesewas }).where(eq(supplierBills.id, bill.id));
    await audit(tx, ctx, 'supplier_bill_paid', 'supplier_bill', bill.id, { amountPesewas: input.amountPesewas, method: input.method });
    return { ok: true as const, owedPesewas: bill.amountPesewas - bill.paidPesewas - input.amountPesewas };
  });
}

/** Spec 6.24: goods go back to the supplier; stock goes down and a credit is recorded (at average cost unless given). */
export async function returnToSupplier(db: Db, ctx: Ctx, input: { branchId: string; supplierId: string; reason: string; lines: MoveLine[]; creditPesewas?: number }): Promise<
  { ok: true; returnId: string; creditPesewas: number } | Fail<'invalid_input' | 'not_found' | 'reason_required' | 'not_enough_stock' | 'unknown_batch' | LineError>
> {
  can(ctx);
  const reason = text(input.reason, 200);
  if (!reason) return fail('reason_required');
  if (!isUuid(input.branchId) || !isUuid(input.supplierId) || !Array.isArray(input.lines) || !input.lines.length || input.lines.length > 100
    || (input.creditPesewas !== undefined && (!Number.isInteger(input.creditPesewas) || input.creditPesewas < 0))) return fail('invalid_input');
  return stopping(() => withTenant(db, ctx.tenantId, async (tx) => {
    const [s] = await tx.select({ id: suppliers.id }).from(suppliers).where(eq(suppliers.id, input.supplierId));
    const [b] = await tx.select({ id: branches.id }).from(branches).where(eq(branches.id, input.branchId));
    if (!s || !b) return fail('not_found');
    const [ret] = await tx.insert(supplierReturns).values({ tenantId: ctx.tenantId, branchId: input.branchId, supplierId: input.supplierId, reason, creditPesewas: 0, createdBy: ctx.userId }).returning({ id: supplierReturns.id });
    let value = 0;
    for (const [i, l] of input.lines.entries()) {
      const r = await resolveLine(tx, l);
      if (typeof r === 'string') throw new Stop(r, String(i));
      const took = await takeStock(tx, ctx, input.branchId, r, { type: 'supplier_return', referenceType: 'supplier_return', referenceId: ret.id }, true);
      if (!took.ok) throw new Stop(took.error, String(i));
      value += valueOf(r.baseQty, r.averageCost);
    }
    const credit = input.creditPesewas ?? value;
    await tx.update(supplierReturns).set({ creditPesewas: credit }).where(eq(supplierReturns.id, ret.id));
    await audit(tx, ctx, 'supplier_return', 'supplier_return', ret.id, { supplierId: input.supplierId, lines: input.lines.length, creditPesewas: credit });
    return { ok: true as const, returnId: ret.id, creditPesewas: credit };
  }));
}

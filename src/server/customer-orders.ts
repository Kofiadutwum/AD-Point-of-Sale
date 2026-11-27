import 'server-only';
import { and, desc, eq, inArray, sql } from 'drizzle-orm';
import type { Db, Tx } from '@/db/client';
import { customerOrders, customers, type OrderLine, orderPayments, products, registers, stockBalances, tenants, variants, variantUnits } from '@/db/schema';
import { withTenant } from '@/db/tenant';
import { multiplyQty } from '@/lib/decimal';
import { consumeApproval } from './approvals';
import { writeAudit } from './audit';
import { assertPermission, type Ctx } from './context';
import { creditStoreCredit } from './customers';
import { queue } from './notifications';
import { type Fail, fail, isUuid } from './products';
import { priceCart, tillSale } from './quotes';
import { completeSaleTx, throwSaleFailure } from './sales';
import { openShiftId } from './shift-link';

type PayMethod = 'cash' | 'momo_manual' | 'card_terminal' | 'bank_transfer';
const METHODS: readonly PayMethod[] = ['cash', 'momo_manual', 'card_terminal', 'bank_transfer'];
const audit = (tx: Tx, ctx: Ctx, action: string, id: string, changes?: Record<string, unknown>) =>
  writeAudit(tx, { tenantId: ctx.tenantId, actorType: 'user', actorId: ctx.userId, action, recordType: 'customer_order', recordId: id, changes });

async function registerBranch(tx: Tx, ctx: Ctx): Promise<string | null> {
  if (!ctx.registerId) return null;
  const [r] = await tx.select({ branchId: registers.branchId }).from(registers).where(eq(registers.id, ctx.registerId));
  return r?.branchId ?? null;
}

const changeReserved = (tx: Tx, ctx: Ctx, branchId: string, lines: OrderLine[], sign: 1 | -1) => reserveStock(tx, ctx.tenantId, branchId, lines, sign);

/** Holds (+1) or releases (−1) stock for an order: available = on hand − reserved. Also used by online orders (6.49). */
export async function reserveStock(tx: Tx, tenantId: string, branchId: string, lines: OrderLine[], sign: 1 | -1) {
  if (!lines.length) return;
  const counted = new Set((await tx.select({ id: variants.id }).from(variants).innerJoin(products, eq(products.id, variants.productId))
    .where(and(inArray(variants.id, lines.map((l) => l.variantId)), eq(products.trackStock, true)))).map((r) => r.id));
  for (const l of lines) {
    if (!counted.has(l.variantId)) continue; // made to order: nothing to hold
    const delta = sign === 1 ? sql`${l.baseQuantity}::numeric` : sql`(0 - ${l.baseQuantity}::numeric)`;
    await tx.insert(stockBalances).values({ tenantId, branchId, variantId: l.variantId, reserved: sql`greatest(${delta}, 0)` as unknown as string })
      .onConflictDoUpdate({ target: [stockBalances.tenantId, stockBalances.branchId, stockBalances.variantId], set: { reserved: sql`greatest(${stockBalances.reserved} + ${delta}, 0)` } });
  }
}

async function addPayment(tx: Tx, ctx: Ctx, orderId: string, p: { method: string; amountPesewas: number; reference?: string | null }) {
  const shiftId = p.method === 'cash' && ctx.registerId ? await openShiftId(tx, ctx.registerId) : null;
  await tx.insert(orderPayments).values({ tenantId: ctx.tenantId, orderId, method: p.method, amountPesewas: p.amountPesewas, reference: p.reference ?? null, shiftId, createdBy: ctx.userId });
}

export type OrderError = 'invalid_input' | 'no_register' | 'unknown_customer' | 'unknown_item' | 'deposit_too_small' | 'reference_required';

/** Spec 6.34: layaway reserves the items (deposit at least the shop's minimum); a special order is for items still to come. */
export async function createOrder(db: Db, ctx: Ctx, input: {
  kind: 'layaway' | 'special'; customerId: string; lines: Array<{ variantId: string; unitId: string; quantity: string }>; deposit: { method: PayMethod; amountPesewas: number; reference?: string };
  dueDate?: string; note?: string;
}, now: Date): Promise<{ ok: true; orderId: string; number: string; totalPesewas: number } | Fail<OrderError>> {
  assertPermission(ctx, 'layaway');
  if (!['layaway', 'special'].includes(input.kind) || !isUuid(input.customerId) || !Array.isArray(input.lines) || !input.lines.length || input.lines.length > 50
    || !METHODS.includes(input.deposit?.method) || !Number.isInteger(input.deposit?.amountPesewas) || input.deposit.amountPesewas < 0
    || (input.dueDate && !/^\d{4}-\d{2}-\d{2}$/.test(input.dueDate))) return fail('invalid_input');
  if (input.deposit.method !== 'cash' && input.deposit.amountPesewas > 0 && !input.deposit.reference?.trim()) return fail('reference_required');
  return withTenant(db, ctx.tenantId, async (tx) => {
    const branchId = await registerBranch(tx, ctx);
    if (!branchId) return fail('no_register');
    const [c] = await tx.select({ id: customers.id }).from(customers).where(eq(customers.id, input.customerId));
    if (!c) return fail('unknown_customer');
    const priced = await priceCart(tx, ctx, branchId, c.id, input.lines.map((l) => ({ ...l, discountPesewas: 0 })), now);
    if (!priced) return fail('unknown_item');
    const lines: OrderLine[] = [];
    for (const l of priced.lines) {
      const [u] = await tx.select({ factor: variantUnits.factor }).from(variantUnits).where(eq(variantUnits.id, l.unitId));
      lines.push({ variantId: l.variantId, unitId: l.unitId, name: l.name, unitName: l.unitName, quantity: l.quantity, baseQuantity: multiplyQty(l.quantity, u.factor), unitPricePesewas: l.unitPricePesewas, totalPesewas: l.totalPesewas });
    }
    const [t] = await tx.select({ minPct: tenants.layawayMinDepositPercent }).from(tenants).where(eq(tenants.id, ctx.tenantId)).for('update');
    if (input.kind === 'layaway' && input.deposit.amountPesewas * 100 < priced.totalPesewas * t.minPct) return fail('deposit_too_small');
    if (input.deposit.amountPesewas > priced.totalPesewas) return fail('invalid_input');
    const prefix = input.kind === 'layaway' ? 'LA' : 'SO';
    const [{ n }] = await tx.select({ n: sql<number>`count(*)::int` }).from(customerOrders).where(eq(customerOrders.kind, input.kind));
    const number = `${prefix}-${String(n + 1).padStart(4, '0')}`;
    const [o] = await tx.insert(customerOrders).values({
      tenantId: ctx.tenantId, branchId, number, kind: input.kind, customerId: c.id, lines, totalPesewas: priced.totalPesewas, paidPesewas: input.deposit.amountPesewas,
      dueDate: input.dueDate || null, note: input.note?.trim().slice(0, 300) || null, createdBy: ctx.userId,
      status: input.kind === 'layaway' && input.deposit.amountPesewas >= priced.totalPesewas ? 'ready' : 'open',
    }).returning({ id: customerOrders.id });
    if (input.deposit.amountPesewas > 0) await addPayment(tx, ctx, o.id, { ...input.deposit, reference: input.deposit.reference?.trim() || null });
    if (input.kind === 'layaway') await changeReserved(tx, ctx, branchId, lines, 1);
    await audit(tx, ctx, 'customer_order_created', o.id, { number, kind: input.kind, totalPesewas: priced.totalPesewas, depositPesewas: input.deposit.amountPesewas });
    return { ok: true as const, orderId: o.id, number, totalPesewas: priced.totalPesewas };
  });
}

/** A part payment; a layaway paid in full is ready to collect and the customer is told. */
export async function payOrder(db: Db, ctx: Ctx, input: { orderId: string; method: PayMethod; amountPesewas: number; reference?: string }, now: Date): Promise<
  { ok: true; paidPesewas: number; status: string } | Fail<'invalid_input' | 'not_found' | 'not_open' | 'too_much' | 'reference_required'>
> {
  assertPermission(ctx, 'layaway');
  if (!isUuid(input.orderId) || !METHODS.includes(input.method) || !Number.isInteger(input.amountPesewas) || input.amountPesewas <= 0) return fail('invalid_input');
  if (input.method !== 'cash' && !input.reference?.trim()) return fail('reference_required');
  return withTenant(db, ctx.tenantId, async (tx) => {
    const [o] = await tx.select().from(customerOrders).where(eq(customerOrders.id, input.orderId)).for('update');
    if (!o) return fail('not_found');
    if (o.status !== 'open' && o.status !== 'ready') return fail('not_open');
    if (o.paidPesewas + input.amountPesewas > o.totalPesewas) return fail('too_much');
    await addPayment(tx, ctx, o.id, { method: input.method, amountPesewas: input.amountPesewas, reference: input.reference?.trim() || null });
    const paid = o.paidPesewas + input.amountPesewas;
    let status = o.status;
    if (o.kind === 'layaway' && paid >= o.totalPesewas && o.status === 'open') {
      status = 'ready';
      const [c] = await tx.select({ phone: customers.phone }).from(customers).where(eq(customers.id, o.customerId));
      const [shop] = await tx.select({ name: tenants.name }).from(tenants).where(eq(tenants.id, ctx.tenantId));
      if (c?.phone) await queue(tx, ctx.tenantId, { key: `order-ready:${o.id}`, kind: 'order', toPhone: c.phone, body: `${shop.name}: your layaway ${o.number} is paid in full and ready to collect.`, sendAfter: now });
    }
    await tx.update(customerOrders).set({ paidPesewas: paid, status }).where(eq(customerOrders.id, o.id));
    await audit(tx, ctx, 'customer_order_paid', o.id, { amountPesewas: input.amountPesewas, method: input.method });
    return { ok: true as const, paidPesewas: paid, status };
  });
}

/** Spec 6.34: collected when fully paid; the sale is made at the till with the order's payments as its tender. */
export async function collectOrder(db: Db, ctx: Ctx, orderId: string, now: Date): Promise<{ ok: true; saleId: string } | Fail<string>> {
  assertPermission(ctx, 'layaway');
  if (!isUuid(orderId)) return fail('not_found');
  const r = await tillSale(db, ctx, async (tx, saleId, receiptNumber) => {
    const [o] = await tx.select().from(customerOrders).where(eq(customerOrders.id, orderId)).for('update');
    if (!o || (o.status !== 'ready' && o.status !== 'open')) return throwSaleFailure({ ok: false, error: 'order_not_open' });
    if (o.paidPesewas < o.totalPesewas) return throwSaleFailure({ ok: false, error: 'payment_incomplete' });
    if (o.kind === 'layaway') await changeReserved(tx, ctx, o.branchId, o.lines, -1); // released first so the sale takes the stock it held
    const sale = await completeSaleTx(tx, ctx, {
      saleId, receiptNumber, deviceCreatedAt: now.toISOString(), customerId: o.customerId, tenders: [],
      lines: o.lines.map((l) => ({ variantId: l.variantId, unitId: l.unitId, quantity: l.quantity, unitPricePesewas: l.unitPricePesewas, discountPesewas: 0 })),
    }, now, { quotedPrices: true, depositPesewas: o.paidPesewas });
    if (!sale.ok) return throwSaleFailure(sale);
    await tx.update(customerOrders).set({ status: 'collected', saleId }).where(eq(customerOrders.id, o.id));
    await audit(tx, ctx, 'customer_order_collected', o.id, { saleId });
    return { saleId, changeDuePesewas: 0 };
  });
  return r.ok ? { ok: true, saleId: r.saleId } : r;
}

/** Spec 6.34: needs a manager; reserved items go back; payments are refunded less the shop's fee, as store credit or cash (shop setting). */
export async function cancelOrder(db: Db, ctx: Ctx, input: { orderId: string; reason: string; approvalToken?: string }, now: Date): Promise<
  { ok: true; refundPesewas: number; refundAs: string } | Fail<'invalid_input' | 'not_found' | 'not_open' | 'approval_required'>
> {
  assertPermission(ctx, 'layaway');
  const reason = typeof input.reason === 'string' ? input.reason.trim().slice(0, 200) : '';
  if (!isUuid(input.orderId) || !reason) return fail('invalid_input');
  return withTenant(db, ctx.tenantId, async (tx) => {
    const [o] = await tx.select().from(customerOrders).where(eq(customerOrders.id, input.orderId)).for('update');
    if (!o) return fail('not_found');
    if (o.status !== 'open' && o.status !== 'ready') return fail('not_open');
    let approvedBy: string | null = null;
    if (!ctx.permissions.includes('approve_actions')) {
      const a = input.approvalToken ? await consumeApproval(tx, ctx, { token: input.approvalToken, action: 'cancel_order', contextKey: o.id }, now) : null;
      if (!a) return fail('approval_required');
      approvedBy = a.approverId;
    }
    const [t] = await tx.select({ fee: tenants.orderCancellationFeePesewas, as: tenants.orderRefundAs }).from(tenants).where(eq(tenants.id, ctx.tenantId));
    const fee = Math.min(t.fee, o.paidPesewas);
    const refund = o.paidPesewas - fee;
    if (fee > 0) await addPayment(tx, ctx, o.id, { method: 'fee', amountPesewas: -fee });
    if (refund > 0) {
      await addPayment(tx, ctx, o.id, { method: t.as === 'cash' ? 'cash' : 'store_credit', amountPesewas: -refund });
      if (t.as !== 'cash') await creditStoreCredit(tx, { tenantId: ctx.tenantId, customerId: o.customerId, amountPesewas: refund, source: 'refund', userId: ctx.userId, reason: `Cancelled ${o.number}` });
    }
    if (o.kind === 'layaway') await changeReserved(tx, ctx, o.branchId, o.lines, -1);
    await tx.update(customerOrders).set({ status: 'cancelled', paidPesewas: 0 }).where(eq(customerOrders.id, o.id));
    await audit(tx, ctx, 'customer_order_cancelled', o.id, { reason, refundPesewas: refund, feePesewas: fee, refundAs: t.as, approvedBy });
    return { ok: true as const, refundPesewas: refund, refundAs: t.as };
  });
}

export async function listOrders(db: Db, ctx: Ctx) {
  assertPermission(ctx, 'layaway');
  return withTenant(db, ctx.tenantId, (tx) => tx.select({ o: customerOrders, customerName: customers.name, phone: customers.phone }).from(customerOrders)
    .innerJoin(customers, eq(customers.id, customerOrders.customerId)).orderBy(desc(customerOrders.createdAt)).limit(100));
}

export async function getOrder(db: Db, ctx: Ctx, id: string) {
  assertPermission(ctx, 'layaway');
  if (!isUuid(id)) return null;
  return withTenant(db, ctx.tenantId, async (tx) => {
    const [row] = await tx.select({ o: customerOrders, customerName: customers.name, phone: customers.phone }).from(customerOrders)
      .innerJoin(customers, eq(customers.id, customerOrders.customerId)).where(eq(customerOrders.id, id));
    if (!row) return null;
    const pays = await tx.select().from(orderPayments).where(eq(orderPayments.orderId, id)).orderBy(orderPayments.createdAt);
    return { ...row.o, customerName: row.customerName, phone: row.phone, payments: pays };
  });
}

/** Spec 4.21: deposits and part payments on open orders are money held for customers, not sales. */
export async function moneyHeldOnOrders(db: Db, ctx: Ctx): Promise<number> {
  assertPermission(ctx, 'view_reports');
  const [r] = await withTenant(db, ctx.tenantId, (tx) => tx.select({ n: sql<number>`coalesce(sum(${customerOrders.paidPesewas}), 0)::int` }).from(customerOrders)
    .where(sql`${customerOrders.status} in ('open', 'ready')`));
  return r.n;
}

import 'server-only';
import { randomUUID } from 'node:crypto';
import { and, asc, count, eq, gt, inArray } from 'drizzle-orm';
import { z } from 'zod';
import type { Db, Tx } from '@/db/client';
import { branches, counterOrders, products, registers, sales, tenants, users, variants } from '@/db/schema';
import { withTenant } from '@/db/tenant';
import { formatReceiptNumber } from '@/device/sale';
import { businessDate } from '@/lib/dates';
import { writeAudit } from './audit';
import { assertPermission, type Ctx } from './context';
import { type Fail, fail, isUuid, itemLabel } from './products';
import { checkOrderLine, completeSaleTx, type SaleError, type SaleInput, saleFailure, throwSaleFailure } from './sales';

const sendSchema = z.object({ lines: z.array(z.object({ variantId: z.uuid(), unitId: z.uuid(), quantity: z.string() })).min(1).max(100) });
const myBranches = async (tx: Tx, ctx: Ctx) => (await tx.select({ branchIds: users.branchIds }).from(users).where(eq(users.id, ctx.userId)))[0]?.branchIds ?? [];

/** The till's branch, or the user's only branch. */
async function hereBranch(tx: Tx, ctx: Ctx): Promise<string | null> {
  if (ctx.registerId) return (await tx.select({ branchId: registers.branchId }).from(registers).where(eq(registers.id, ctx.registerId)))[0]?.branchId ?? null;
  const mine = await myBranches(tx, ctx);
  return mine.length === 1 ? mine[0] : null;
}

/** Spec 6.39: saves the cart with a short number for the cashier; nothing leaves stock until it is paid. */
export async function sendCounterOrder(db: Db, ctx: Ctx, input: { lines: Array<{ variantId: string; unitId: string; quantity: string }> }, now: Date): Promise<
  { ok: true; orderId: string; orderNumber: string } | Fail<'invalid_input' | 'no_branch' | 'unknown_item' | 'not_sellable' | 'invalid_quantity' | 'invalid_choices' | 'invalid_add_ons' | 'sold_out'>
> {
  assertPermission(ctx, 'make_sale');
  const parsed = sendSchema.safeParse(input);
  if (!parsed.success) return fail('invalid_input');
  return withTenant(db, ctx.tenantId, async (tx) => {
    const branchId = await hereBranch(tx, ctx);
    if (!branchId) return fail('no_branch');
    await tx.select({ id: branches.id }).from(branches).where(eq(branches.id, branchId)).for('update'); // one number at a time per branch
    const [shop] = await tx.select({ timezone: tenants.timezone, cutoff: tenants.businessDayCutoff, expiry: tenants.counterOrderExpiryMinutes })
      .from(tenants).where(eq(tenants.id, ctx.tenantId));
    const day = businessDate(shop.timezone, shop.cutoff, now);
    const lines = [];
    for (const l of parsed.data.lines) {
      const checked = await checkOrderLine(tx, l, branchId, day);
      if (typeof checked === 'string') return fail(checked);
      lines.push({ variantId: checked.variantId, unitId: checked.unitId, quantity: checked.quantity });
    }
    const [{ n }] = await tx.select({ n: count() }).from(counterOrders).where(and(eq(counterOrders.branchId, branchId), eq(counterOrders.businessDate, day)));
    const orderNumber = String(n + 1).padStart(4, '0');
    const [o] = await tx.insert(counterOrders).values({
      tenantId: ctx.tenantId, branchId, orderNumber, businessDate: day, lines, createdBy: ctx.userId, expiresAt: new Date(now.getTime() + shop.expiry * 60_000),
    }).returning({ id: counterOrders.id });
    await writeAudit(tx, { tenantId: ctx.tenantId, actorType: 'user', actorId: ctx.userId, action: 'counter_order_sent', recordType: 'counter_order', recordId: o.id, changes: { orderNumber } });
    return { ok: true as const, orderId: o.id, orderNumber };
  });
}

export type CounterOrderView = { orderId: string; orderNumber: string; createdAt: Date; createdBy: string; lines: Array<{ name: string; quantity: string }> };

/** Unpaid, unexpired orders at the user's branches, oldest first. */
export async function listCounterOrders(db: Db, ctx: Ctx, now: Date): Promise<CounterOrderView[]> {
  assertPermission(ctx, 'make_sale');
  return withTenant(db, ctx.tenantId, async (tx) => {
    const mine = await myBranches(tx, ctx);
    if (!mine.length) return [];
    const rows = await tx.select({ o: counterOrders, createdBy: users.name }).from(counterOrders).innerJoin(users, eq(users.id, counterOrders.createdBy))
      .where(and(eq(counterOrders.status, 'awaiting_payment'), gt(counterOrders.expiresAt, now), inArray(counterOrders.branchId, mine)))
      .orderBy(asc(counterOrders.createdAt), asc(counterOrders.orderNumber));
    const ids = [...new Set(rows.flatMap((r) => r.o.lines.map((l) => l.variantId)))];
    const names = ids.length ? await tx.select({ id: variants.id, productName: products.name, variantName: variants.name }).from(variants)
      .innerJoin(products, eq(products.id, variants.productId)).where(inArray(variants.id, ids)) : [];
    const label = (id: string) => { const v = names.find((x) => x.id === id); return v ? itemLabel(v.productName, v.variantName) : 'Item'; };
    return rows.map((r) => ({
      orderId: r.o.id, orderNumber: r.o.orderNumber, createdAt: r.o.createdAt, createdBy: r.createdBy, lines: r.o.lines.map((l) => ({ name: label(l.variantId), quantity: l.quantity })),
    }));
  });
}

type CollectError = SaleError | 'not_open' | 'expired' | 'wrong_branch';
class CollectRefused extends Error {
  constructor(readonly code: CollectError) { super(code); }
}
class Quoted extends Error {
  constructor(readonly orderNumber: string, readonly totalPesewas: number) { super('quote'); }
}

/** The total the cashier will charge, priced as the sale will be (today's prices), without saving anything. */
export async function quoteCounterOrder(db: Db, ctx: Ctx, orderId: string, now: Date): Promise<{ ok: true; orderNumber: string; totalPesewas: number } | Fail<CollectError>> {
  const r = await collect(db, ctx, orderId, [], now, true);
  return r.ok && 'totalPesewas' in r ? r : r.ok ? fail('invalid_input') : r;
}

/** Spec 6.39: the cashier takes payment for the order as it was sent (today's prices), recording who built it. */
export async function collectCounterOrder(db: Db, ctx: Ctx, input: { orderId: string; tenders: SaleInput['tenders'] }, now: Date): Promise<
  { ok: true; saleId: string; orderNumber: string; changeDuePesewas: number } | Fail<CollectError>
> {
  const r = await collect(db, ctx, input.orderId, input.tenders, now, false);
  return r.ok && 'saleId' in r ? r : r.ok ? fail('invalid_input') : r;
}

async function collect(db: Db, ctx: Ctx, orderId: string, tenders: SaleInput['tenders'], now: Date, quote: boolean) {
  assertPermission(ctx, 'make_sale');
  if (!isUuid(orderId) || !Array.isArray(tenders)) return fail<CollectError>('invalid_input');
  if (!ctx.registerId) return fail<CollectError>('no_register');
  const registerId = ctx.registerId;
  const saleId = randomUUID();
  for (let attempt = 0; ; attempt++) {
    try {
      return await withTenant(db, ctx.tenantId, async (tx) => {
        const [reg] = await tx.select({ counter: registers.receiptCounter, registerCode: registers.registerCode, branchCode: branches.branchCode, branchId: registers.branchId })
          .from(registers).innerJoin(branches, eq(branches.id, registers.branchId)).where(eq(registers.id, registerId));
        if (!reg) throw new CollectRefused('no_register');
        const [o] = await tx.select().from(counterOrders).where(eq(counterOrders.id, orderId)).for('update'); // paid once, even by two cashiers at once
        if (!o || o.status !== 'awaiting_payment') throw new CollectRefused('not_open');
        if (o.expiresAt.getTime() <= now.getTime()) throw new CollectRefused('expired');
        if (o.branchId !== reg.branchId) throw new CollectRefused('wrong_branch');
        const sold = await completeSaleTx(tx, ctx, {
          saleId, receiptNumber: formatReceiptNumber(reg.branchCode, reg.registerCode, Number(reg.counter) + 1 + attempt), tenders, deviceCreatedAt: now.toISOString(),
          lines: o.lines.map((l) => ({ ...l, unitPricePesewas: 0, discountPesewas: 0 })),
        }, now, { serverPrices: true, salespersonId: o.createdBy, quote });
        if (!sold.ok) throwSaleFailure(sold);
        if (quote) {
          const [s] = await tx.select({ total: sales.totalPesewas }).from(sales).where(eq(sales.id, saleId));
          throw new Quoted(o.orderNumber, s.total);
        }
        await tx.update(counterOrders).set({ status: 'paid', saleId }).where(eq(counterOrders.id, o.id));
        return { ok: true as const, saleId, orderNumber: o.orderNumber, changeDuePesewas: sold.changeDuePesewas };
      });
    } catch (e) {
      if (e instanceof Quoted) return { ok: true as const, orderNumber: e.orderNumber, totalPesewas: e.totalPesewas };
      if (e instanceof CollectRefused) return fail(e.code);
      const f = saleFailure(e);
      if (f.error !== 'duplicate_receipt_number' || attempt === 1) return f; // another sale on this till took the number first
    }
  }
}

/** The customer changed their mind: an unpaid order is dropped. */
export async function cancelCounterOrder(db: Db, ctx: Ctx, orderId: string, now: Date): Promise<{ ok: true } | Fail<'not_open'>> {
  assertPermission(ctx, 'make_sale');
  if (!isUuid(orderId)) return fail('not_open');
  return withTenant(db, ctx.tenantId, async (tx) => {
    const mine = await myBranches(tx, ctx);
    if (!mine.length) return fail('not_open');
    const [o] = await tx.update(counterOrders).set({ status: 'cancelled' })
      .where(and(eq(counterOrders.id, orderId), eq(counterOrders.status, 'awaiting_payment'), inArray(counterOrders.branchId, mine)))
      .returning({ id: counterOrders.id, orderNumber: counterOrders.orderNumber });
    if (!o) return fail('not_open');
    await writeAudit(tx, {
      tenantId: ctx.tenantId, actorType: 'user', actorId: ctx.userId, action: 'counter_order_cancelled', recordType: 'counter_order', recordId: o.id,
      changes: { orderNumber: o.orderNumber, at: now.toISOString() },
    });
    return { ok: true as const };
  });
}

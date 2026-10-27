import 'server-only';
import { and, asc, eq, inArray } from 'drizzle-orm';
import { z } from 'zod';
import type { Db, Tx } from '@/db/client';
import { branches, type KitchenOrderStatus, kitchenOrders, packingTicks, saleLines, tenants, users } from '@/db/schema';
import { withTenant } from '@/db/tenant';
import { businessDate } from '@/lib/dates';
import type { DiningOption } from '@/lib/food';
import { writeAudit } from './audit';
import { assertPermission, type Ctx } from './context';
import type { Fail } from './products';

export type KitchenOrderView = {
  id: string; orderNumber: string; status: KitchenOrderStatus; diningOption: DiningOption; needsPacking: boolean;
  sentAt: Date; readyAt: Date | null; lines: Array<{ lineNo: number; name: string; quantity: string; packed: boolean }>;
};

const isUuid = (value: string) => z.uuid().safeParse(value).success;

async function myBranches(tx: Tx, ctx: Ctx): Promise<string[]> {
  const [me] = await tx.select({ branchIds: users.branchIds }).from(users).where(eq(users.id, ctx.userId));
  return me?.branchIds ?? [];
}

/** The order, only when it is at one of the user's branches: another branch's ids leak nothing (`not_found`). */
async function findOrder(tx: Tx, ctx: Ctx, orderId: string) {
  if (!isUuid(orderId)) return undefined;
  const [order] = await tx.select().from(kitchenOrders).where(eq(kitchenOrders.id, orderId)).for('update');
  return order && (await myBranches(tx, ctx)).includes(order.branchId) ? order : undefined;
}

async function linesOf(tx: Tx, orders: Array<{ id: string; saleId: string | null }>) {
  const saleIds = orders.flatMap((o) => (o.saleId ? [o.saleId] : []));
  const lines = saleIds.length ? await tx.select({ saleId: saleLines.saleId, lineNo: saleLines.lineNo, name: saleLines.name, quantity: saleLines.quantity })
    .from(saleLines).where(inArray(saleLines.saleId, saleIds)).orderBy(asc(saleLines.lineNo)) : [];
  const ticks = orders.length ? await tx.select({ orderId: packingTicks.kitchenOrderId, lineNo: packingTicks.lineNo }).from(packingTicks)
    .where(inArray(packingTicks.kitchenOrderId, orders.map((o) => o.id))) : [];
  return (o: { id: string; saleId: string | null }) => lines.filter((l) => l.saleId === o.saleId).map((l) => ({
    lineNo: l.lineNo, name: l.name, quantity: l.quantity, packed: ticks.some((t) => t.orderId === o.id && t.lineNo === l.lineNo),
  }));
}

/** Spec 6.51: today's preparing and ready orders at a branch, oldest first, with their lines and packing ticks. */
export async function listKitchenOrders(db: Db, ctx: Ctx, branchId: string, now: Date): Promise<{ ok: true; orders: KitchenOrderView[] } | Fail<'not_assigned'>> {
  assertPermission(ctx, 'run_kitchen');
  return withTenant(db, ctx.tenantId, async (tx) => {
    if (!isUuid(branchId) || !(await myBranches(tx, ctx)).includes(branchId)) return { ok: false, error: 'not_assigned' } as const;
    const [shop] = await tx.select({ timezone: tenants.timezone, cutoff: tenants.businessDayCutoff }).from(tenants).where(eq(tenants.id, ctx.tenantId));
    const orders = await tx.select().from(kitchenOrders).where(and(
      eq(kitchenOrders.branchId, branchId), eq(kitchenOrders.businessDate, businessDate(shop.timezone, shop.cutoff, now)),
      inArray(kitchenOrders.status, ['preparing', 'ready']),
    )).orderBy(asc(kitchenOrders.sentAt), asc(kitchenOrders.orderNumber));
    const lines = await linesOf(tx, orders);
    return { ok: true, orders: orders.map((o) => ({
      id: o.id, orderNumber: o.orderNumber, status: o.status, diningOption: o.diningOption, needsPacking: o.needsPacking,
      sentAt: o.sentAt, readyAt: o.readyAt, lines: lines(o),
    })) } as const;
  });
}

export async function markOrderReady(db: Db, ctx: Ctx, orderId: string, now: Date): Promise<{ ok: true } | Fail<'not_found' | 'wrong_status'>> {
  assertPermission(ctx, 'run_kitchen');
  return withTenant(db, ctx.tenantId, async (tx) => {
    const order = await findOrder(tx, ctx, orderId);
    if (!order) return { ok: false, error: 'not_found' } as const;
    if (order.status !== 'preparing') return { ok: false, error: 'wrong_status' } as const;
    await tx.update(kitchenOrders).set({ status: 'ready', readyAt: now }).where(eq(kitchenOrders.id, order.id));
    await writeAudit(tx, { tenantId: ctx.tenantId, actorType: 'user', actorId: ctx.userId, action: 'order_ready', recordType: 'kitchen_order', recordId: order.id });
    return { ok: true } as const;
  });
}

/** Spec 6.58: one tick per packed line; unticking removes it. */
export async function tickPackedLine(
  db: Db, ctx: Ctx, input: { orderId: string; lineNo: number; packed: boolean }, now: Date,
): Promise<{ ok: true } | Fail<'not_found' | 'no_packing' | 'unknown_line'>> {
  assertPermission(ctx, 'run_kitchen');
  return withTenant(db, ctx.tenantId, async (tx) => {
    const order = await findOrder(tx, ctx, input.orderId);
    if (!order || !['preparing', 'ready'].includes(order.status)) return { ok: false, error: 'not_found' } as const;
    if (!order.needsPacking) return { ok: false, error: 'no_packing' } as const;
    const lines = (await linesOf(tx, [order]))(order);
    if (!Number.isInteger(input.lineNo) || !lines.some((l) => l.lineNo === input.lineNo)) return { ok: false, error: 'unknown_line' } as const;
    if (input.packed === true) {
      await tx.insert(packingTicks).values({ tenantId: ctx.tenantId, kitchenOrderId: order.id, lineNo: input.lineNo, packedBy: ctx.userId, packedAt: now })
        .onConflictDoNothing();
    } else {
      await tx.delete(packingTicks).where(and(eq(packingTicks.kitchenOrderId, order.id), eq(packingTicks.lineNo, input.lineNo)));
    }
    return { ok: true } as const;
  });
}

/** Eat in: collected. Takeaway or delivery: every line packed, and who took it (customer, or rider and app) recorded. */
export async function handOverOrder(
  db: Db, ctx: Ctx, input: { orderId: string; handedTo?: string }, now: Date,
): Promise<{ ok: true } | Fail<'not_found' | 'not_packed' | 'wrong_status' | 'invalid_input'>> {
  assertPermission(ctx, 'run_kitchen');
  return withTenant(db, ctx.tenantId, async (tx) => {
    const order = await findOrder(tx, ctx, input.orderId);
    if (!order) return { ok: false, error: 'not_found' } as const;
    if (!['preparing', 'ready'].includes(order.status)) return { ok: false, error: 'wrong_status' } as const;
    const handedTo = typeof input.handedTo === 'string' ? input.handedTo.trim() : '';
    if (order.needsPacking) {
      if (!(await linesOf(tx, [order]))(order).every((l) => l.packed)) return { ok: false, error: 'not_packed' } as const;
      if (handedTo.length < 1 || handedTo.length > 80) return { ok: false, error: 'invalid_input' } as const;
    }
    const status = order.needsPacking ? 'handed_over' : 'collected';
    await tx.update(kitchenOrders).set({ status, closedAt: now, closedBy: ctx.userId, handedTo: order.needsPacking ? handedTo : null })
      .where(eq(kitchenOrders.id, order.id));
    await writeAudit(tx, {
      tenantId: ctx.tenantId, actorType: 'user', actorId: ctx.userId, action: order.needsPacking ? 'order_handed_over' : 'order_collected',
      recordType: 'kitchen_order', recordId: order.id, changes: order.needsPacking ? { handedTo } : undefined,
    });
    return { ok: true } as const;
  });
}

/** The branches whose kitchen this user can run. */
export async function kitchenBranches(
  db: Db, ctx: Ctx, permission: 'run_kitchen' | 'record_kitchen_stock' = 'run_kitchen',
): Promise<Array<{ id: string; name: string }>> {
  assertPermission(ctx, permission);
  return withTenant(db, ctx.tenantId, async (tx) => {
    const mine = await myBranches(tx, ctx);
    return mine.length ? tx.select({ id: branches.id, name: branches.name }).from(branches).where(inArray(branches.id, mine)).orderBy(asc(branches.name)) : [];
  });
}

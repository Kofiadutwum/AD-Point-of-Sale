import 'server-only';
import { and, asc, eq, inArray } from 'drizzle-orm';
import type { Db } from '@/db/client';
import { addOnOptions, type KitchenStation, products, ticketLines, tickets, users, variants } from '@/db/schema';
import { withTenant } from '@/db/tenant';
import { KITCHEN_STATIONS } from '@/lib/food';
import { assertPermission, type Ctx } from './context';
import { type Fail, fail, isUuid, itemLabel } from './products';

export type StationTicket = {
  ticketId: string; label: string; waiterName: string; oldestSentAt: Date;
  lines: Array<{ lineId: string; name: string; quantity: string; addOns: string[]; note: string | null; sentAt: Date }>;
};

const branchesOf = async (tx: Parameters<Parameters<typeof withTenant>[2]>[0], ctx: Ctx) =>
  (await tx.select({ branchIds: users.branchIds }).from(users).where(eq(users.id, ctx.userId)))[0]?.branchIds ?? [];

/** Spec 6.37: a station's sent lines of open tickets at a branch, grouped by ticket, oldest first. */
export async function listStationLines(db: Db, ctx: Ctx, branchId: string, station: KitchenStation): Promise<StationTicket[]> {
  assertPermission(ctx, 'run_kitchen');
  if (!isUuid(branchId) || !KITCHEN_STATIONS.includes(station)) return [];
  return withTenant(db, ctx.tenantId, async (tx) => {
    if (!(await branchesOf(tx, ctx)).includes(branchId)) return [];
    const rows = await tx.select({ line: ticketLines, ticket: tickets, waiterName: users.name, productName: products.name, variantName: variants.name })
      .from(ticketLines).innerJoin(tickets, eq(tickets.id, ticketLines.ticketId)).innerJoin(users, eq(users.id, tickets.waiterId))
      .innerJoin(variants, eq(variants.id, ticketLines.variantId)).innerJoin(products, eq(products.id, variants.productId))
      .where(and(eq(tickets.branchId, branchId), eq(tickets.status, 'open'), eq(ticketLines.station, station), eq(ticketLines.kitchenStatus, 'sent')))
      .orderBy(asc(ticketLines.sentAt), asc(ticketLines.lineNo));
    const optionIds = [...new Set(rows.flatMap((r) => r.line.addOns.map((a) => a.optionId)))];
    const names = optionIds.length ? await tx.select({ id: addOnOptions.id, name: addOnOptions.name }).from(addOnOptions).where(inArray(addOnOptions.id, optionIds)) : [];
    const byTicket = new Map<string, StationTicket>();
    for (const r of rows) {
      const entry = byTicket.get(r.ticket.id) ?? { ticketId: r.ticket.id, label: r.ticket.label, waiterName: r.waiterName, oldestSentAt: r.line.sentAt!, lines: [] };
      entry.lines.push({
        lineId: r.line.id, name: itemLabel(r.productName, r.variantName), quantity: r.line.quantity, note: r.line.note, sentAt: r.line.sentAt!,
        addOns: r.line.addOns.map((a) => names.find((n) => n.id === a.optionId)?.name ?? 'Add-on'),
      });
      byTicket.set(r.ticket.id, entry);
    }
    return [...byTicket.values()]; // rows come oldest first, so tickets do too
  });
}

/** Staff tap "Ready": the line leaves the station display and the waiter sees it ready. */
export async function markLineReady(db: Db, ctx: Ctx, lineId: string, now: Date): Promise<{ ok: true } | Fail<'not_found' | 'not_sent'>> {
  assertPermission(ctx, 'run_kitchen');
  if (!isUuid(lineId)) return fail('not_found');
  return withTenant(db, ctx.tenantId, async (tx): Promise<{ ok: true } | Fail<'not_found' | 'not_sent'>> => {
    const [row] = await tx.select({ line: ticketLines, branchId: tickets.branchId, status: tickets.status }).from(ticketLines)
      .innerJoin(tickets, eq(tickets.id, ticketLines.ticketId)).where(eq(ticketLines.id, lineId)).for('update', { of: ticketLines });
    if (!row || !(await branchesOf(tx, ctx)).includes(row.branchId)) return fail('not_found');
    if (row.line.kitchenStatus !== 'sent' || row.status !== 'open') return fail('not_sent');
    await tx.update(ticketLines).set({ kitchenStatus: 'ready', readyAt: now }).where(eq(ticketLines.id, row.line.id));
    return { ok: true };
  });
}

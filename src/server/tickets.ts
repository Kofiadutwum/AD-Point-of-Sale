import 'server-only';
import { and, asc, count, eq, inArray, ne } from 'drizzle-orm';
import { z } from 'zod';
import type { Db, Tx } from '@/db/client';
import {
  addOnOptions, branches, diningTables, type KitchenStation, products, registers, ticketLines, tickets, type TicketLineStatus, type TicketStatus, users, variants,
} from '@/db/schema';
import { withTenant } from '@/db/tenant';
import { DINING_OPTIONS, type DiningOption } from '@/lib/food';
import { writeAudit } from './audit';
import { assertPermission, type Ctx } from './context';
import { type Fail, fail, isUuid, itemLabel } from './products';
import { isUniqueViolation } from './sales';

export type TicketView = {
  id: string; label: string; tableId: string | null; status: TicketStatus; diningOption: DiningOption; waiterName: string; openedAt: Date;
  lines: Array<{ id: string; lineNo: number; name: string; quantity: string; addOns: string[]; note: string | null; station: KitchenStation; kitchenStatus: TicketLineStatus }>;
};

/** The till's branch, or the user's only branch when not at a till. */
export async function ticketBranch(tx: Tx, ctx: Ctx): Promise<string | null> {
  if (ctx.registerId) {
    const [reg] = await tx.select({ branchId: registers.branchId }).from(registers).where(eq(registers.id, ctx.registerId));
    return reg?.branchId ?? null;
  }
  const [me] = await tx.select({ branchIds: users.branchIds }).from(users).where(eq(users.id, ctx.userId));
  return me?.branchIds.length === 1 ? me.branchIds[0] : null;
}

const openSchema = z.object({ tableId: z.uuid().optional(), label: z.string().trim().min(1).max(40).optional(), diningOption: z.enum(DINING_OPTIONS) })
  .refine((o) => o.tableId || o.label);
type OpenResult = { ok: true; ticketId: string } | Fail<'invalid_input' | 'no_branch' | 'table_taken' | 'unknown_table' | 'mode_not_allowed'>;

/** Spec 6.37: a ticket for a table (named after it) or for a customer name; one open ticket per table. */
export async function openTicket(db: Db, ctx: Ctx, input: { tableId?: string; label?: string; diningOption: DiningOption }, now: Date): Promise<OpenResult> {
  assertPermission(ctx, 'take_orders');
  const parsed = openSchema.safeParse(input);
  if (!parsed.success) return fail('invalid_input');
  const o = parsed.data;
  try {
    return await withTenant(db, ctx.tenantId, async (tx): Promise<OpenResult> => {
      const branchId = await ticketBranch(tx, ctx);
      if (!branchId) return fail('no_branch');
      const [branch] = await tx.select({ modes: branches.serviceModes }).from(branches).where(eq(branches.id, branchId));
      if (!branch?.modes.includes('table')) return fail('mode_not_allowed');
      let label = o.label ?? '';
      if (o.tableId) {
        const [table] = await tx.select().from(diningTables).where(and(eq(diningTables.id, o.tableId), eq(diningTables.branchId, branchId))).for('update');
        if (!table || !table.active) return fail('unknown_table');
        const [busy] = await tx.select({ id: tickets.id }).from(tickets).where(and(eq(tickets.tableId, table.id), eq(tickets.status, 'open')));
        if (busy) return fail('table_taken');
        label = table.name;
        await tx.update(diningTables).set({ status: 'ordering' }).where(eq(diningTables.id, table.id));
      }
      const [row] = await tx.insert(tickets).values({
        tenantId: ctx.tenantId, branchId, tableId: o.tableId ?? null, label, waiterId: ctx.userId, diningOption: o.diningOption, openedAt: now,
      }).returning({ id: tickets.id });
      await writeAudit(tx, { tenantId: ctx.tenantId, actorType: 'user', actorId: ctx.userId, action: 'ticket_opened', recordType: 'ticket', recordId: row.id, changes: { label } });
      return { ok: true, ticketId: row.id };
    });
  } catch (e) {
    if (isUniqueViolation(e, 'tickets_open_table')) return fail('table_taken'); // another waiter opened it at the same moment
    throw e;
  }
}

/** A ticket with its lines in order, item and add-on names, and kitchen status. */
export async function getTicket(db: Db, ctx: Ctx, ticketId: string): Promise<TicketView | null> {
  assertPermission(ctx, 'take_orders');
  if (!isUuid(ticketId)) return null;
  return withTenant(db, ctx.tenantId, async (tx) => {
    const [t] = await tx.select({ ticket: tickets, waiterName: users.name }).from(tickets).innerJoin(users, eq(users.id, tickets.waiterId)).where(eq(tickets.id, ticketId));
    if (!t) return null;
    const lines = await tx.select({ line: ticketLines, productName: products.name, variantName: variants.name }).from(ticketLines)
      .innerJoin(variants, eq(variants.id, ticketLines.variantId)).innerJoin(products, eq(products.id, variants.productId))
      .where(eq(ticketLines.ticketId, ticketId)).orderBy(asc(ticketLines.lineNo));
    const optionIds = [...new Set(lines.flatMap((l) => l.line.addOns.map((a) => a.optionId)))];
    const names = optionIds.length ? await tx.select({ id: addOnOptions.id, name: addOnOptions.name }).from(addOnOptions).where(inArray(addOnOptions.id, optionIds)) : [];
    return {
      id: t.ticket.id, label: t.ticket.label, tableId: t.ticket.tableId, status: t.ticket.status, diningOption: t.ticket.diningOption, waiterName: t.waiterName, openedAt: t.ticket.openedAt,
      lines: lines.map(({ line: l, productName, variantName }) => ({
        id: l.id, lineNo: l.lineNo, name: itemLabel(productName, variantName), quantity: l.quantity, note: l.note, station: l.station, kitchenStatus: l.kitchenStatus,
        addOns: l.addOns.map((a) => names.find((n) => n.id === a.optionId)?.name ?? 'Add-on'),
      })),
    };
  });
}

/** The branch's open tickets, oldest first, with how many live lines each holds. */
export async function listOpenTickets(db: Db, ctx: Ctx, branchId: string): Promise<Array<Omit<TicketView, 'lines'> & { lineCount: number }>> {
  assertPermission(ctx, 'take_orders');
  if (!isUuid(branchId)) return [];
  return withTenant(db, ctx.tenantId, async (tx) => {
    const rows = await tx.select({ ticket: tickets, waiterName: users.name }).from(tickets).innerJoin(users, eq(users.id, tickets.waiterId))
      .where(and(eq(tickets.branchId, branchId), eq(tickets.status, 'open'))).orderBy(asc(tickets.openedAt));
    const counts = rows.length ? await tx.select({ ticketId: ticketLines.ticketId, n: count() }).from(ticketLines)
      .where(and(inArray(ticketLines.ticketId, rows.map((r) => r.ticket.id)), ne(ticketLines.kitchenStatus, 'void'))).groupBy(ticketLines.ticketId) : [];
    return rows.map(({ ticket: t, waiterName }) => ({
      id: t.id, label: t.label, tableId: t.tableId, status: t.status, diningOption: t.diningOption, waiterName, openedAt: t.openedAt,
      lineCount: Number(counts.find((c) => c.ticketId === t.id)?.n ?? 0),
    }));
  });
}

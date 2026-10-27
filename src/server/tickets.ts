import 'server-only';
import { randomUUID } from 'node:crypto';
import { and, asc, count, eq, inArray, ne, sql } from 'drizzle-orm';
import { z } from 'zod';
import type { Db, Tx } from '@/db/client';
import {
  addOnOptions, branches, diningTables, foodSettings, type KitchenStation, products, registers, tenants, ticketLines, tickets, type TicketLineStatus, type TicketStatus, users,
  variants, variantUnits, wastageEntries,
} from '@/db/schema';
import { withTenant } from '@/db/tenant';
import { businessDate } from '@/lib/dates';
import { multiplyQty } from '@/lib/decimal';
import { formatReceiptNumber } from '@/device/sale';
import { DINING_OPTIONS, type DiningOption, KITCHEN_STATIONS, packCount } from '@/lib/food';
import { writeAudit } from './audit';
import { assertPermission, type Ctx } from './context';
import { type Fail, fail, isUuid, itemLabel } from './products';
import { verifyStaffPin } from './devices';
import { costFor } from './pots';
import { checkOrderLine, completeSale, isUniqueViolation, type OrderLineError, type SaleInput, type SaleResult } from './sales';
import { deductRecipe } from './stock';
import { costOf } from './variants';

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

/** Items a waiter can put on a ticket: active, sellable, plain or recipe items by their base unit (not combos, by-amount, or serial items). */
export async function listTicketItems(db: Db, ctx: Ctx): Promise<Array<{ variantId: string; unitId: string; label: string }>> {
  assertPermission(ctx, 'take_orders');
  // shortcut: combos and sell-by-amount items are not offered on tickets yet; sell them at the counter till
  return withTenant(db, ctx.tenantId, async (tx) => (await tx.select({ variantId: variants.id, unitId: variantUnits.id, productName: products.name, variantName: variants.name })
    .from(variants).innerJoin(products, eq(products.id, variants.productId))
    .innerJoin(variantUnits, and(eq(variantUnits.variantId, variants.id), eq(variantUnits.isBase, true)))
    .where(and(eq(variants.status, 'active'), eq(products.status, 'active'), eq(variants.sellable, true), inArray(variants.kind, ['standard', 'recipe']),
      eq(variants.sellByAmount, false), ne(products.tracking, 'serial')))
    .orderBy(asc(products.name), asc(variants.name))).map((v) => ({ variantId: v.variantId, unitId: v.unitId, label: itemLabel(v.productName, v.variantName) })));
}

/** The branch whose tables and tickets this user works with now. */
export async function currentTicketBranch(db: Db, ctx: Ctx): Promise<string | null> {
  assertPermission(ctx, 'take_orders');
  return withTenant(db, ctx.tenantId, (tx) => ticketBranch(tx, ctx));
}

/** Managers at the branch who can approve a void with their PIN, other than the signed-in user. */
export async function listApprovers(db: Db, ctx: Ctx, branchId: string): Promise<Array<{ id: string; name: string }>> {
  assertPermission(ctx, 'take_orders');
  if (!isUuid(branchId)) return [];
  return withTenant(db, ctx.tenantId, async (tx) => (await tx.select({ id: users.id, name: users.name, permissions: users.permissions, branchIds: users.branchIds, pinHash: users.pinHash })
    .from(users).where(and(eq(users.status, 'active'), ne(users.id, ctx.userId))).orderBy(asc(users.name)))
    .filter((u) => u.pinHash && u.permissions.includes('void_sent_items') && u.branchIds.includes(branchId)).map((u) => ({ id: u.id, name: u.name })));
}

/** The ticket, locked, when it is at one of the user's branches; 'not_open' once paid, merged, or cancelled. */
async function openTicketRow(tx: Tx, ctx: Ctx, ticketId: string) {
  if (!isUuid(ticketId)) return 'not_found' as const;
  const [t] = await tx.select().from(tickets).where(eq(tickets.id, ticketId)).for('update');
  const [me] = await tx.select({ branchIds: users.branchIds }).from(users).where(eq(users.id, ctx.userId));
  if (!t || !me?.branchIds.includes(t.branchId)) return 'not_found' as const;
  return t.status === 'open' ? t : ('not_open' as const);
}

async function shopDay(tx: Tx, tenantId: string, now: Date): Promise<string> {
  const [shop] = await tx.select({ timezone: tenants.timezone, cutoff: tenants.businessDayCutoff }).from(tenants).where(eq(tenants.id, tenantId));
  return businessDate(shop.timezone, shop.cutoff, now);
}

const lineSchema = z.object({
  variantId: z.uuid(), unitId: z.uuid(), quantity: z.string().max(20), byAmount: z.boolean().optional(),
  amountPesewas: z.number().int().min(1).max(2_000_000_000).optional(),
  choices: z.array(z.object({ slotId: z.uuid(), variantId: z.uuid() })).max(20).optional(),
  addOns: z.array(z.object({ groupId: z.uuid(), optionId: z.uuid() })).max(30).optional(),
  note: z.string().trim().max(140).optional(),
});
type AddLineResult = { ok: true; lineId: string } | Fail<'not_found' | 'not_open' | 'invalid_input' | OrderLineError>;

/** Spec 6.37: an item added to an open ticket at its product's station; it is priced when the ticket is paid. */
export async function addTicketLine(db: Db, ctx: Ctx, ticketId: string, line: z.input<typeof lineSchema>, now: Date): Promise<AddLineResult> {
  assertPermission(ctx, 'take_orders');
  const parsed = lineSchema.safeParse(line);
  if (!parsed.success) return fail('invalid_input');
  const l = parsed.data;
  return withTenant(db, ctx.tenantId, async (tx): Promise<AddLineResult> => {
    const t = await openTicketRow(tx, ctx, ticketId);
    if (typeof t === 'string') return fail(t);
    const [settings] = await tx.select({ packId: foodSettings.packVariantId }).from(foodSettings);
    if (l.variantId === settings?.packId) return fail('invalid_input'); // packs are added when the ticket is paid
    const checked = await checkOrderLine(tx, l, t.branchId, await shopDay(tx, ctx.tenantId, now));
    if (typeof checked === 'string') return fail(checked);
    const [{ station }] = await tx.select({ station: products.kitchenStation }).from(variants)
      .innerJoin(products, eq(products.id, variants.productId)).where(eq(variants.id, l.variantId));
    const [{ last }] = await tx.select({ last: sql<number>`coalesce(max(${ticketLines.lineNo}), 0)::int` }).from(ticketLines).where(eq(ticketLines.ticketId, t.id));
    const [row] = await tx.insert(ticketLines).values({
      tenantId: ctx.tenantId, ticketId: t.id, lineNo: Number(last) + 1, variantId: checked.variantId, unitId: checked.unitId, quantity: checked.quantity,
      byAmount: checked.byAmount === true, amountPesewas: checked.amountPesewas ?? null, choices: checked.choices ?? [], addOns: checked.addOns ?? [],
      note: checked.note ?? null, station,
    }).returning({ id: ticketLines.id });
    return { ok: true, lineId: row.id };
  });
}

/** A line not yet sent can be taken off freely; a sent one needs a void. */
export async function removeTicketLine(db: Db, ctx: Ctx, lineId: string): Promise<{ ok: true } | Fail<'not_found' | 'already_sent'>> {
  assertPermission(ctx, 'take_orders');
  if (!isUuid(lineId)) return fail('not_found');
  return withTenant(db, ctx.tenantId, async (tx): Promise<{ ok: true } | Fail<'not_found' | 'already_sent'>> => {
    const [line] = await tx.select().from(ticketLines).where(eq(ticketLines.id, lineId));
    if (!line || typeof (await openTicketRow(tx, ctx, line.ticketId)) === 'string') return fail('not_found');
    if (line.kitchenStatus !== 'new') return fail('already_sent');
    await tx.delete(ticketLines).where(eq(ticketLines.id, line.id));
    return { ok: true };
  });
}

type SendResult = { ok: true; sent: Record<KitchenStation, number> } | Fail<'not_found' | 'not_open' | 'nothing_new'>;

/** Spec 6.37: every new line goes to its station at once; the table now waits for food. */
export async function sendToKitchen(db: Db, ctx: Ctx, ticketId: string, now: Date): Promise<SendResult> {
  assertPermission(ctx, 'take_orders');
  return withTenant(db, ctx.tenantId, async (tx): Promise<SendResult> => {
    const t = await openTicketRow(tx, ctx, ticketId);
    if (typeof t === 'string') return fail(t);
    const sent = await tx.update(ticketLines).set({ kitchenStatus: 'sent', sentAt: now })
      .where(and(eq(ticketLines.ticketId, t.id), eq(ticketLines.kitchenStatus, 'new'))).returning({ station: ticketLines.station });
    if (!sent.length) return fail('nothing_new');
    if (t.tableId) await tx.update(diningTables).set({ status: 'waiting_for_food' }).where(eq(diningTables.id, t.tableId));
    await writeAudit(tx, { tenantId: ctx.tenantId, actorType: 'user', actorId: ctx.userId, action: 'ticket_sent', recordType: 'ticket', recordId: t.id, changes: { lines: sent.length } });
    return { ok: true, sent: Object.fromEntries(KITCHEN_STATIONS.map((st) => [st, sent.filter((x) => x.station === st).length])) as Record<KitchenStation, number> };
  });
}

type VoidResult = { ok: true } | Fail<'not_found' | 'not_sent' | 'invalid_input' | 'self_approval' | 'not_authorised' | 'wrong_pin' | 'pin_locked'>;

/** Spec 6.37: a line already sent is voided only with a reason and another person's manager PIN; a prepared dish is recorded as waste. */
export async function voidSentLine(db: Db, ctx: Ctx, input: { lineId: string; reason: string; prepared: boolean; approverId: string; approverPin: string }, now: Date): Promise<VoidResult> {
  assertPermission(ctx, 'take_orders');
  const reason = typeof input.reason === 'string' ? input.reason.trim() : '';
  if (reason.length < 1 || reason.length > 200 || !isUuid(input.lineId) || !isUuid(input.approverId) || typeof input.approverPin !== 'string') return fail('invalid_input');
  return withTenant(db, ctx.tenantId, async (tx): Promise<VoidResult> => {
    const [line] = await tx.select().from(ticketLines).where(eq(ticketLines.id, input.lineId));
    if (!line) return fail('not_found');
    const t = await openTicketRow(tx, ctx, line.ticketId);
    if (typeof t === 'string') return fail('not_found');
    if (line.kitchenStatus !== 'sent' && line.kitchenStatus !== 'ready') return fail('not_sent');
    if (input.approverId === ctx.userId) return fail('self_approval');
    const [approver] = await tx.select().from(users).where(eq(users.id, input.approverId)).for('update');
    if (!approver || approver.status !== 'active' || !approver.permissions.includes('void_sent_items') || !approver.branchIds.includes(t.branchId)) return fail('not_authorised');
    const pin = await verifyStaffPin(tx, { tenantId: ctx.tenantId, staff: approver, pin: input.approverPin, registerId: ctx.registerId ?? null }, now);
    if (pin !== 'ok') return fail(pin);
    await tx.update(ticketLines).set({ kitchenStatus: 'void', voidReason: reason, voidedBy: ctx.userId, approvedBy: approver.id }).where(eq(ticketLines.id, line.id));
    if (input.prepared === true) await wasteVoidedLine(tx, ctx, t.branchId, line, now);
    await writeAudit(tx, { tenantId: ctx.tenantId, actorType: 'user', actorId: approver.id, action: 'ticket_line_voided', recordType: 'ticket', recordId: t.id,
      changes: { lineNo: line.lineNo, reason, prepared: input.prepared === true, requestedBy: ctx.userId } });
    return { ok: true };
  });
}

/** "Already prepared": the dish was made, so its ingredients leave stock as waste with their cost. */
async function wasteVoidedLine(tx: Tx, ctx: Ctx, branchId: string, line: typeof ticketLines.$inferSelect, now: Date): Promise<void> {
  const [item] = await tx.select({ kind: variants.kind, factor: variantUnits.factor }).from(variantUnits)
    .innerJoin(variants, eq(variants.id, variantUnits.variantId)).where(eq(variantUnits.id, line.unitId));
  // shortcut: a combo or by-amount line is voided without waste (its parts vary, or its pot is counted at closing); record those on the kitchen stock page
  if (!item || item.kind === 'combo' || line.byAmount) return;
  const quantity = multiplyQty(line.quantity, item.factor);
  const [w] = await tx.insert(wastageEntries).values({
    tenantId: ctx.tenantId, branchId, variantId: line.variantId, businessDate: await shopDay(tx, ctx.tenantId, now), quantity, reason: 'spoiled',
    costPesewas: costFor(await costOf(tx, line.variantId), quantity), note: 'voided after sending', userId: ctx.userId,
  }).returning({ id: wastageEntries.id });
  await deductRecipe(tx, { tenantId: ctx.tenantId, branchId, userId: ctx.userId }, line.variantId, quantity, 'waste', { type: 'wastage', id: w.id });
}

type MoveResult = { ok: true; merged: boolean } | Fail<'not_found' | 'not_open' | 'invalid_input'>;

/** Spec 6.37: lines move to another open ticket of the branch; moving all of them merges the tickets and frees the first table. */
export async function moveTicketLines(db: Db, ctx: Ctx, input: { fromTicketId: string; toTicketId: string; lineIds: string[] }, now: Date): Promise<MoveResult> {
  assertPermission(ctx, 'take_orders');
  const ids = Array.isArray(input.lineIds) ? input.lineIds : [];
  if (!ids.length || ids.length > 200 || !ids.every(isUuid) || new Set(ids).size !== ids.length || input.fromTicketId === input.toTicketId) return fail('invalid_input');
  return withTenant(db, ctx.tenantId, async (tx): Promise<MoveResult> => {
    // lock both tickets in id order, so two moves between the same tickets cannot deadlock
    const [first, second] = [input.fromTicketId, input.toTicketId].sort();
    const a = await openTicketRow(tx, ctx, first);
    const b = await openTicketRow(tx, ctx, second);
    if (typeof a === 'string') return fail(a);
    if (typeof b === 'string') return fail(b);
    const [from, to] = a.id === input.fromTicketId ? [a, b] : [b, a];
    if (from.branchId !== to.branchId) return fail('invalid_input');
    const lines = await tx.select().from(ticketLines).where(and(eq(ticketLines.ticketId, from.id), inArray(ticketLines.id, ids))).orderBy(asc(ticketLines.lineNo));
    if (lines.length !== ids.length || lines.some((l) => l.kitchenStatus === 'void')) return fail('invalid_input');
    const [{ last }] = await tx.select({ last: sql<number>`coalesce(max(${ticketLines.lineNo}), 0)::int` }).from(ticketLines).where(eq(ticketLines.ticketId, to.id));
    for (const [i, l] of lines.entries()) await tx.update(ticketLines).set({ ticketId: to.id, lineNo: Number(last) + i + 1 }).where(eq(ticketLines.id, l.id));
    const [{ left }] = await tx.select({ left: count() }).from(ticketLines).where(and(eq(ticketLines.ticketId, from.id), ne(ticketLines.kitchenStatus, 'void')));
    const merged = Number(left) === 0;
    if (merged) {
      await tx.update(tickets).set({ status: 'merged', closedAt: now }).where(eq(tickets.id, from.id));
      if (from.tableId) await tx.update(diningTables).set({ status: 'free' }).where(eq(diningTables.id, from.tableId));
    }
    await writeAudit(tx, { tenantId: ctx.tenantId, actorType: 'user', actorId: ctx.userId, action: merged ? 'ticket_merged' : 'ticket_lines_moved', recordType: 'ticket',
      recordId: from.id, changes: { toTicketId: to.id, lines: lines.length } });
    return { ok: true, merged };
  });
}

/** The bill is printed: the table shows it is waiting to pay. */
export async function printBill(db: Db, ctx: Ctx, ticketId: string, now: Date): Promise<{ ok: true } | Fail<'not_found' | 'not_open'>> {
  assertPermission(ctx, 'take_orders');
  return withTenant(db, ctx.tenantId, async (tx): Promise<{ ok: true } | Fail<'not_found' | 'not_open'>> => {
    const t = await openTicketRow(tx, ctx, ticketId);
    if (typeof t === 'string') return fail(t);
    if (t.tableId) await tx.update(diningTables).set({ status: 'bill_printed' }).where(eq(diningTables.id, t.tableId));
    await writeAudit(tx, { tenantId: ctx.tenantId, actorType: 'user', actorId: ctx.userId, action: 'bill_printed', recordType: 'ticket', recordId: t.id, changes: { at: now.toISOString() } });
    return { ok: true };
  });
}

type CancelResult = { ok: true } | Fail<'not_found' | 'not_open' | 'has_sent_lines' | 'invalid_input'>;

/** A ticket nothing was sent from can be cancelled with a reason; once the kitchen has items, they are voided one by one instead. */
export async function cancelTicket(db: Db, ctx: Ctx, ticketId: string, reason: string, now: Date): Promise<CancelResult> {
  assertPermission(ctx, 'take_orders');
  const why = typeof reason === 'string' ? reason.trim() : '';
  if (why.length < 1 || why.length > 200) return fail('invalid_input');
  return withTenant(db, ctx.tenantId, async (tx): Promise<CancelResult> => {
    const t = await openTicketRow(tx, ctx, ticketId);
    if (typeof t === 'string') return fail(t);
    const [sent] = await tx.select({ id: ticketLines.id }).from(ticketLines)
      .where(and(eq(ticketLines.ticketId, t.id), inArray(ticketLines.kitchenStatus, ['sent', 'ready']))).limit(1);
    if (sent) return fail('has_sent_lines');
    await tx.update(tickets).set({ status: 'cancelled', closedAt: now }).where(eq(tickets.id, t.id));
    if (t.tableId) await tx.update(diningTables).set({ status: 'free' }).where(eq(diningTables.id, t.tableId));
    await writeAudit(tx, { tenantId: ctx.tenantId, actorType: 'user', actorId: ctx.userId, action: 'ticket_cancelled', recordType: 'ticket', recordId: t.id, changes: { reason: why } });
    return { ok: true };
  });
}

/** Spec 6.37: closes a ticket into one sale at today's prices with the shop's service charge; the server numbers the receipt. Online only. */
export async function payTicket(db: Db, ctx: Ctx, input: { ticketId: string; tenders: SaleInput['tenders'] }, now: Date): Promise<SaleResult> {
  assertPermission(ctx, 'take_orders');
  if (!isUuid(input.ticketId)) return { ok: false, error: 'ticket_not_open' };
  if (!ctx.registerId) return { ok: false, error: 'no_register' };
  const registerId = ctx.registerId;
  const found = await withTenant(db, ctx.tenantId, async (tx) => {
    const [t] = await tx.select().from(tickets).where(eq(tickets.id, input.ticketId));
    if (!t || t.status !== 'open') return null;
    const lines = await tx.select().from(ticketLines).where(and(eq(ticketLines.ticketId, t.id), ne(ticketLines.kitchenStatus, 'void'))).orderBy(asc(ticketLines.lineNo));
    const [settings] = await tx.select().from(foodSettings);
    const packId = settings?.packVariantId ?? null;
    const flags = lines.length ? await tx.select({ id: variants.id, needsPack: variants.needsPack }).from(variants).where(inArray(variants.id, lines.map((l) => l.variantId))) : [];
    // the same pack rule the sale checks (spec 6.56): takeaway and delivery tickets carry their packs
    const packs = packCount(lines, {
      diningOption: t.diningOption, mode: settings?.packFeeMode ?? 'per_order', packVariantId: packId, needsPack: (id) => flags.find((f) => f.id === id)?.needsPack ?? false,
    });
    const [packUnit] = packs && packId ? await tx.select({ id: variantUnits.id }).from(variantUnits).where(and(eq(variantUnits.variantId, packId), eq(variantUnits.isBase, true))) : [];
    const [reg] = await tx.select({ counter: registers.receiptCounter, registerCode: registers.registerCode, branchCode: branches.branchCode })
      .from(registers).innerJoin(branches, eq(branches.id, registers.branchId)).where(eq(registers.id, registerId));
    return { t, lines, packs, packId, packUnitId: packUnit?.id ?? null, reg };
  });
  if (!found) return { ok: false, error: 'ticket_not_open' };
  if (!found.reg) return { ok: false, error: 'no_register' };
  const { t, reg } = found;
  const lines: SaleInput['lines'] = [
    // prices are filled in by completeSale from the catalogue; a by-amount line keeps its amount
    ...found.lines.map((l) => ({
      variantId: l.variantId, unitId: l.unitId, quantity: l.quantity, unitPricePesewas: l.amountPesewas ?? 0, discountPesewas: 0,
      ...(l.byAmount ? { byAmount: true } : {}), ...(l.choices.length ? { choices: l.choices } : {}), ...(l.addOns.length ? { addOns: l.addOns } : {}), ...(l.note ? { note: l.note } : {}),
    })),
    ...(found.packs && found.packId && found.packUnitId
      ? [{ variantId: found.packId, unitId: found.packUnitId, quantity: String(found.packs), unitPricePesewas: 0, discountPesewas: 0 }] : []),
  ];
  if (!lines.length) return { ok: false, error: 'invalid_input' };
  const saleId = randomUUID();
  let counter = Number(reg.counter) + 1;
  for (let attempt = 0; ; attempt++) {
    const r = await completeSale(db, ctx, {
      saleId, receiptNumber: formatReceiptNumber(reg.branchCode, reg.registerCode, counter), lines, tenders: input.tenders, deviceCreatedAt: now.toISOString(),
      food: { serviceMode: 'table', diningOption: t.diningOption, ticketId: t.id },
    }, now);
    if (r.ok || r.error !== 'duplicate_receipt_number' || attempt === 1) return r;
    counter++; // another sale on this till took the number first
  }
}

import 'server-only';
import { and, eq, sql } from 'drizzle-orm';
import type { Db, Tx } from '@/db/client';
import { cashMovements, customerLedger, payments, registers, returns, sales, shifts, tenants, users } from '@/db/schema';
import { withTenant } from '@/db/tenant';
import { consumeApproval } from './approvals';
import { writeAudit } from './audit';
import { assertPermission, type Ctx } from './context';
import { type Fail, fail } from './products';
import { openShiftId } from './shift-link';

const MAX = 100_000_000; // GHS 1,000,000

export type ShiftSummary = {
  shiftId: string; openedAt: Date; openedBy: string; openingCashPesewas: number;
  cashTakenPesewas: number; changeGivenPesewas: number; paidInPesewas: number; paidOutPesewas: number; cashRefundsPesewas: number; debtPaymentsPesewas: number;
  expectedCashPesewas: number; sales: number;
};

/** Spec 6.14: what should be in the drawer now: float + cash taken − change + paid in − paid out − cash given back. */
export async function summarise(tx: Tx, shiftId: string): Promise<ShiftSummary | null> {
  const [s] = await tx.select({ shift: shifts, openedBy: users.name }).from(shifts).innerJoin(users, eq(users.id, shifts.openedBy)).where(eq(shifts.id, shiftId));
  if (!s) return null;
  const done = and(eq(sales.shiftId, shiftId), eq(sales.status, 'completed'));
  const [cash] = await tx.select({ v: sql<string>`coalesce(sum(${payments.amountPesewas}), 0)` }).from(payments)
    .innerJoin(sales, eq(sales.id, payments.saleId)).where(and(done, eq(payments.method, 'cash')));
  const [change] = await tx.select({ v: sql<string>`coalesce(sum(${sales.changeDuePesewas}), 0)`, n: sql<string>`count(*)` }).from(sales).where(done);
  const [moves] = await tx.select({
    paidIn: sql<string>`coalesce(sum(${cashMovements.amountPesewas}) filter (where ${cashMovements.type} = 'paid_in'), 0)`,
    paidOut: sql<string>`coalesce(sum(${cashMovements.amountPesewas}) filter (where ${cashMovements.type} = 'paid_out'), 0)`,
  }).from(cashMovements).where(eq(cashMovements.shiftId, shiftId));
  // the cash part of a return; on an exchange only what was given back beyond the credit used for the new items
  const [refunds] = await tx.select({ v: sql<string>`coalesce(sum(${returns.refundPesewas} - ${returns.exchangeCreditPesewas}), 0)` }).from(returns)
    .where(and(eq(returns.shiftId, shiftId), eq(returns.refundMethod, 'cash')));
  // cash paid towards what customers owe, taken at this till during the shift (spec 6.13)
  const [debts] = await tx.select({ v: sql<string>`coalesce(sum(-${customerLedger.amountPesewas}), 0)` }).from(customerLedger)
    .where(and(eq(customerLedger.shiftId, shiftId), eq(customerLedger.type, 'payment'), eq(customerLedger.method, 'cash')));
  const n = (v: string | undefined) => Number(v ?? 0);
  const r = {
    cashTakenPesewas: n(cash.v), changeGivenPesewas: n(change.v), paidInPesewas: n(moves.paidIn), paidOutPesewas: n(moves.paidOut), cashRefundsPesewas: n(refunds.v), debtPaymentsPesewas: n(debts.v),
  };
  return {
    shiftId, openedAt: s.shift.openedAt, openedBy: s.openedBy, openingCashPesewas: s.shift.openingCashPesewas, ...r, sales: n(change.n),
    expectedCashPesewas: s.shift.openingCashPesewas + r.cashTakenPesewas - r.changeGivenPesewas + r.paidInPesewas - r.paidOutPesewas - r.cashRefundsPesewas + r.debtPaymentsPesewas,
  };
}

/** Spec 6.14: starts the till's shift with the cash float counted into the drawer. */
export async function openShift(db: Db, ctx: Ctx, input: { openingCashPesewas: number }, now: Date): Promise<
  { ok: true; shiftId: string } | Fail<'no_register' | 'invalid_input' | 'shift_already_open'>
> {
  assertPermission(ctx, 'make_sale');
  if (!ctx.registerId) return fail('no_register');
  const float = input.openingCashPesewas;
  if (!Number.isInteger(float) || float < 0 || float > MAX) return fail('invalid_input');
  const registerId = ctx.registerId;
  return withTenant(db, ctx.tenantId, async (tx) => {
    const [reg] = await tx.select({ branchId: registers.branchId }).from(registers).where(eq(registers.id, registerId)).for('update');
    if (!reg) return fail('no_register');
    if (await openShiftId(tx, registerId)) return fail('shift_already_open');
    const [s] = await tx.insert(shifts).values({
      tenantId: ctx.tenantId, branchId: reg.branchId, registerId, openedBy: ctx.userId, openedAt: now, openingCashPesewas: float,
    }).returning({ id: shifts.id });
    await writeAudit(tx, { tenantId: ctx.tenantId, actorType: 'user', actorId: ctx.userId, action: 'shift_opened', recordType: 'shift', recordId: s.id, changes: { openingCashPesewas: float } });
    return { ok: true as const, shiftId: s.id };
  });
}

/** The till's open shift and what should be in its drawer, or null. */
export async function currentShift(db: Db, ctx: Ctx): Promise<ShiftSummary | null> {
  assertPermission(ctx, 'make_sale');
  const registerId = ctx.registerId;
  if (!registerId) return null;
  return withTenant(db, ctx.tenantId, async (tx) => {
    const id = await openShiftId(tx, registerId);
    return id ? summarise(tx, id) : null;
  });
}

/** Spec 6.14: cash put into or taken out of the drawer, with a reason. */
export async function cashMovement(db: Db, ctx: Ctx, input: { type: 'paid_in' | 'paid_out'; amountPesewas: number; reason: string }, now: Date): Promise<
  { ok: true } | Fail<'no_register' | 'no_open_shift' | 'invalid_input'>
> {
  assertPermission(ctx, 'manage_cash');
  if (!ctx.registerId) return fail('no_register');
  const reason = typeof input.reason === 'string' ? input.reason.trim() : '';
  if (!['paid_in', 'paid_out'].includes(input.type) || !Number.isInteger(input.amountPesewas) || input.amountPesewas <= 0 || input.amountPesewas > MAX
    || !reason || reason.length > 200) return fail('invalid_input');
  const registerId = ctx.registerId;
  return withTenant(db, ctx.tenantId, async (tx) => {
    const shiftId = await openShiftId(tx, registerId);
    if (!shiftId) return fail('no_open_shift');
    await tx.insert(cashMovements).values({ tenantId: ctx.tenantId, shiftId, type: input.type, amountPesewas: input.amountPesewas, reason, userId: ctx.userId, createdAt: now });
    await writeAudit(tx, {
      tenantId: ctx.tenantId, actorType: 'user', actorId: ctx.userId, action: input.type === 'paid_in' ? 'cash_paid_in' : 'cash_paid_out', recordType: 'shift', recordId: shiftId,
      reason, changes: { amountPesewas: input.amountPesewas },
    });
    return { ok: true as const };
  });
}

/** The approval context a manager confirms for this shift's variance (spec 6.7). */
export const varianceKey = (shiftId: string, variancePesewas: number) => `${shiftId}:${variancePesewas}`;

/** Spec 6.14: counts the drawer; a variance above the shop's limit needs a reason and, for someone who cannot approve, a manager's PIN. */
export async function closeShift(db: Db, ctx: Ctx, input: { countedCashPesewas: number; reason?: string; approvalToken?: string }, now: Date): Promise<
  { ok: true; summary: ShiftSummary; variancePesewas: number } | Fail<'no_register' | 'no_open_shift' | 'invalid_input' | 'reason_required' | 'approval_required'>
> {
  assertPermission(ctx, 'make_sale');
  if (!ctx.registerId) return fail('no_register');
  const counted = input.countedCashPesewas;
  if (!Number.isInteger(counted) || counted < 0 || counted > MAX) return fail('invalid_input');
  const reason = typeof input.reason === 'string' && input.reason.trim() ? input.reason.trim().slice(0, 200) : null;
  const registerId = ctx.registerId;
  return withTenant(db, ctx.tenantId, async (tx) => {
    const shiftId = await openShiftId(tx, registerId);
    if (!shiftId) return fail('no_open_shift');
    await tx.select({ id: shifts.id }).from(shifts).where(eq(shifts.id, shiftId)).for('update');
    const summary = (await summarise(tx, shiftId))!;
    const variance = counted - summary.expectedCashPesewas;
    const [t] = await tx.select({ limit: tenants.cashVarianceLimitPesewas }).from(tenants).where(eq(tenants.id, ctx.tenantId));
    let approvedBy: string | null = null;
    if (Math.abs(variance) > (t?.limit ?? 0)) {
      if (!reason) return fail('reason_required');
      if (!ctx.permissions.includes('approve_actions')) {
        const a = await consumeApproval(tx, ctx, { token: input.approvalToken ?? '', action: 'cash_variance', contextKey: varianceKey(shiftId, variance) }, now);
        if (!a) return fail('approval_required');
        approvedBy = a.approverId;
      }
    }
    await tx.update(shifts).set({
      status: 'closed', closedBy: ctx.userId, closedAt: now, expectedCashPesewas: summary.expectedCashPesewas, countedCashPesewas: counted,
      variancePesewas: variance, varianceReason: reason, approvedBy,
    }).where(eq(shifts.id, shiftId));
    await writeAudit(tx, {
      tenantId: ctx.tenantId, actorType: 'user', actorId: ctx.userId, action: 'shift_closed', recordType: 'shift', recordId: shiftId, reason: reason ?? undefined,
      changes: { expectedCashPesewas: summary.expectedCashPesewas, countedCashPesewas: counted, variancePesewas: variance, approvedBy },
    });
    return { ok: true as const, summary, variancePesewas: variance };
  });
}

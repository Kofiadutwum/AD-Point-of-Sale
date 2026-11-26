import 'server-only';
import { and, desc, eq, inArray, sql } from 'drizzle-orm';
import type { Db, Tx } from '@/db/client';
import { branches, cashMovements, expenses, type ExpenseMethod, registers, tenants, users } from '@/db/schema';
import { withTenant } from '@/db/tenant';
import { consumeApproval } from './approvals';
import { writeAudit } from './audit';
import { assertPermission, type Ctx } from './context';
import { type Fail, fail, isUuid } from './products';
import { openShiftId } from './shift-link';

const METHODS: readonly ExpenseMethod[] = ['cash', 'momo_manual', 'card_terminal', 'bank_transfer'];
const MAX = 100_000_000;
const myBranches = async (tx: Tx, ctx: Ctx) => (await tx.select({ branchIds: users.branchIds }).from(users).where(eq(users.id, ctx.userId)))[0]?.branchIds ?? [];

/** The approval context a manager confirms for an expense (spec 6.7). */
export const expenseKey = (branchId: string, amountPesewas: number) => `${branchId}:${amountPesewas}`;

/** The branch an expense is recorded at: the till's, else the one chosen (it must be the user's). */
async function expenseBranch(tx: Tx, ctx: Ctx, chosen?: string): Promise<string | null> {
  if (ctx.registerId) return (await tx.select({ branchId: registers.branchId }).from(registers).where(eq(registers.id, ctx.registerId)))[0]?.branchId ?? null;
  const mine = await myBranches(tx, ctx);
  if (chosen) return isUuid(chosen) && mine.includes(chosen) ? chosen : null;
  return mine.length === 1 ? mine[0] : null;
}

/** Spec 6.43: records money spent; above the shop's limit a manager approves; cash at a till with an open shift is paid out of it. */
export async function recordExpense(db: Db, ctx: Ctx, input: {
  branchId?: string; category: string; amountPesewas: number; method: ExpenseMethod; reference?: string; note?: string; approvalToken?: string;
}, now: Date): Promise<{ ok: true; expenseId: string; fromShift: boolean } | Fail<'invalid_input' | 'no_branch' | 'reference_required' | 'approval_required'>> {
  assertPermission(ctx, 'record_expenses');
  const category = typeof input.category === 'string' ? input.category.trim() : '';
  const note = typeof input.note === 'string' && input.note.trim() ? input.note.trim() : null;
  const reference = typeof input.reference === 'string' && input.reference.trim() ? input.reference.trim() : null;
  if (!category || category.length > 60 || (note?.length ?? 0) > 200 || (reference?.length ?? 0) > 100 || !METHODS.includes(input.method)
    || !Number.isInteger(input.amountPesewas) || input.amountPesewas <= 0 || input.amountPesewas > MAX) return fail('invalid_input');
  if (input.method !== 'cash' && !reference) return fail('reference_required');
  return withTenant(db, ctx.tenantId, async (tx) => {
    const branchId = await expenseBranch(tx, ctx, input.branchId);
    if (!branchId) return fail('no_branch');
    const [t] = await tx.select({ limit: tenants.expenseApprovalLimitPesewas }).from(tenants).where(eq(tenants.id, ctx.tenantId));
    let approvedBy: string | null = null;
    if (input.amountPesewas > (t?.limit ?? 0) && !ctx.permissions.includes('approve_actions')) {
      const a = await consumeApproval(tx, ctx, { token: input.approvalToken ?? '', action: 'expense', contextKey: expenseKey(branchId, input.amountPesewas) }, now);
      if (!a) return fail('approval_required');
      approvedBy = a.approverId;
    }
    const shiftId = input.method === 'cash' && ctx.registerId ? await openShiftId(tx, ctx.registerId) : null;
    const [e] = await tx.insert(expenses).values({
      tenantId: ctx.tenantId, branchId, category, amountPesewas: input.amountPesewas, method: input.method, reference: input.method === 'cash' ? null : reference,
      note, recordedBy: ctx.userId, approvedBy, shiftId, createdAt: now,
    }).returning({ id: expenses.id });
    if (shiftId) {
      await tx.insert(cashMovements).values({
        tenantId: ctx.tenantId, shiftId, type: 'paid_out', amountPesewas: input.amountPesewas, reason: `Expense: ${category}`, userId: ctx.userId, expenseId: e.id, createdAt: now,
      });
    }
    await writeAudit(tx, {
      tenantId: ctx.tenantId, actorType: 'user', actorId: ctx.userId, action: 'expense_recorded', recordType: 'expense', recordId: e.id,
      changes: { category, amountPesewas: input.amountPesewas, method: input.method, approvedBy, shiftId },
    });
    return { ok: true as const, expenseId: e.id, fromShift: shiftId !== null };
  });
}

export type ExpenseRow = { id: string; at: Date; branch: string; category: string; amountPesewas: number; method: ExpenseMethod; reference: string | null; note: string | null; by: string };

/** Expenses at the user's branches between two dates (shop time zone), newest first, with the total. */
export async function listExpenses(db: Db, ctx: Ctx, input: { from: string; to: string }): Promise<{ rows: ExpenseRow[]; totalPesewas: number }> {
  assertPermission(ctx, 'record_expenses');
  const day = /^\d{4}-\d{2}-\d{2}$/;
  if (!day.test(input.from) || !day.test(input.to)) return { rows: [], totalPesewas: 0 };
  return withTenant(db, ctx.tenantId, async (tx) => {
    const mine = await myBranches(tx, ctx);
    if (!mine.length) return { rows: [], totalPesewas: 0 };
    const [shop] = await tx.select({ timezone: tenants.timezone }).from(tenants).where(eq(tenants.id, ctx.tenantId));
    const rows = await tx.select({
      id: expenses.id, at: expenses.createdAt, branch: branches.name, category: expenses.category, amountPesewas: expenses.amountPesewas, method: expenses.method,
      reference: expenses.reference, note: expenses.note, by: users.name,
    }).from(expenses).innerJoin(branches, eq(branches.id, expenses.branchId)).innerJoin(users, eq(users.id, expenses.recordedBy))
      .where(and(inArray(expenses.branchId, mine), sql`(${expenses.createdAt} at time zone ${shop.timezone})::date between ${input.from}::date and ${input.to}::date`))
      .orderBy(desc(expenses.createdAt)).limit(500);
    return { rows, totalPesewas: rows.reduce((s, r) => s + r.amountPesewas, 0) };
  });
}

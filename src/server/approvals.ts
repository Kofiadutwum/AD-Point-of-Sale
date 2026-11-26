import 'server-only';
import { and, asc, eq, ne } from 'drizzle-orm';
import type { Db, Tx } from '@/db/client';
import { approvals, users } from '@/db/schema';
import { withTenant } from '@/db/tenant';
import { writeAudit } from './audit';
import type { Ctx } from './context';
import { newToken, tokenHash } from './crypto';
import { verifyStaffPin } from './devices';
import type { Permission } from '@/lib/permissions';
import { type Fail, fail, isUuid } from './products';

export type ApprovalAction = 'refund' | 'refund_other_method' | 'no_receipt_return' | 'dispense_prescription' | 'cash_variance' | 'expense' | 'credit_over_limit' | 'honour_expired_quote' | 'stock_count' | 'stock_adjustment';
const ACTIONS: readonly ApprovalAction[] = ['refund', 'refund_other_method', 'no_receipt_return', 'dispense_prescription', 'cash_variance', 'expense', 'credit_over_limit', 'honour_expired_quote', 'stock_count', 'stock_adjustment'];
/** A pharmacist approves prescription-only medicine (spec 6.36); managers approve everything else. */
const approverPermission = (action: ApprovalAction): Permission => (action === 'dispense_prescription' ? 'dispense_prescription' : 'approve_actions');
const VALID_MS = 2 * 60_000;

type RequestResult = { ok: true; token: string } | Fail<'invalid_input' | 'self_approval' | 'not_authorised' | 'wrong_pin' | 'pin_locked'>;

/** Spec 6.7: another person who may approve, at one of the requester's branches, confirms with their PIN; the token works once, for two minutes, for this action and context only. */
export async function requestApproval(db: Db, ctx: Ctx, input: { action: ApprovalAction; contextKey: string; approverId: string; pin: string }, now: Date): Promise<RequestResult> {
  if (!ACTIONS.includes(input.action) || typeof input.contextKey !== 'string' || !input.contextKey || input.contextKey.length > 200
    || !isUuid(input.approverId) || typeof input.pin !== 'string') return fail('invalid_input');
  if (input.approverId === ctx.userId) return fail('self_approval');
  return withTenant(db, ctx.tenantId, async (tx): Promise<RequestResult> => {
    const [me] = await tx.select({ branchIds: users.branchIds }).from(users).where(eq(users.id, ctx.userId));
    const [approver] = await tx.select().from(users).where(eq(users.id, input.approverId)).for('update');
    if (!approver || approver.status !== 'active' || !approver.permissions.includes(approverPermission(input.action))
      || !approver.branchIds.some((b) => me?.branchIds.includes(b))) return fail('not_authorised');
    const pin = await verifyStaffPin(tx, { tenantId: ctx.tenantId, staff: approver, pin: input.pin, registerId: ctx.registerId ?? null }, now);
    if (pin !== 'ok') return fail(pin);
    const token = newToken();
    await tx.insert(approvals).values({
      tenantId: ctx.tenantId, action: input.action, contextKey: input.contextKey, tokenHash: tokenHash(token), requestedBy: ctx.userId, approvedBy: approver.id,
      expiresAt: new Date(now.getTime() + VALID_MS),
    });
    await writeAudit(tx, { tenantId: ctx.tenantId, actorType: 'user', actorId: approver.id, action: `approved_${input.action}`, changes: { contextKey: input.contextKey, requestedBy: ctx.userId } });
    return { ok: true, token };
  });
}

/** Uses an approval inside the caller's transaction: only the requester, only once, before it expires, for the same action and context. */
export async function consumeApproval(tx: Tx, ctx: Ctx, input: { token: string; action: ApprovalAction; contextKey: string }, now: Date): Promise<{ approverId: string } | null> {
  if (typeof input.token !== 'string' || !input.token) return null;
  const [a] = await tx.select().from(approvals).where(eq(approvals.tokenHash, tokenHash(input.token))).for('update');
  if (!a || a.usedAt || a.expiresAt.getTime() <= now.getTime() || a.requestedBy !== ctx.userId || a.action !== input.action || a.contextKey !== input.contextKey) return null;
  await tx.update(approvals).set({ usedAt: now }).where(eq(approvals.id, a.id));
  return { approverId: a.approvedBy };
}

/** People who could approve for this user: active, not themselves, with a PIN and `approve_actions`, sharing a branch. */
export async function listApprovers(db: Db, ctx: Ctx, permission: Permission = 'approve_actions'): Promise<Array<{ id: string; name: string }>> {
  return withTenant(db, ctx.tenantId, async (tx) => {
    const [me] = await tx.select({ branchIds: users.branchIds }).from(users).where(eq(users.id, ctx.userId));
    const rows = await tx.select({ id: users.id, name: users.name, permissions: users.permissions, branchIds: users.branchIds, pinHash: users.pinHash })
      .from(users).where(and(eq(users.status, 'active'), ne(users.id, ctx.userId))).orderBy(asc(users.name));
    return rows.filter((u) => u.pinHash && u.permissions.includes(permission) && u.branchIds.some((b) => me?.branchIds.includes(b)))
      .map((u) => ({ id: u.id, name: u.name }));
  });
}

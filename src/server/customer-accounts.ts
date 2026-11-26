import 'server-only';
import { asc, desc, eq, gt } from 'drizzle-orm';
import type { Db, Tx } from '@/db/client';
import { customerLedger, customers, type LedgerType, users } from '@/db/schema';
import { withTenant } from '@/db/tenant';
import type { Permission } from '@/lib/permissions';
import { writeAudit } from './audit';
import { AccessError, assertPermission, type Ctx } from './context';
import { type Fail, fail, isUuid } from './products';
import { openShiftId } from './shift-link';

const MAX = 100_000_000;
type PayMethod = 'cash' | 'momo_manual' | 'card_terminal' | 'bank_transfer';
const PAY_METHODS: readonly PayMethod[] = ['cash', 'momo_manual', 'card_terminal', 'bank_transfer'];

const lockCustomer = async (tx: Tx, id: string) =>
  (await tx.select({ id: customers.id, name: customers.name, balance: customers.balancePesewas }).from(customers).where(eq(customers.id, id)).for('update'))[0];

/** Adds one ledger entry and moves the balance with it (the caller holds the customer lock). */
async function post(tx: Tx, ctx: Ctx, e: {
  customerId: string; balance: number; type: LedgerType; amountPesewas: number; now: Date; method?: PayMethod; reference?: string | null; reason?: string | null;
  shiftId?: string | null; approvedBy?: string | null;
}) {
  const balance = e.balance + e.amountPesewas;
  await tx.update(customers).set({ balancePesewas: balance }).where(eq(customers.id, e.customerId));
  await tx.insert(customerLedger).values({
    tenantId: ctx.tenantId, customerId: e.customerId, type: e.type, amountPesewas: e.amountPesewas, balanceAfterPesewas: balance, method: e.method ?? null,
    reference: e.reference ?? null, reason: e.reason ?? null, shiftId: e.shiftId ?? null, userId: ctx.userId, approvedBy: e.approvedBy ?? null, createdAt: e.now,
  });
  return balance;
}

/** Spec 4.5: a manager sets how much a customer may owe (0 = no credit) and whether they agreed to SMS reminders. */
export async function saveCreditTerms(db: Db, ctx: Ctx, input: { customerId: string; creditLimitPesewas: number; reminderConsent: boolean }): Promise<{ ok: true } | Fail<'invalid_input' | 'not_found'>> {
  assertPermission(ctx, 'approve_actions');
  if (!isUuid(input.customerId) || !Number.isInteger(input.creditLimitPesewas) || input.creditLimitPesewas < 0 || input.creditLimitPesewas > MAX
    || typeof input.reminderConsent !== 'boolean') return fail('invalid_input');
  return withTenant(db, ctx.tenantId, async (tx) => {
    const [c] = await tx.update(customers).set({ creditLimitPesewas: input.creditLimitPesewas, reminderConsent: input.reminderConsent })
      .where(eq(customers.id, input.customerId)).returning({ id: customers.id });
    if (!c) return fail('not_found');
    await writeAudit(tx, {
      tenantId: ctx.tenantId, actorType: 'user', actorId: ctx.userId, action: 'credit_terms_saved', recordType: 'customer', recordId: c.id,
      changes: { creditLimitPesewas: input.creditLimitPesewas, reminderConsent: input.reminderConsent },
    });
    return { ok: true as const };
  });
}

/** Spec 6.13: a part payment towards what the customer owes; cash at a till joins its open shift. */
export async function recordDebtPayment(db: Db, ctx: Ctx, input: { customerId: string; amountPesewas: number; method: PayMethod; reference?: string }, now: Date): Promise<
  { ok: true; balancePesewas: number; customerName: string } | Fail<'invalid_input' | 'not_found' | 'invalid_amount' | 'reference_required'>
> {
  assertPermission(ctx, 'receive_debt_payment');
  const reference = typeof input.reference === 'string' && input.reference.trim() ? input.reference.trim().slice(0, 100) : null;
  if (!isUuid(input.customerId) || !PAY_METHODS.includes(input.method) || !Number.isInteger(input.amountPesewas)) return fail('invalid_input');
  if (input.method !== 'cash' && !reference) return fail('reference_required');
  return withTenant(db, ctx.tenantId, async (tx) => {
    const c = await lockCustomer(tx, input.customerId);
    if (!c) return fail('not_found');
    if (input.amountPesewas <= 0 || input.amountPesewas > c.balance) return fail('invalid_amount');
    const shiftId = input.method === 'cash' && ctx.registerId ? await openShiftId(tx, ctx.registerId) : null;
    const balance = await post(tx, ctx, { customerId: c.id, balance: c.balance, type: 'payment', amountPesewas: -input.amountPesewas, now, method: input.method, reference, shiftId });
    await writeAudit(tx, {
      tenantId: ctx.tenantId, actorType: 'user', actorId: ctx.userId, action: 'debt_payment', recordType: 'customer', recordId: c.id,
      changes: { amountPesewas: input.amountPesewas, method: input.method, balance },
    });
    return { ok: true as const, balancePesewas: balance, customerName: c.name };
  });
}

/** Spec 4.5: the ledger is never edited; a manager corrects it with an adjustment and a reason. */
export async function adjustBalance(db: Db, ctx: Ctx, input: { customerId: string; amountPesewas: number; reason: string }, now: Date): Promise<
  { ok: true; balancePesewas: number } | Fail<'invalid_input' | 'not_found' | 'reason_required' | 'invalid_amount'>
> {
  assertPermission(ctx, 'approve_actions');
  const reason = typeof input.reason === 'string' ? input.reason.trim() : '';
  if (!isUuid(input.customerId) || !Number.isInteger(input.amountPesewas) || input.amountPesewas === 0 || Math.abs(input.amountPesewas) > MAX) return fail('invalid_input');
  if (!reason || reason.length > 200) return fail('reason_required');
  return withTenant(db, ctx.tenantId, async (tx) => {
    const c = await lockCustomer(tx, input.customerId);
    if (!c) return fail('not_found');
    if (c.balance + input.amountPesewas < 0) return fail('invalid_amount');
    const balance = await post(tx, ctx, { customerId: c.id, balance: c.balance, type: 'adjustment', amountPesewas: input.amountPesewas, now, reason, approvedBy: ctx.userId });
    await writeAudit(tx, {
      tenantId: ctx.tenantId, actorType: 'user', actorId: ctx.userId, action: 'balance_adjusted', recordType: 'customer', recordId: c.id, reason,
      changes: { amountPesewas: input.amountPesewas, balance },
    });
    return { ok: true as const, balancePesewas: balance };
  });
}

const ACCOUNT_VIEWERS: readonly Permission[] = ['receive_debt_payment', 'sell_on_credit', 'approve_actions'];
const canSeeAccounts = (ctx: Ctx) => {
  if (!ACCOUNT_VIEWERS.some((p) => ctx.permissions.includes(p))) throw new AccessError('forbidden');
};

export type CustomerAccount = {
  customerId: string; name: string; phone: string; creditLimitPesewas: number; balancePesewas: number; reminderConsent: boolean; address: string | null; tin: string | null;
  ledger: Array<{ id: string; at: Date; type: LedgerType; amountPesewas: number; balanceAfterPesewas: number; method: string | null; reference: string | null; reason: string | null; by: string }>;
};

/** A customer's account: limit, balance, and the latest 100 ledger entries, newest first. */
export async function customerAccount(db: Db, ctx: Ctx, customerId: string): Promise<CustomerAccount | null> {
  canSeeAccounts(ctx);
  if (!isUuid(customerId)) return null;
  return withTenant(db, ctx.tenantId, async (tx) => {
    const [c] = await tx.select().from(customers).where(eq(customers.id, customerId));
    if (!c) return null;
    const ledger = await tx.select({
      id: customerLedger.id, at: customerLedger.createdAt, type: customerLedger.type, amountPesewas: customerLedger.amountPesewas, balanceAfterPesewas: customerLedger.balanceAfterPesewas,
      method: customerLedger.method, reference: customerLedger.reference, reason: customerLedger.reason, by: users.name,
    }).from(customerLedger).innerJoin(users, eq(users.id, customerLedger.userId)).where(eq(customerLedger.customerId, customerId))
      .orderBy(desc(customerLedger.createdAt), desc(customerLedger.id)).limit(100);
    return { customerId: c.id, name: c.name, phone: c.phone, creditLimitPesewas: c.creditLimitPesewas, balancePesewas: c.balancePesewas, reminderConsent: c.reminderConsent, address: c.address, tin: c.tin, ledger };
  });
}

export type Debtor = { customerId: string; name: string; phone: string; balancePesewas: number; creditLimitPesewas: number; oldestUnpaidAt: Date | null };

/** Spec 4.5: who owes, oldest unpaid debt first (payments, returns, and reductions settle the oldest credit first). */
export async function listDebtors(db: Db, ctx: Ctx): Promise<Debtor[]> {
  canSeeAccounts(ctx);
  return withTenant(db, ctx.tenantId, async (tx) => {
    const owing = await tx.select().from(customers).where(gt(customers.balancePesewas, 0));
    const out: Debtor[] = [];
    for (const c of owing) {
      const entries = await tx.select({ at: customerLedger.createdAt, amount: customerLedger.amountPesewas }).from(customerLedger)
        .where(eq(customerLedger.customerId, c.id)).orderBy(asc(customerLedger.createdAt), asc(customerLedger.id));
      let credits = entries.filter((e) => e.amount < 0).reduce((s, e) => s - e.amount, 0);
      let oldest: Date | null = null;
      for (const e of entries.filter((x) => x.amount > 0)) {
        if (credits >= e.amount) { credits -= e.amount; continue; }
        oldest = e.at;
        break;
      }
      out.push({ customerId: c.id, name: c.name, phone: c.phone, balancePesewas: c.balancePesewas, creditLimitPesewas: c.creditLimitPesewas, oldestUnpaidAt: oldest });
    }
    return out.sort((a, b) => (a.oldestUnpaidAt?.getTime() ?? Infinity) - (b.oldestUnpaidAt?.getTime() ?? Infinity));
  });
}

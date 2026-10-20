import 'server-only';
import { eq } from 'drizzle-orm';
import { z } from 'zod';
import type { Db, Tx } from '@/db/client';
import { plans, sessions, subscriptionPayments, subscriptions, tenants } from '@/db/schema';
import { asPlatform } from '@/db/tenant';
import { addMonths, maxDate, todayIn } from '@/lib/dates';
import { writeAudit } from './audit';

export type ManualPayment = {
  method: 'momo' | 'bank_transfer' | 'cash' | 'card_terminal'; reference: string; amountPesewas: number; periodMonths: number; planId: string;
};
export type PaymentError = 'duplicate_reference' | 'invalid_payment';
type PaymentResult = { ok: true; endDate: string } | { ok: false; error: PaymentError };

const paymentSchema = z.object({
  method: z.enum(['momo', 'bank_transfer', 'cash', 'card_terminal']),
  // one payment however it is typed: "momo 123" and "MOMO123" are the same reference
  reference: z.string().trim().min(1).max(100).transform((s) => s.replace(/\s+/g, '').toUpperCase()),
  amountPesewas: z.number().int().positive().max(2_147_483_647), // int4 column
  periodMonths: z.number().int().min(1).max(36),
  planId: z.string().min(1),
});

/** Spec 6.20 (manual): records the payment once per reference and extends from the later of end date and today. */
export async function applyManualPayment(tx: Tx, adminId: string, tenantId: string, payment: ManualPayment, now: Date): Promise<PaymentResult> {
  const parsed = paymentSchema.safeParse(payment);
  if (!parsed.success) return { ok: false, error: 'invalid_payment' };
  const p = parsed.data;
  const [plan] = await tx.select({ id: plans.id }).from(plans).where(eq(plans.id, p.planId));
  if (!plan) return { ok: false, error: 'invalid_payment' };

  const inserted = await tx.insert(subscriptionPayments)
    .values({ tenantId, method: p.method, reference: p.reference, amountPesewas: p.amountPesewas, periodMonths: p.periodMonths, planId: p.planId, recordedBy: adminId })
    .onConflictDoNothing({ target: subscriptionPayments.reference })
    .returning({ id: subscriptionPayments.id });
  if (inserted.length === 0) return { ok: false, error: 'duplicate_reference' };

  const [current] = await tx.select({ endDate: subscriptions.endDate, timezone: tenants.timezone })
    .from(subscriptions).innerJoin(tenants, eq(tenants.id, subscriptions.tenantId))
    .where(eq(subscriptions.tenantId, tenantId)).for('update');
  const endDate = addMonths(maxDate(current.endDate, todayIn(current.timezone, now)), p.periodMonths);
  await tx.update(subscriptions).set({ endDate, status: 'active', planId: p.planId, updatedAt: now }).where(eq(subscriptions.tenantId, tenantId));
  await writeAudit(tx, {
    tenantId, actorType: 'platform', actorId: adminId, action: 'subscription_activated',
    changes: { reference: p.reference, amountPesewas: p.amountPesewas, endDate },
  });
  return { ok: true, endDate };
}

export function recordManualPayment(db: Db, adminId: string, tenantId: string, payment: ManualPayment, now: Date): Promise<PaymentResult> {
  return asPlatform(db, (tx) => applyManualPayment(tx, adminId, tenantId, payment, now));
}

/** Suspending also signs everyone in the shop out. */
export async function setShopSuspended(db: Db, adminId: string, tenantId: string, suspended: boolean, reason: string): Promise<void> {
  await asPlatform(db, async (tx) => {
    await tx.update(tenants).set({ status: suspended ? 'suspended' : 'active' }).where(eq(tenants.id, tenantId));
    if (suspended) await tx.delete(sessions).where(eq(sessions.tenantId, tenantId));
    await writeAudit(tx, { tenantId, actorType: 'platform', actorId: adminId, action: suspended ? 'shop_suspended' : 'shop_unsuspended', reason });
  });
}

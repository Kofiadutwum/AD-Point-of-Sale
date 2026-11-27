import 'server-only';
import { randomUUID } from 'node:crypto';
import { and, desc, eq, inArray } from 'drizzle-orm';
import type { Db, Tx } from '@/db/client';
import { plans, processedEvents, subscriptionCheckouts, subscriptionPayments, subscriptions, tenants, users } from '@/db/schema';
import { asPlatform, withTenant } from '@/db/tenant';
import { normaliseEmail } from '@/lib/contact';
import { addMonths, daysBetween, maxDate, todayIn } from '@/lib/dates';
import { formatCedis } from '@/lib/money';
import { subscriptionState } from '@/lib/subscription';
import { writeAudit } from './audit';
import { assertPermission, type Ctx } from './context';
import { sendEmail } from './email';
import { queue } from './notifications';
import type { Paystack } from './paystack';
import { validSignature } from './paystack';
import { type Fail, fail } from './products';
import { openSecret, sealSecret } from './secret-box';

export const PAID_PLANS = ['starter', 'standard', 'pro'] as const;
const PERIOD_MONTHS = 12; // annual subscriptions (spec 5); plan prices are monthly
const appUrl = () => process.env.APP_URL ?? 'http://localhost:3000';

/** The exact wording an owner agrees to for card renewal; stored with the checkout (spec 6.20). */
export const consentWording = (planName: string, annualPesewas: number) =>
  `I agree that ${formatCedis(annualPesewas)} for the ${planName} plan is charged to this card every year on the renewal date, until I turn renewal off on the Billing page.`;

export type BillingOverview = {
  planId: string; planName: string; status: string; state: string; endDate: string; autoRenew: boolean; cardLabel: string | null; ownerEmail: string | null;
  plans: Array<{ id: string; name: string; annualPesewas: number; branches: number; registers: number; staff: number; products: number }>;
  payments: Array<{ reference: string; method: string; amountPesewas: number; at: Date }>;
  lastFailure: string | null;
};

export async function billingOverview(db: Db, ctx: Ctx, now: Date): Promise<BillingOverview> {
  assertPermission(ctx, 'manage_shop_settings', { allowReadOnly: true }); // an expired shop must be able to pay
  return withTenant(db, ctx.tenantId, async (tx) => {
    const [row] = await tx.select({ s: subscriptions, planName: plans.name, tz: tenants.timezone }).from(subscriptions)
      .innerJoin(plans, eq(plans.id, subscriptions.planId)).innerJoin(tenants, eq(tenants.id, subscriptions.tenantId)).where(eq(subscriptions.tenantId, ctx.tenantId));
    const [me] = await tx.select({ email: users.email }).from(users).where(eq(users.id, ctx.userId));
    const paid = await tx.select().from(plans).where(inArray(plans.id, [...PAID_PLANS]));
    const payments = await tx.select().from(subscriptionPayments).orderBy(desc(subscriptionPayments.createdAt)).limit(10);
    const [last] = await tx.select().from(subscriptionCheckouts).orderBy(desc(subscriptionCheckouts.createdAt)).limit(1);
    return {
      planId: row.s.planId, planName: row.planName, status: row.s.status, state: subscriptionState(row.s, todayIn(row.tz, now)), endDate: row.s.endDate,
      autoRenew: row.s.autoRenew, cardLabel: row.s.cardLabel, ownerEmail: me?.email ?? null,
      plans: PAID_PLANS.map((id) => paid.find((p) => p.id === id)).filter((p) => !!p)
        .map((p) => ({ id: p.id, name: p.name, annualPesewas: p.pricePesewas * PERIOD_MONTHS, branches: p.limits.branches, registers: p.limits.registers, staff: p.limits.staff, products: p.limits.products })),
      payments: payments.map((p) => ({ reference: p.reference, method: p.method, amountPesewas: p.amountPesewas, at: p.createdAt })),
      lastFailure: last && (last.status === 'failed' || last.status === 'mismatch') ? last.failureReason ?? last.status : null,
    };
  });
}

/** Spec 6.20: a pending checkout with a unique reference, then Paystack checkout. Nothing is extended until the payment is verified. */
export async function startCheckout(db: Db, ctx: Ctx, input: { planId: string; autoRenew: boolean; email?: string }, now: Date, client: Paystack): Promise<
  { ok: true; authorizationUrl: string; reference: string } | Fail<'invalid_plan' | 'email_required' | 'provider_unavailable'>
> {
  assertPermission(ctx, 'manage_shop_settings', { allowReadOnly: true });
  if (!(PAID_PLANS as readonly string[]).includes(input.planId)) return fail('invalid_plan');
  const prep = await withTenant(db, ctx.tenantId, async (tx) => {
    const [plan] = await tx.select().from(plans).where(eq(plans.id, input.planId));
    const [me] = await tx.select({ email: users.email }).from(users).where(eq(users.id, ctx.userId));
    const [t] = await tx.select({ slug: tenants.slug }).from(tenants).where(eq(tenants.id, ctx.tenantId));
    return { plan, email: me?.email ?? (input.email ? normaliseEmail(input.email) : null), slug: t.slug };
  });
  if (!prep.plan || prep.plan.pricePesewas <= 0) return fail('invalid_plan');
  if (!prep.email) return fail('email_required');
  const amountPesewas = prep.plan.pricePesewas * PERIOD_MONTHS;
  const reference = `SUB-${randomUUID()}`;
  await withTenant(db, ctx.tenantId, (tx) => tx.insert(subscriptionCheckouts).values({
    tenantId: ctx.tenantId, reference, planId: prep.plan.id, amountPesewas, periodMonths: PERIOD_MONTHS, kind: 'checkout', autoRenew: input.autoRenew === true,
    consentText: input.autoRenew ? consentWording(prep.plan.name, amountPesewas) : null, consentBy: input.autoRenew ? ctx.userId : null, createdAt: now,
  }));
  try {
    const r = await client.initialize({ email: prep.email, amountPesewas, reference, callbackUrl: `${appUrl()}/${prep.slug}/app/billing/return`, metadata: { tenantId: ctx.tenantId, planId: prep.plan.id } });
    return { ok: true, authorizationUrl: r.authorizationUrl, reference };
  } catch (e) {
    await asPlatform(db, (tx) => tx.update(subscriptionCheckouts).set({ status: 'failed', failureReason: String(e instanceof Error ? e.message : e).slice(0, 200) }).where(eq(subscriptionCheckouts.reference, reference)));
    return fail('provider_unavailable');
  }
}

type Owners = { shopName: string; emails: string[]; phone: string | null };
async function owners(tx: Tx, tenantId: string): Promise<Owners> {
  const [t] = await tx.select({ name: tenants.name, managerPhone: tenants.managerPhone }).from(tenants).where(eq(tenants.id, tenantId));
  const rows = await tx.select({ email: users.email, phone: users.phone }).from(users).where(and(eq(users.tenantId, tenantId), eq(users.rolePreset, 'owner')));
  return { shopName: t.name, emails: rows.map((r) => r.email).filter((e): e is string => !!e), phone: rows.find((r) => r.phone)?.phone ?? t.managerPhone };
}

/** One billing notice per key, by SMS (the platform's, not the shop's allowance) and email (spec 5: many owners rarely check email). */
export async function notify(db: Db, tenantId: string, key: string, subject: string, text: string, now: Date): Promise<boolean> {
  const who = await asPlatform(db, async (tx) => {
    const fresh = await tx.insert(processedEvents).values({ provider: 'notice', eventType: key, reference: tenantId }).onConflictDoNothing().returning();
    if (!fresh.length) return null;
    const o = await owners(tx, tenantId);
    if (o.phone) await queue(tx, tenantId, { key: `billing:${key}`, kind: 'billing', toPhone: o.phone, body: `${o.shopName}: ${text}`, sendAfter: now });
    return o;
  });
  if (!who) return false;
  for (const to of who.emails) {
    try { await sendEmail({ to, subject: `${who.shopName}: ${subject}`, text }); } catch (e) { console.error('billing email failed', e); }
  }
  return true;
}

export type ApplyResult = 'applied' | 'already' | 'pending' | 'failed' | 'mismatch' | 'unknown';

/** Spec 6.11, 6.20: verifies with Paystack on the server, then extends once per reference (processed event + payment reference are unique). */
export async function applyReference(db: Db, reference: string, now: Date, client: Paystack): Promise<ApplyResult> {
  const [c] = await asPlatform(db, (tx) => tx.select().from(subscriptionCheckouts).where(eq(subscriptionCheckouts.reference, reference)));
  if (!c) return 'unknown';
  if (c.status === 'applied') return 'already';
  let v;
  try { v = await client.verify(reference); } catch { return 'pending'; }
  if (v.status !== 'success') {
    if (['ongoing', 'pending', 'processing', 'queued'].includes(v.status)) return 'pending';
    await asPlatform(db, (tx) => tx.update(subscriptionCheckouts).set({ status: 'failed', failureReason: v.status }).where(and(eq(subscriptionCheckouts.id, c.id), eq(subscriptionCheckouts.status, 'pending'))));
    if (c.kind === 'renewal') await renewalFailed(db, c.tenantId, reference, now);
    return 'failed';
  }
  if (v.amount !== c.amountPesewas || v.currency !== 'GHS' || v.reference !== reference) {
    await asPlatform(db, async (tx) => {
      await tx.update(subscriptionCheckouts).set({ status: 'mismatch', failureReason: `paid ${v.amount} ${v.currency}` }).where(eq(subscriptionCheckouts.id, c.id));
      await writeAudit(tx, { tenantId: c.tenantId, actorType: 'system', actorId: null, action: 'subscription_payment_mismatch', reason: 'amount or currency differ', changes: { reference, expected: c.amountPesewas, paid: v.amount, currency: v.currency } });
    });
    return 'mismatch';
  }
  const done = await asPlatform(db, async (tx) => {
    const first = await tx.insert(processedEvents).values({ provider: 'paystack', eventType: 'charge.success', reference }).onConflictDoNothing().returning();
    if (!first.length) return null;
    const [locked] = await tx.select().from(subscriptionCheckouts).where(eq(subscriptionCheckouts.id, c.id)).for('update');
    if (locked.status === 'applied') return null;
    await tx.insert(subscriptionPayments).values({ tenantId: c.tenantId, method: 'paystack', reference, amountPesewas: c.amountPesewas, periodMonths: c.periodMonths, planId: c.planId });
    const [cur] = await tx.select({ s: subscriptions, tz: tenants.timezone }).from(subscriptions).innerJoin(tenants, eq(tenants.id, subscriptions.tenantId))
      .where(eq(subscriptions.tenantId, c.tenantId)).for('update');
    const endDate = addMonths(maxDate(cur.s.endDate, todayIn(cur.tz, now)), c.periodMonths);
    const auth = v.authorization;
    const keepCard = c.kind === 'renewal' ? cur.s.autoRenew : c.autoRenew;
    const card = keepCard && auth?.reusable && auth.authorization_code
      ? { authorizationCode: sealSecret(auth.authorization_code), cardLabel: `${auth.brand ?? 'card'} ending ${auth.last4 ?? '????'}`, billingEmail: v.customer?.email ?? cur.s.billingEmail }
      : c.kind === 'renewal' ? {} : { authorizationCode: null, cardLabel: null };
    await tx.update(subscriptions).set({ endDate, status: 'active', planId: c.planId, autoRenew: keepCard && (c.kind === 'renewal' || !!auth?.reusable), updatedAt: now, ...card })
      .where(eq(subscriptions.tenantId, c.tenantId));
    await tx.update(subscriptionCheckouts).set({ status: 'applied', appliedAt: now }).where(eq(subscriptionCheckouts.id, c.id));
    await writeAudit(tx, { tenantId: c.tenantId, actorType: 'system', actorId: null, action: 'subscription_paid', changes: { reference, amountPesewas: c.amountPesewas, planId: c.planId, endDate, kind: c.kind } });
    return endDate;
  });
  if (!done) return 'already';
  await notify(db, c.tenantId, `receipt:${reference}`, 'payment received', `Payment of ${formatCedis(c.amountPesewas)} received. Your subscription now runs to ${done}. Reference ${reference}.`, now);
  return 'applied';
}

async function renewalFailed(db: Db, tenantId: string, reference: string, now: Date) {
  await notify(db, tenantId, `renewal-failed:${reference}`, 'renewal payment failed',
    `We could not charge your card for the yearly renewal. Pay by card or mobile money on the Billing page to keep selling: ${appUrl()}`, now);
}

/** Spec 6.11: checks the signature on the raw bytes before parsing. Processing runs inline; the processed-event key makes redelivery harmless. */
export async function handleWebhook(db: Db, raw: Uint8Array, signature: string | null, now: Date, client: Paystack): Promise<{ status: 200 | 400 | 401 }> {
  if (!validSignature(raw, signature)) return { status: 401 };
  let event: { event?: string; data?: { reference?: string } };
  try { event = JSON.parse(Buffer.from(raw).toString('utf8')); } catch { return { status: 400 }; }
  const reference = event.data?.reference;
  if ((event.event === 'charge.success' || event.event === 'charge.failed') && typeof reference === 'string') await applyReference(db, reference, now, client);
  return { status: 200 };
}

/** The owner turns card renewal off; the stored authorisation is dropped. */
export async function cancelAutoRenew(db: Db, ctx: Ctx): Promise<{ ok: true }> {
  assertPermission(ctx, 'manage_shop_settings', { allowReadOnly: true });
  await withTenant(db, ctx.tenantId, async (tx) => {
    await tx.update(subscriptions).set({ autoRenew: false, authorizationCode: null, cardLabel: null }).where(eq(subscriptions.tenantId, ctx.tenantId));
    await writeAudit(tx, { tenantId: ctx.tenantId, actorType: 'user', actorId: ctx.userId, action: 'auto_renew_cancelled' });
  });
  return { ok: true };
}

/** Spec 6.20, 6.48: run daily (keys make more frequent runs harmless): reminders, card renewal on the end date, expiry and read-only notices. */
export async function runBillingJob(db: Db, now: Date, client: Paystack): Promise<{ notices: number; renewals: number }> {
  const rows = await asPlatform(db, (tx) => tx.select({ s: subscriptions, tz: tenants.timezone, planName: plans.name, price: plans.pricePesewas }).from(subscriptions)
    .innerJoin(tenants, eq(tenants.id, subscriptions.tenantId)).innerJoin(plans, eq(plans.id, subscriptions.planId)).where(eq(tenants.status, 'active')));
  let notices = 0;
  let renewals = 0;
  const billing = `${appUrl()}`;
  for (const { s, tz, planName, price } of rows) {
    const days = daysBetween(todayIn(tz, now), s.endDate);
    const say = async (key: string, subject: string, text: string) => { if (await notify(db, s.tenantId, `${key}:${s.endDate}`, subject, text, now)) notices++; };
    if (s.status === 'trial') {
      if (days === 3 || days === 1) await say(`trial-${days}`, 'free trial ending', `Your free trial ends in ${days} day${days === 1 ? '' : 's'} (${s.endDate}). Choose a plan on the Billing page to keep selling.`);
      if (days === -1) await say('trial-ended', 'free trial ended', 'Your free trial has ended. Your records are safe; choose a plan on the Billing page to sell again.');
      continue;
    }
    const annual = price * PERIOD_MONTHS;
    const card = s.autoRenew && s.authorizationCode && s.billingEmail;
    if ([30, 7, 1].includes(days)) {
      await say(`reminder-${days}`, 'renewal reminder', card
        ? `Your ${planName} plan renews on ${s.endDate}: ${formatCedis(annual)} will be charged to your ${s.cardLabel}. Turn renewal off on the Billing page to cancel.`
        : `Your ${planName} plan ends on ${s.endDate}. Renew for ${formatCedis(annual)} by card or mobile money on the Billing page: ${billing}`);
    }
    if (days <= 0 && card) {
      const reference = `REN-${s.id}-${s.endDate}`; // one charge attempt per end date
      const fresh = await asPlatform(db, (tx) => tx.insert(subscriptionCheckouts).values({
        tenantId: s.tenantId, reference, planId: s.planId, amountPesewas: annual, periodMonths: PERIOD_MONTHS, kind: 'renewal', autoRenew: true, createdAt: now,
      }).onConflictDoNothing().returning());
      if (fresh.length && annual > 0) {
        renewals++;
        const code = openSecret(s.authorizationCode!);
        try {
          if (!code) throw new Error('card authorisation unreadable');
          await client.chargeAuthorization({ authorizationCode: code, email: s.billingEmail!, amountPesewas: annual, reference });
          await applyReference(db, reference, now, client); // the webhook may also arrive; applying twice is harmless
        } catch (e) {
          await asPlatform(db, (tx) => tx.update(subscriptionCheckouts).set({ status: 'failed', failureReason: String(e instanceof Error ? e.message : e).slice(0, 200) }).where(eq(subscriptionCheckouts.reference, reference)));
          await renewalFailed(db, s.tenantId, reference, now);
        }
      }
    }
    if (days === -1) await say('expired', 'subscription expired', `Your subscription ended on ${s.endDate}. You can keep selling for ${s.graceDays} more days; renew on the Billing page.`);
    if (days === -(s.graceDays + 1)) await say('read-only', 'shop is read-only', 'Your shop is now read-only: you can view and export records but not sell. Renew on the Billing page to sell again; nothing was deleted.');
  }
  return { notices, renewals };
}

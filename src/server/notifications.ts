import 'server-only';
import { and, asc, eq, gt, gte, isNotNull, lte, ne, sql } from 'drizzle-orm';
import type { Db, Tx } from '@/db/client';
import { notifications, payments, plans, products, returns, sales, shifts, stockBalances, stockBatches, subscriptions, tenants, variants } from '@/db/schema';
import { asPlatform, withTenant } from '@/db/tenant';
import { addDays, businessDate, todayIn } from '@/lib/dates';
import { formatCedis } from '@/lib/money';
import { smsParts } from '@/lib/sms-text';
import { assertPermission, type Ctx } from './context';
import { itemLabel } from './products';
import type { SendSms } from './sms';

const METHOD_NAMES: Record<string, string> = { cash: 'Cash', momo_manual: 'MoMo', card_terminal: 'Card', bank_transfer: 'Bank', credit: 'Credit', store_credit: 'Store credit', exchange_credit: 'Exchange', channel_settlement: 'Delivery apps' };
const localClock = (timeZone: string, at: Date) => {
  const parts = new Intl.DateTimeFormat('en-GB', { timeZone, hour: '2-digit', minute: '2-digit', weekday: 'short', hourCycle: 'h23' }).formatToParts(at);
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? '';
  return { time: `${get('hour')}:${get('minute')}`, weekday: ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].indexOf(get('weekday')) };
};
const dayBounds = (date: string) => [new Date(`${date}T00:00:00Z`), new Date(`${addDays(date, 1)}T00:00:00Z`)] as const; // UTC is Ghana time

/** Spec 6.15: completed sales of one business day, refunds, payment methods, and closed-shift cash differences, in one or two SMS parts. */
export async function dailySummary(tx: Tx, shopName: string, date: string): Promise<string> {
  const done = and(eq(sales.status, 'completed'), eq(sales.businessDate, date));
  const [s] = await tx.select({ n: sql<number>`count(*)::int`, total: sql<number>`coalesce(sum(${sales.totalPesewas}), 0)::int`, discount: sql<number>`coalesce(sum(${sales.discountPesewas}), 0)::int` }).from(sales).where(done);
  const byMethod = await tx.select({ m: payments.method, amount: sql<number>`sum(${payments.amountPesewas})::int` }).from(payments).innerJoin(sales, eq(sales.id, payments.saleId)).where(done).groupBy(payments.method);
  const [from, to] = dayBounds(date);
  const [r] = await tx.select({ amount: sql<number>`coalesce(sum(${returns.refundPesewas}), 0)::int` }).from(returns).where(and(gte(returns.createdAt, from), lte(returns.createdAt, to)));
  const [v] = await tx.select({ amount: sql<number>`coalesce(sum(${shifts.variancePesewas}), 0)::int`, n: sql<number>`count(*)::int` }).from(shifts).where(and(isNotNull(shifts.closedAt), gte(shifts.closedAt, from), lte(shifts.closedAt, to)));
  const [review] = await tx.select({ n: sql<number>`count(*)::int` }).from(sales).where(and(eq(sales.businessDate, date), eq(sales.needsReview, true)));
  const lines = [
    `${shopName} ${date}`,
    `Sales ${formatCedis(s.total)} (${s.n}), refunds ${formatCedis(r.amount)}, net ${formatCedis(s.total - r.amount)}`,
    byMethod.map((x) => `${METHOD_NAMES[x.m] ?? x.m} ${formatCedis(x.amount)}`).join(', '),
    s.discount > 0 ? `Discounts ${formatCedis(s.discount)}` : '',
    v.n > 0 ? `Cash difference ${formatCedis(v.amount)}` : '',
    review.n > 0 ? `${review.n} sales need review` : '',
  ];
  return lines.filter(Boolean).join('\n');
}

/** Spec 6.16: low, out-of-stock, and near-expiry counts with the first few items; full lists are on the dashboard. */
export async function weeklyStockSummary(tx: Tx, shopName: string, today: string, warningDays: number): Promise<string> {
  const rows = await tx.select({ p: products.name, v: variants.name, onHand: stockBalances.onHand, reorder: variants.reorderLevel })
    .from(stockBalances).innerJoin(variants, eq(variants.id, stockBalances.variantId)).innerJoin(products, eq(products.id, variants.productId))
    .where(and(eq(variants.status, 'active'), sql`(${stockBalances.onHand} <= 0 or ${stockBalances.onHand} <= ${variants.reorderLevel})`)).orderBy(asc(stockBalances.onHand));
  const out = rows.filter((x) => Number(x.onHand) <= 0);
  const low = rows.filter((x) => Number(x.onHand) > 0);
  const [exp] = await tx.select({ n: sql<number>`count(*)::int` }).from(stockBatches)
    .where(and(gt(stockBatches.onHand, '0'), lte(stockBatches.expiryDate, addDays(today, warningDays))));
  const top = rows.slice(0, 5).map((x) => `${itemLabel(x.p, x.v)} ${Number(x.onHand)}`).join(', ');
  return [`${shopName} stock ${today}`, `Out of stock ${out.length}, low ${low.length}, near expiry batches ${exp.n}`, top ? `Reorder: ${top}` : 'Nothing to reorder', rows.length > 5 ? 'Full list: dashboard' : '']
    .filter(Boolean).join('\n');
}

export async function queue(tx: Tx, tenantId: string, n: { key: string; kind: 'report' | 'marketing' | 'billing'; toPhone: string; body: string; sendAfter: Date }) {
  await tx.insert(notifications).values({ tenantId, ...n, parts: smsParts(n.body) }).onConflictDoNothing();
}
const queued = async (tx: Tx, key: string) => (await tx.select({ id: notifications.id }).from(notifications).where(eq(notifications.key, key))).length > 0;

/** Spec 6.15, 6.16: run every 15 minutes; once a shop's report time has passed, queue today's report (and the weekly one on its day). Keys stop doubles. */
export async function queueDueReports(db: Db, now: Date): Promise<number> {
  const shops = await asPlatform(db, (tx) => tx.select().from(tenants).where(and(eq(tenants.smsReports, true), eq(tenants.status, 'active'), isNotNull(tenants.managerPhone))));
  let made = 0;
  for (const t of shops) {
    const clock = localClock(t.timezone, now);
    if (clock.time < t.reportTime) continue;
    const date = businessDate(t.timezone, t.businessDayCutoff, now);
    const today = todayIn(t.timezone, now);
    await withTenant(db, t.id, async (tx) => {
      if (!(await queued(tx, `daily:${date}`))) {
        await queue(tx, t.id, { key: `daily:${date}`, kind: 'report', toPhone: t.managerPhone!, body: await dailySummary(tx, t.name, date), sendAfter: now });
        made++;
      }
      if (clock.weekday === t.weeklyReportDay && !(await queued(tx, `weekly:${today}`))) {
        await queue(tx, t.id, { key: `weekly:${today}`, kind: 'report', toPhone: t.managerPhone!, body: await weeklyStockSummary(tx, t.name, today, t.expiryWarningDays), sendAfter: now });
        made++;
      }
    });
  }
  return made;
}

const monthStart = (now: Date) => new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
async function allowance(tx: Tx, tenantId: string, now: Date): Promise<{ usedParts: number; limitParts: number }> {
  const [plan] = await tx.select({ limits: plans.limits }).from(subscriptions).innerJoin(plans, eq(plans.id, subscriptions.planId)).where(eq(subscriptions.tenantId, tenantId));
  const [u] = await tx.select({ n: sql<number>`coalesce(sum(${notifications.parts}), 0)::int` }).from(notifications)
    .where(and(eq(notifications.tenantId, tenantId), eq(notifications.status, 'sent'), ne(notifications.kind, 'billing'), gte(notifications.sentAt, monthStart(now))));
  return { usedParts: u.n, limitParts: plan?.limits.sms_per_month ?? 0 };
}

/** SMS parts used this calendar month and the plan's allowance (spec 4.8). */
export async function smsUsage(db: Db, ctx: Ctx, now: Date) {
  assertPermission(ctx, 'marketing');
  return withTenant(db, ctx.tenantId, (tx) => allowance(tx, ctx.tenantId, now));
}
export const remainingParts = (tx: Tx, tenantId: string, now: Date) => allowance(tx, tenantId, now).then((a) => a.limitParts - a.usedParts);

const MAX_ATTEMPTS = 3;

/** Spec 6.17: sends due SMS oldest first; past the allowance they are blocked, not sent; temporary failures retry 3 times, 5 minutes apart. */
export async function runNotifications(db: Db, now: Date, send: SendSms, batch = 100): Promise<{ sent: number; failed: number; blocked: number }> {
  const due = await asPlatform(db, (tx) => tx.select().from(notifications).where(and(eq(notifications.status, 'queued'), lte(notifications.sendAfter, now)))
    .orderBy(asc(notifications.createdAt)).limit(batch));
  const out = { sent: 0, failed: 0, blocked: 0 };
  for (const n of due) {
    await withTenant(db, n.tenantId, async (tx) => {
      const a = await allowance(tx, n.tenantId, now);
      if (n.kind !== 'billing' && a.usedParts + n.parts > a.limitParts) {
        await tx.update(notifications).set({ status: 'blocked_quota' }).where(eq(notifications.id, n.id));
        out.blocked++;
        return;
      }
      try {
        await send(n.toPhone, n.body);
        await tx.update(notifications).set({ status: 'sent', sentAt: now, attempts: n.attempts + 1, error: null }).where(eq(notifications.id, n.id));
        out.sent++;
      } catch (e) {
        const attempts = n.attempts + 1;
        await tx.update(notifications).set({
          attempts, error: String(e instanceof Error ? e.message : e).slice(0, 200),
          ...(attempts >= MAX_ATTEMPTS ? { status: 'failed' as const } : { sendAfter: new Date(now.getTime() + 5 * 60_000) }),
        }).where(eq(notifications.id, n.id));
        out.failed++;
      }
    });
  }
  return out;
}

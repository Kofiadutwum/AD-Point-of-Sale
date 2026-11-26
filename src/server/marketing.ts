import 'server-only';
import { and, desc, eq, isNotNull, sql } from 'drizzle-orm';
import type { Db, Tx } from '@/db/client';
import { type CampaignSegment, customers, marketingOptOuts, notifications, sales, smsCampaigns, tenants } from '@/db/schema';
import { asPlatform, withTenant } from '@/db/tenant';
import { normaliseGhanaPhone } from '@/lib/contact';
import { smsParts } from '@/lib/sms-text';
import { writeAudit } from './audit';
import { assertPermission, type Ctx } from './context';
import { remainingParts } from './notifications';
import { type Fail, fail, isUuid } from './products';

export const SEGMENTS: Record<CampaignSegment, string> = {
  all: 'Everyone who agreed', recent: 'Bought in the last 30 days', lapsed: 'Bought before, but not in the last 60 days',
};
const MAX_MESSAGE = 300;
const day = 86_400_000;

const optOutLink = (slug: string) => `${process.env.APP_URL ?? 'http://localhost:3000'}/${slug}/stop`;
const fullMessage = (message: string, slug: string) => `${message}\nStop these SMS: ${optOutLink(slug)}`;

/** Opted in, not opted out, and in the segment (spec 6.42). */
async function recipients(tx: Tx, tenantId: string, segment: CampaignSegment, now: Date) {
  const last = new Map((await tx.select({ id: sales.customerId, at: sql<string>`max(${sales.receivedAt})` }).from(sales)
    .where(and(eq(sales.status, 'completed'), isNotNull(sales.customerId))).groupBy(sales.customerId)).map((x) => [x.id, x.at]));
  const stopped = new Set((await tx.select({ phone: marketingOptOuts.phone }).from(marketingOptOuts).where(eq(marketingOptOuts.tenantId, tenantId))).map((x) => x.phone));
  const rows = (await tx.select({ id: customers.id, phone: customers.phone }).from(customers).where(eq(customers.marketingConsent, true)))
    .filter((r) => !stopped.has(r.phone)).map((r) => ({ ...r, last: last.get(r.id) ?? null }));
  const at = (d: string | null) => (d === null ? null : new Date(d).getTime());
  return rows.filter((r) => segment === 'all'
    || (segment === 'recent' && at(r.last) !== null && at(r.last)! >= now.getTime() - 30 * day)
    || (segment === 'lapsed' && at(r.last) !== null && at(r.last)! < now.getTime() - 60 * day));
}

/** No promotional SMS between 21:00 and 07:00 shop time: such sends move to 07:00 (spec 4.25). */
export function outsideQuietHours(timeZone: string, at: Date): Date {
  const [h, m] = new Intl.DateTimeFormat('en-GB', { timeZone, hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(at).split(':').map(Number);
  const mins = h * 60 + m;
  const wait = mins >= 21 * 60 ? 24 * 60 - mins + 7 * 60 : mins < 7 * 60 ? 7 * 60 - mins : 0;
  return wait === 0 ? at : new Date(Math.floor(at.getTime() / 60_000) * 60_000 + wait * 60_000);
}

type Input = { segment: CampaignSegment; message: string };
const valid = (i: Input) => Object.hasOwn(SEGMENTS, i.segment) && typeof i.message === 'string' && i.message.trim().length > 0 && i.message.trim().length <= MAX_MESSAGE;

export type CampaignPreview = { recipients: number; partsEach: number; totalParts: number; remainingParts: number; text: string; sendAfter: Date };

/** The cost before sending: recipients times SMS parts, against what is left this month (spec 6.42). */
export async function previewCampaign(db: Db, ctx: Ctx, input: Input, now: Date): Promise<{ ok: true; preview: CampaignPreview } | Fail<'invalid_input'>> {
  assertPermission(ctx, 'marketing');
  if (!valid(input)) return fail('invalid_input');
  return withTenant(db, ctx.tenantId, async (tx) => {
    const { list: _list, ...p } = await preview(tx, ctx, input, now);
    return { ok: true as const, preview: p };
  });
}

async function preview(tx: Tx, ctx: Ctx, input: Input, now: Date): Promise<CampaignPreview & { list: Array<{ id: string; phone: string }> }> {
  const [t] = await tx.select({ slug: tenants.slug, timezone: tenants.timezone }).from(tenants).where(eq(tenants.id, ctx.tenantId));
  const text = fullMessage(input.message.trim(), t.slug);
  const list = await recipients(tx, ctx.tenantId, input.segment, now);
  const partsEach = smsParts(text);
  return { recipients: list.length, partsEach, totalParts: list.length * partsEach, remainingParts: await remainingParts(tx, ctx.tenantId, now), text, sendAfter: outsideQuietHours(t.timezone, now), list };
}

/** Spec 6.42: queues one SMS per recipient after the user saw the cost; refused when it would pass the month's allowance. */
export async function sendCampaign(db: Db, ctx: Ctx, input: Input & { confirmedParts: number }, now: Date): Promise<
  { ok: true; campaignId: string; recipients: number; sendAfter: Date } | Fail<'invalid_input' | 'no_recipients' | 'over_allowance' | 'cost_changed'>
> {
  assertPermission(ctx, 'marketing');
  if (!valid(input)) return fail('invalid_input');
  return withTenant(db, ctx.tenantId, async (tx) => {
    const p = await preview(tx, ctx, input, now);
    if (p.recipients === 0) return fail('no_recipients');
    if (p.totalParts !== input.confirmedParts) return fail('cost_changed');
    if (p.totalParts > p.remainingParts) return fail('over_allowance');
    const [c] = await tx.insert(smsCampaigns).values({
      tenantId: ctx.tenantId, segment: input.segment, message: input.message.trim(), recipients: p.recipients, parts: p.totalParts, sendAfter: p.sendAfter, createdBy: ctx.userId,
    }).returning({ id: smsCampaigns.id });
    await tx.insert(notifications).values(p.list.map((r) => ({
      tenantId: ctx.tenantId, key: `campaign:${c.id}:${r.id}`, kind: 'marketing' as const, toPhone: r.phone, body: p.text, parts: p.partsEach, sendAfter: p.sendAfter,
    })));
    await writeAudit(tx, { tenantId: ctx.tenantId, actorType: 'user', actorId: ctx.userId, action: 'sms_campaign_sent', recordType: 'sms_campaign', recordId: c.id, changes: { segment: input.segment, recipients: p.recipients, parts: p.totalParts } });
    return { ok: true as const, campaignId: c.id, recipients: p.recipients, sendAfter: p.sendAfter };
  });
}

export async function listCampaigns(db: Db, ctx: Ctx) {
  assertPermission(ctx, 'marketing');
  return withTenant(db, ctx.tenantId, async (tx) => {
    const campaignOf = sql<string>`split_part(${notifications.key}, ':', 2)`;
    const sent = new Map((await tx.select({ id: campaignOf, n: sql<number>`count(*)::int` }).from(notifications)
      .where(and(eq(notifications.kind, 'marketing'), eq(notifications.status, 'sent'))).groupBy(campaignOf)).map((x) => [x.id, x.n]));
    return (await tx.select().from(smsCampaigns).orderBy(desc(smsCampaigns.createdAt)).limit(20)).map((c) => ({ ...c, sent: sent.get(c.id) ?? 0 }));
  });
}

/** A customer agrees to, or withdraws from, promotional SMS. */
export async function setMarketingConsent(db: Db, ctx: Ctx, customerId: string, consent: boolean): Promise<{ ok: true } | Fail<'invalid_input' | 'not_found' | 'opted_out'>> {
  assertPermission(ctx, 'marketing');
  if (!isUuid(customerId) || typeof consent !== 'boolean') return fail('invalid_input');
  return withTenant(db, ctx.tenantId, async (tx) => {
    const [c] = await tx.select({ phone: customers.phone }).from(customers).where(eq(customers.id, customerId));
    if (!c) return fail('not_found');
    // An opt-out sent by the customer stands; staff cannot override it.
    if (consent && (await tx.select({ phone: marketingOptOuts.phone }).from(marketingOptOuts).where(eq(marketingOptOuts.phone, c.phone))).length) return fail('opted_out');
    await tx.update(customers).set({ marketingConsent: consent }).where(eq(customers.id, customerId));
    await writeAudit(tx, { tenantId: ctx.tenantId, actorType: 'user', actorId: ctx.userId, action: 'marketing_consent_saved', recordType: 'customer', recordId: customerId, changes: { consent } });
    return { ok: true as const };
  });
}

/** Public: a phone number stops this shop's promotional SMS for good; receipts and reports still go (spec 6.42). */
export async function optOut(db: Db, slug: string, phoneText: string, now: Date): Promise<{ ok: true } | Fail<'invalid_phone' | 'not_found'>> {
  const phone = normaliseGhanaPhone(phoneText);
  if (!phone) return fail('invalid_phone');
  const [t] = await asPlatform(db, (tx) => tx.select({ id: tenants.id }).from(tenants).where(eq(tenants.slug, slug)));
  if (!t) return fail('not_found');
  return withTenant(db, t.id, async (tx) => {
    await tx.insert(marketingOptOuts).values({ tenantId: t.id, phone, createdAt: now }).onConflictDoNothing();
    await tx.update(customers).set({ marketingConsent: false }).where(eq(customers.phone, phone));
    await tx.update(notifications).set({ status: 'failed', error: 'opted out' }).where(and(eq(notifications.toPhone, phone), eq(notifications.kind, 'marketing'), eq(notifications.status, 'queued')));
    return { ok: true as const };
  });
}

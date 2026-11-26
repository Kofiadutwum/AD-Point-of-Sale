import 'server-only';
import { and, count, desc, eq, gt, isNull, like, lte, sql } from 'drizzle-orm';
import type { Db, Tx } from '@/db/client';
import { auditLog, customers, products, sales, supportSessions, tenants, users } from '@/db/schema';
import { asPlatform, withTenant } from '@/db/tenant';
import { businessDate } from '@/lib/dates';
import { writeAudit } from './audit';
import { AccessError, assertPermission, type Ctx } from './context';
import { sendEmail } from './email';
import { requirePlatformAdmin } from './platform-admin';
import { type Fail, fail, isUuid } from './products';

const HOUR = 3_600_000;
const EMERGENCY_HOURS = 2;
const active = (now: Date) => and(isNull(supportSessions.revokedAt), lte(supportSessions.startsAt, now), gt(supportSessions.expiresAt, now));

/** Spec 6.47: the owner lets platform support view the shop for up to 72 hours. */
export async function grantSupportAccess(db: Db, ctx: Ctx, input: { hours: number; reason: string }, now: Date): Promise<{ ok: true; sessionId: string; expiresAt: Date } | Fail<'invalid_input'>> {
  assertPermission(ctx, 'manage_shop_settings');
  const reason = typeof input.reason === 'string' ? input.reason.trim() : '';
  if (!Number.isInteger(input.hours) || input.hours < 1 || input.hours > 72 || reason.length < 3 || reason.length > 200) return fail('invalid_input');
  const expiresAt = new Date(now.getTime() + input.hours * HOUR);
  return withTenant(db, ctx.tenantId, async (tx) => {
    const [s] = await tx.insert(supportSessions).values({ tenantId: ctx.tenantId, grantedBy: ctx.userId, reason, startsAt: now, expiresAt }).returning({ id: supportSessions.id });
    await writeAudit(tx, { tenantId: ctx.tenantId, actorType: 'user', actorId: ctx.userId, action: 'support_access_granted', recordType: 'support_session', recordId: s.id, reason, changes: { hours: input.hours } });
    return { ok: true as const, sessionId: s.id, expiresAt };
  });
}

/** The owner ends a support session (theirs or an emergency one) at once. */
export async function revokeSupportAccess(db: Db, ctx: Ctx, sessionId: string, now: Date): Promise<{ ok: true } | Fail<'not_found'>> {
  assertPermission(ctx, 'manage_shop_settings');
  if (!isUuid(sessionId)) return fail('not_found');
  return withTenant(db, ctx.tenantId, async (tx) => {
    const [s] = await tx.update(supportSessions).set({ revokedAt: now }).where(and(eq(supportSessions.id, sessionId), active(now))).returning({ id: supportSessions.id });
    if (!s) return fail('not_found');
    await writeAudit(tx, { tenantId: ctx.tenantId, actorType: 'user', actorId: ctx.userId, action: 'support_access_revoked', recordType: 'support_session', recordId: s.id });
    return { ok: true as const };
  });
}

/** For the owner: sessions, newest first, and what support did (spec 4.29: every action is in the shop's audit log). */
export async function supportHistory(db: Db, ctx: Ctx, now: Date) {
  assertPermission(ctx, 'manage_shop_settings');
  return withTenant(db, ctx.tenantId, async (tx) => ({
    sessions: (await tx.select().from(supportSessions).orderBy(desc(supportSessions.startsAt)).limit(20))
      .map((s) => ({ ...s, isActive: !s.revokedAt && s.startsAt <= now && s.expiresAt > now })),
    actions: await tx.select({ at: auditLog.createdAt, action: auditLog.action, reason: auditLog.reason, changes: auditLog.changes }).from(auditLog)
      .where(and(eq(auditLog.actorType, 'platform'), like(auditLog.action, 'platform_support%'))).orderBy(desc(auditLog.createdAt)).limit(50),
  }));
}

const activeSession = async (tx: Tx, tenantId: string, now: Date) =>
  (await tx.select().from(supportSessions).where(and(eq(supportSessions.tenantId, tenantId), active(now))).orderBy(desc(supportSessions.expiresAt)).limit(1))[0] ?? null;

/** For the admin shop page: the window support may use now, if any. */
export async function currentSupportSession(db: Db, adminToken: string | undefined, tenantId: string, now: Date) {
  await requirePlatformAdmin(db, adminToken, now);
  return asPlatform(db, (tx) => activeSession(tx, tenantId, now));
}

/** Spec 6.47: without an owner's grant, support may open a 2-hour emergency window with a written reason; the owner is told at once. */
export async function openEmergencyAccess(db: Db, adminToken: string | undefined, tenantId: string, reason: string, now: Date): Promise<{ ok: true } | Fail<'reason_required' | 'not_found'>> {
  const admin = await requirePlatformAdmin(db, adminToken, now);
  const why = typeof reason === 'string' ? reason.trim() : '';
  if (why.length < 20 || why.length > 500) return fail('reason_required');
  if (!isUuid(tenantId)) return fail('not_found');
  const owners = await asPlatform(db, async (tx) => {
    const [t] = await tx.select({ id: tenants.id, name: tenants.name }).from(tenants).where(eq(tenants.id, tenantId));
    if (!t) return null;
    const [s] = await tx.insert(supportSessions).values({ tenantId, adminId: admin.adminId, reason: why, emergency: true, startsAt: now, expiresAt: new Date(now.getTime() + EMERGENCY_HOURS * HOUR) })
      .returning({ id: supportSessions.id });
    await writeAudit(tx, { tenantId, actorType: 'platform', actorId: admin.adminId, action: 'platform_support_emergency', recordType: 'support_session', recordId: s.id, reason: why, changes: { by: admin.name } });
    return { shop: t.name, emails: (await tx.select({ email: users.email }).from(users).where(and(eq(users.tenantId, tenantId), eq(users.rolePreset, 'owner')))).map((u) => u.email).filter((e): e is string => !!e) };
  });
  if (!owners) return fail('not_found');
  for (const to of owners.emails) {
    await sendEmail({ to, subject: `Emergency support access to ${owners.shop}`, text: `${admin.name} from platform support opened emergency access to your shop for ${EMERGENCY_HOURS} hours.\nReason: ${why}\nYou can end it now in Settings > Platform support access.` });
  }
  return { ok: true };
}

export type SupportSnapshot = {
  shop: { name: string; slug: string; shopType: string; status: string };
  counts: { products: number; customers: number; staff: number; salesToday: number; salesTodayPesewas: number; needReview: number };
  recentSales: Array<{ receiptNumber: string; businessDate: string; totalPesewas: number; status: string; needsReview: boolean }>;
  expiresAt: Date; emergency: boolean;
};

/** Spec 6.47: what support sees inside a session; each view is written to the shop's audit log. No password, PIN, or card data. */
export async function supportView(db: Db, adminToken: string | undefined, tenantId: string, now: Date): Promise<SupportSnapshot> {
  const admin = await requirePlatformAdmin(db, adminToken, now);
  if (!isUuid(tenantId)) throw new AccessError('forbidden');
  return asPlatform(db, async (tx) => {
    const session = await activeSession(tx, tenantId, now);
    if (!session) throw new AccessError('forbidden');
    const [t] = await tx.select().from(tenants).where(eq(tenants.id, tenantId));
    const today = businessDate(t.timezone, t.businessDayCutoff, now);
    const n = async (q: Promise<Array<{ n: number }>>) => (await q)[0].n;
    const [today$] = await tx.select({ n: sql<number>`count(*)::int`, total: sql<number>`coalesce(sum(${sales.totalPesewas}), 0)::int` }).from(sales)
      .where(and(eq(sales.tenantId, tenantId), eq(sales.status, 'completed'), eq(sales.businessDate, today)));
    const snapshot: SupportSnapshot = {
      shop: { name: t.name, slug: t.slug, shopType: t.shopType, status: t.status },
      counts: {
        products: await n(tx.select({ n: count() }).from(products).where(eq(products.tenantId, tenantId))),
        customers: await n(tx.select({ n: count() }).from(customers).where(eq(customers.tenantId, tenantId))),
        staff: await n(tx.select({ n: count() }).from(users).where(eq(users.tenantId, tenantId))),
        salesToday: today$.n, salesTodayPesewas: today$.total,
        needReview: await n(tx.select({ n: count() }).from(sales).where(and(eq(sales.tenantId, tenantId), eq(sales.needsReview, true)))),
      },
      recentSales: await tx.select({ receiptNumber: sales.receiptNumber, businessDate: sales.businessDate, totalPesewas: sales.totalPesewas, status: sales.status, needsReview: sales.needsReview })
        .from(sales).where(eq(sales.tenantId, tenantId)).orderBy(desc(sales.receivedAt)).limit(20),
      expiresAt: session.expiresAt, emergency: session.emergency,
    };
    await writeAudit(tx, { tenantId, actorType: 'platform', actorId: admin.adminId, action: 'platform_support_view', recordType: 'support_session', recordId: session.id, changes: { by: admin.name, page: 'overview' } });
    return snapshot;
  });
}

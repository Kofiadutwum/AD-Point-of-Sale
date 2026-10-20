import 'server-only';
import { desc, eq } from 'drizzle-orm';
import type { Db } from '@/db/client';
import { adminSessions, platformAdmins, subscriptions, tenants } from '@/db/schema';
import { asPlatform } from '@/db/tenant';
import { normaliseEmail } from '@/lib/contact';
import { todayIn } from '@/lib/dates';
import { type SubscriptionState, subscriptionState } from '@/lib/subscription';
import { writeAudit } from './audit';
import { AccessError } from './context';
import { dummySecretHash, hashSecret, newToken, tokenHash, verifySecret } from './crypto';
import { clearAttempts, countFailedAttempt, tooManyAttempts } from './rate-limit';

export const ADMIN_SESSION_HOURS = 12;

export async function createPlatformAdmin(db: Db, input: { email: string; name: string; password: string }): Promise<{ id: string }> {
  const email = normaliseEmail(input.email);
  if (!email) throw new Error('invalid email');
  const passwordHash = await hashSecret(input.password);
  const [row] = await asPlatform(db, (tx) => tx.insert(platformAdmins)
    .values({ email, name: input.name.trim(), passwordHash }).returning({ id: platformAdmins.id }));
  return row;
}

export async function platformSignIn(
  db: Db,
  input: { email: string; password: string; ip: string },
  now: Date,
): Promise<{ ok: true; token: string; expiresAt: Date } | { ok: false; error: 'try_again_later' | 'access_denied' }> {
  const email = normaliseEmail(input.email) ?? input.email.trim().toLowerCase();
  const rateKey = `admin:${input.ip}:${email}`;
  const outcome = await asPlatform(db, async (tx) => {
    if (await tooManyAttempts(tx, rateKey, now)) return 'try_again_later' as const;
    const [admin] = await tx.select().from(platformAdmins).where(eq(platformAdmins.email, email));
    const passwordOk = admin
      ? await verifySecret(admin.passwordHash, input.password)
      : (await verifySecret(await dummySecretHash(), input.password)) && false;
    if (!admin || !passwordOk) {
      await countFailedAttempt(tx, rateKey, now);
      await writeAudit(tx, { tenantId: null, actorType: 'anonymous', actorId: null, action: 'admin_failed_sign_in', changes: { email, ip: input.ip } });
      return 'access_denied' as const;
    }
    await clearAttempts(tx, rateKey);
    const token = newToken();
    const expiresAt = new Date(now.getTime() + ADMIN_SESSION_HOURS * 3_600_000);
    await tx.insert(adminSessions).values({ id: tokenHash(token), adminId: admin.id, expiresAt });
    await writeAudit(tx, { tenantId: null, actorType: 'platform', actorId: admin.id, action: 'admin_signed_in' });
    return { token, expiresAt };
  });
  return typeof outcome === 'string' ? { ok: false, error: outcome } : { ok: true, ...outcome };
}

export async function requirePlatformAdmin(db: Db, token: string | undefined, now: Date): Promise<{ adminId: string; name: string }> {
  if (!token) throw new AccessError('not_signed_in');
  const [row] = await asPlatform(db, (tx) => tx
    .select({ adminId: adminSessions.adminId, expiresAt: adminSessions.expiresAt, name: platformAdmins.name })
    .from(adminSessions).innerJoin(platformAdmins, eq(platformAdmins.id, adminSessions.adminId))
    .where(eq(adminSessions.id, tokenHash(token))));
  if (!row || row.expiresAt.getTime() <= now.getTime()) throw new AccessError('not_signed_in');
  return { adminId: row.adminId, name: row.name };
}

export async function platformSignOut(db: Db, token: string): Promise<void> {
  await asPlatform(db, (tx) => tx.delete(adminSessions).where(eq(adminSessions.id, tokenHash(token))));
}

export type ShopSummary = {
  tenantId: string; name: string; slug: string; shopType: string; status: string;
  planId: string; subscriptionStatus: string; endDate: string; state: SubscriptionState;
};

/** Shops with their subscription, newest first (or just one shop). Checks the admin session itself, so a page cannot forget to. */
export async function listShops(db: Db, adminToken: string | undefined, now: Date, tenantId?: string): Promise<ShopSummary[]> {
  await requirePlatformAdmin(db, adminToken, now);
  const found = await asPlatform(db, (tx) => tx.select({ t: tenants, s: subscriptions }).from(tenants)
    .innerJoin(subscriptions, eq(subscriptions.tenantId, tenants.id))
    .where(tenantId ? eq(tenants.id, tenantId) : undefined).orderBy(desc(tenants.createdAt)));
  return found.map(({ t, s }) => ({
    tenantId: t.id, name: t.name, slug: t.slug, shopType: t.shopType, status: t.status,
    planId: s.planId, subscriptionStatus: s.status, endDate: s.endDate,
    state: subscriptionState(s, todayIn(t.timezone, now)),
  }));
}

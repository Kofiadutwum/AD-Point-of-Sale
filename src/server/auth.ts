import 'server-only';
import { and, eq } from 'drizzle-orm';
import type { Db } from '@/db/client';
import { tenants, users } from '@/db/schema';
import { asPlatform } from '@/db/tenant';
import { normaliseEmail, normaliseGhanaPhone } from '@/lib/contact';
import { writeAudit } from './audit';
import { dummySecretHash, verifySecret } from './crypto';
import { clearAttempts, countFailedAttempt, tooManyAttempts } from './rate-limit';
import { createSession, invalidateSession } from './sessions';

export type SignInError = 'try_again_later' | 'access_denied' | 'account_disabled';


/** An identifier with '@' is an email; anything else is a Ghana phone number. */
export function normaliseIdentifier(identifier: string): { email: string | null; phone: string | null } {
  return identifier.includes('@')
    ? { email: normaliseEmail(identifier), phone: null }
    : { email: null, phone: normaliseGhanaPhone(identifier) };
}

export async function signIn(
  db: Db,
  input: { slug: string; identifier: string; password: string; ip: string },
  now: Date,
): Promise<{ ok: true; token: string; expiresAt: Date } | { ok: false; error: SignInError }> {
  const id = normaliseIdentifier(input.identifier);
  // text that is neither may be a password typed into the wrong box, so it is never stored
  const who = id.email ?? id.phone;
  const rateKey = `signin:${input.slug}:${input.ip}:${who ?? 'unrecognised'}`;

  // one transaction for every check; the session is created after it commits
  const outcome = await asPlatform(db, async (tx): Promise<{ error: SignInError } | { tenantId: string; userId: string }> => {
    if (await tooManyAttempts(tx, rateKey, now)) return { error: 'try_again_later' };
    const [shop] = await tx.select({ id: tenants.id, status: tenants.status }).from(tenants).where(eq(tenants.slug, input.slug));
    if (!shop || shop.status !== 'active') return { error: 'access_denied' };

    const contact = id.email ? eq(users.email, id.email) : id.phone ? eq(users.phone, id.phone) : null;
    const [user] = contact ? await tx.select().from(users).where(and(eq(users.tenantId, shop.id), contact)) : [];
    const passwordOk = user?.passwordHash
      ? await verifySecret(user.passwordHash, input.password)
      : (await verifySecret(await dummySecretHash(), input.password)) && false;
    if (!user || !passwordOk) {
      await countFailedAttempt(tx, rateKey, now);
      await writeAudit(tx, { tenantId: shop.id, actorType: 'anonymous', actorId: null, action: 'failed_sign_in', changes: { identifier: who, ip: input.ip } });
      return { error: 'access_denied' };
    }
    if (user.status !== 'active') return { error: 'account_disabled' };
    await clearAttempts(tx, rateKey);
    await writeAudit(tx, { tenantId: shop.id, actorType: 'user', actorId: user.id, action: 'signed_in' });
    return { tenantId: shop.id, userId: user.id };
  });

  if ('error' in outcome) return { ok: false, error: outcome.error };
  const session = await createSession(db, { tenantId: outcome.tenantId, userId: outcome.userId, kind: 'password' }, now);
  return { ok: true, ...session };
}

export async function signOut(db: Db, token: string): Promise<void> {
  await invalidateSession(db, token);
}

import 'server-only';
import { randomBytes } from 'node:crypto';
import { and, eq, isNull, ne } from 'drizzle-orm';
import type { Db, Tx } from '@/db/client';
import { mfaChallenges, mfaRecoveryCodes, sessions, tenants, users } from '@/db/schema';
import { asPlatform, withTenant } from '@/db/tenant';
import { writeAudit } from './audit';
import type { Ctx } from './context';
import { newToken, tokenHash } from './crypto';
import { appName } from './onboarding';
import { clearAttempts, countFailedAttempt, tooManyAttempts } from './rate-limit';
import { openSecret, sealSecret } from './secret-box';
import { createSession } from './sessions';
import { matchTotp, newTotpSecret, otpauthUri } from './totp';

// Spec 6.1: owners (and anyone signing in with a password) can require a second factor. PIN sessions never manage it.
export const RECOVERY_CODE_COUNT = 10;
export const MFA_CHALLENGE_MINUTES = 5;
export const MFA_MAX_ATTEMPTS = 5;
export type MfaError = 'password_session_required' | 'already_enabled' | 'not_enabled' | 'not_started' | 'wrong_code';

const ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
const fail = (error: MfaError) => ({ ok: false, error }) as const;
const normaliseRecovery = (code: string) => code.toUpperCase().replace(/[\s-]/g, '');

function newRecoveryCodes(): string[] {
  return Array.from({ length: RECOVERY_CODE_COUNT }, () => {
    const chars = [...randomBytes(10)].map((b) => ALPHABET[b & 31]).join('');
    return `${chars.slice(0, 5)}-${chars.slice(5)}`;
  });
}

async function saveRecoveryCodes(tx: Tx, tenantId: string, userId: string): Promise<string[]> {
  const codes = newRecoveryCodes();
  await tx.delete(mfaRecoveryCodes).where(eq(mfaRecoveryCodes.userId, userId));
  await tx.insert(mfaRecoveryCodes).values(codes.map((c) => ({ tenantId, userId, codeHash: tokenHash(normaliseRecovery(c)) })));
  return codes;
}

/** A TOTP code (saving its step) or an unused recovery code (marking it used). */
async function acceptCode(tx: Tx, user: typeof users.$inferSelect, code: string, now: Date): Promise<boolean> {
  const secret = user.mfaSecret ? openSecret(user.mfaSecret) : null;
  const clean = code.trim();
  if (/^\d{6}$/.test(clean)) {
    const step = secret ? matchTotp(secret, clean, now, user.mfaLastStep) : null;
    if (step === null) return false;
    await tx.update(users).set({ mfaLastStep: step }).where(eq(users.id, user.id));
    return true;
  }
  const used = await tx.update(mfaRecoveryCodes).set({ usedAt: now }).where(and(
    eq(mfaRecoveryCodes.userId, user.id), eq(mfaRecoveryCodes.codeHash, tokenHash(normaliseRecovery(clean))), isNull(mfaRecoveryCodes.usedAt),
  )).returning({ id: mfaRecoveryCodes.id });
  return used.length > 0;
}

async function me(tx: Tx, ctx: Ctx) {
  const [u] = await tx.select().from(users).where(eq(users.id, ctx.userId)).for('update');
  return u;
}

export async function getMfaStatus(db: Db, ctx: Ctx): Promise<{ enabled: boolean; pending: { secret: string; otpauthUri: string } | null; recoveryCodesLeft: number }> {
  if (ctx.sessionKind !== 'password') throw new Error('password_session_required');
  return withTenant(db, ctx.tenantId, async (tx) => {
    const [u] = await tx.select().from(users).where(eq(users.id, ctx.userId));
    const left = await tx.select({ id: mfaRecoveryCodes.id }).from(mfaRecoveryCodes)
      .where(and(eq(mfaRecoveryCodes.userId, ctx.userId), isNull(mfaRecoveryCodes.usedAt)));
    const secret = !u.mfaEnabledAt && u.mfaSecret ? openSecret(u.mfaSecret) : null;
    return {
      enabled: u.mfaEnabledAt !== null,
      pending: secret ? { secret, otpauthUri: otpauthUri(secret, { issuer: appName(), account: u.email ?? u.phone ?? u.name }) } : null,
      recoveryCodesLeft: u.mfaEnabledAt ? left.length : 0,
    };
  });
}

export async function startMfaEnrolment(db: Db, ctx: Ctx): Promise<{ ok: true } | { ok: false; error: MfaError }> {
  if (ctx.sessionKind !== 'password') return fail('password_session_required');
  return withTenant(db, ctx.tenantId, async (tx) => {
    const u = await me(tx, ctx);
    if (u.mfaEnabledAt) return fail('already_enabled');
    await tx.update(users).set({ mfaSecret: sealSecret(newTotpSecret()), mfaLastStep: null }).where(eq(users.id, u.id));
    return { ok: true } as const;
  });
}

export async function confirmMfaEnrolment(db: Db, ctx: Ctx, code: string, now: Date): Promise<{ ok: true; recoveryCodes: string[] } | { ok: false; error: MfaError }> {
  if (ctx.sessionKind !== 'password') return fail('password_session_required');
  return withTenant(db, ctx.tenantId, async (tx) => {
    const u = await me(tx, ctx);
    if (u.mfaEnabledAt) return fail('already_enabled');
    if (!u.mfaSecret) return fail('not_started');
    if (!/^\d{6}$/.test(code.trim()) || !(await acceptCode(tx, u, code, now))) return fail('wrong_code');
    await tx.update(users).set({ mfaEnabledAt: now }).where(eq(users.id, u.id));
    const recoveryCodes = await saveRecoveryCodes(tx, ctx.tenantId, u.id);
    // a session opened before MFA (perhaps by someone else) must not outlive it
    await tx.delete(sessions).where(and(eq(sessions.userId, u.id), ne(sessions.id, ctx.sessionId)));
    await writeAudit(tx, { tenantId: ctx.tenantId, actorType: 'user', actorId: u.id, action: 'mfa_enabled', recordType: 'user', recordId: u.id });
    return { ok: true, recoveryCodes } as const;
  });
}

export async function regenerateRecoveryCodes(db: Db, ctx: Ctx, code: string, now: Date): Promise<{ ok: true; recoveryCodes: string[] } | { ok: false; error: MfaError }> {
  if (ctx.sessionKind !== 'password') return fail('password_session_required');
  return withTenant(db, ctx.tenantId, async (tx) => {
    const u = await me(tx, ctx);
    if (!u.mfaEnabledAt) return fail('not_enabled');
    if (!(await acceptCode(tx, u, code, now))) return fail('wrong_code');
    const recoveryCodes = await saveRecoveryCodes(tx, ctx.tenantId, u.id);
    await writeAudit(tx, { tenantId: ctx.tenantId, actorType: 'user', actorId: u.id, action: 'mfa_recovery_codes_regenerated', recordType: 'user', recordId: u.id });
    return { ok: true, recoveryCodes } as const;
  });
}

async function clearMfa(tx: Tx, userId: string): Promise<void> {
  await tx.update(users).set({ mfaSecret: null, mfaEnabledAt: null, mfaLastStep: null }).where(eq(users.id, userId));
  await tx.delete(mfaRecoveryCodes).where(eq(mfaRecoveryCodes.userId, userId));
  await tx.delete(mfaChallenges).where(eq(mfaChallenges.userId, userId));
}

export async function disableMfa(db: Db, ctx: Ctx, code: string, now: Date): Promise<{ ok: true } | { ok: false; error: MfaError }> {
  if (ctx.sessionKind !== 'password') return fail('password_session_required');
  return withTenant(db, ctx.tenantId, async (tx) => {
    const u = await me(tx, ctx);
    if (!u.mfaEnabledAt) return fail('not_enabled');
    if (!(await acceptCode(tx, u, code, now))) return fail('wrong_code');
    await clearMfa(tx, u.id);
    await writeAudit(tx, { tenantId: ctx.tenantId, actorType: 'user', actorId: u.id, action: 'mfa_disabled', recordType: 'user', recordId: u.id });
    return { ok: true } as const;
  });
}

/** Platform support only: the owner lost both the authenticator and the recovery codes. */
export async function clearMfaAsPlatform(tx: Tx, tenantId: string, userId: string, adminId: string): Promise<void> {
  await clearMfa(tx, userId);
  await tx.delete(sessions).where(eq(sessions.userId, userId));
  await writeAudit(tx, { tenantId, actorType: 'platform', actorId: adminId, action: 'mfa_reset', recordType: 'user', recordId: userId });
}

export async function createMfaChallenge(tx: Tx, tenantId: string, userId: string, now: Date): Promise<{ challengeToken: string; expiresAt: Date }> {
  const challengeToken = newToken();
  const expiresAt = new Date(now.getTime() + MFA_CHALLENGE_MINUTES * 60_000);
  await tx.insert(mfaChallenges).values({ id: tokenHash(challengeToken), tenantId, userId, expiresAt });
  return { challengeToken, expiresAt };
}

export async function verifyMfaSignIn(
  db: Db, input: { slug: string; challengeToken: string; code: string; ip: string }, now: Date,
): Promise<{ ok: true; token: string; expiresAt: Date } | { ok: false; error: 'expired' | 'wrong_code' | 'try_again_later' }> {
  const id = tokenHash(input.challengeToken);
  const outcome = await asPlatform(db, async (tx): Promise<{ error: 'expired' | 'wrong_code' | 'try_again_later' } | { tenantId: string; userId: string }> => {
    const [row] = await tx.select({ c: mfaChallenges, slug: tenants.slug }).from(mfaChallenges)
      .innerJoin(tenants, eq(tenants.id, mfaChallenges.tenantId)).where(eq(mfaChallenges.id, id)).for('update');
    if (!row) return { error: 'expired' };
    if (row.c.expiresAt.getTime() <= now.getTime() || row.slug !== input.slug) {
      await tx.delete(mfaChallenges).where(eq(mfaChallenges.id, id));
      return { error: 'expired' };
    }
    const rateKey = `mfa:${row.c.userId}`;
    if (await tooManyAttempts(tx, rateKey, now)) return { error: 'try_again_later' };
    const [user] = await tx.select().from(users).where(eq(users.id, row.c.userId)).for('update');
    if (!user || user.status !== 'active' || !user.mfaEnabledAt) {
      await tx.delete(mfaChallenges).where(eq(mfaChallenges.id, id));
      return { error: 'expired' };
    }
    if (!(await acceptCode(tx, user, input.code, now))) {
      await countFailedAttempt(tx, rateKey, now);
      const [{ attempts }] = await tx.update(mfaChallenges).set({ attempts: row.c.attempts + 1 })
        .where(eq(mfaChallenges.id, id)).returning({ attempts: mfaChallenges.attempts });
      if (attempts >= MFA_MAX_ATTEMPTS) await tx.delete(mfaChallenges).where(eq(mfaChallenges.id, id));
      await writeAudit(tx, { tenantId: user.tenantId, actorType: 'anonymous', actorId: null, action: 'mfa_failed', recordType: 'user', recordId: user.id, changes: { ip: input.ip } });
      return { error: 'wrong_code' };
    }
    await tx.delete(mfaChallenges).where(eq(mfaChallenges.id, id));
    await clearAttempts(tx, rateKey);
    await writeAudit(tx, { tenantId: user.tenantId, actorType: 'user', actorId: user.id, action: 'signed_in', changes: { mfa: true } });
    return { tenantId: user.tenantId, userId: user.id };
  });
  if ('error' in outcome) return { ok: false, error: outcome.error };
  return { ok: true, ...(await createSession(db, { tenantId: outcome.tenantId, userId: outcome.userId, kind: 'password' }, now)) };
}

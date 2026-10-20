import 'server-only';
import { and, eq } from 'drizzle-orm';
import type { Db } from '@/db/client';
import { sessions, users } from '@/db/schema';
import { asPlatform } from '@/db/tenant';
import { type Permission, type RolePreset, TILL_PERMISSIONS } from '@/lib/permissions';
import { newToken, tokenHash } from './crypto';

export type SessionKind = 'password' | 'pin';
export type SessionUser = {
  sessionId: string; kind: SessionKind; tenantId: string; userId: string; registerId: string | null;
  name: string; rolePreset: RolePreset; permissions: Permission[]; expiresAt: Date;
};

export const PASSWORD_SESSION_DAYS = 30; // extended to now + 30 days when under 15 days remain
export const PIN_SESSION_HOURS = 12; // never extended
const DAY = 86_400_000;
const HOUR = 3_600_000;
const RENEW_BELOW = 15 * DAY;

export async function createSession(
  db: Db,
  input: { tenantId: string; userId: string; kind: SessionKind; registerId?: string | null },
  now: Date,
): Promise<{ token: string; expiresAt: Date }> {
  const token = newToken();
  const lifetime = input.kind === 'pin' ? PIN_SESSION_HOURS * HOUR : PASSWORD_SESSION_DAYS * DAY;
  const expiresAt = new Date(now.getTime() + lifetime);
  await asPlatform(db, (tx) => tx.insert(sessions).values({
    id: tokenHash(token), tenantId: input.tenantId, userId: input.userId,
    registerId: input.registerId ?? null, kind: input.kind, expiresAt,
  }));
  return { token, expiresAt };
}

/** Null when the token is unknown or expired, or the user is no longer active. */
export async function validateSession(db: Db, token: string, now: Date): Promise<SessionUser | null> {
  const id = tokenHash(token);
  return asPlatform(db, async (tx) => {
    const [row] = await tx.select({ s: sessions, u: users }).from(sessions)
      .innerJoin(users, and(eq(users.id, sessions.userId), eq(users.tenantId, sessions.tenantId)))
      .where(eq(sessions.id, id));
    if (!row) return null;
    if (row.s.expiresAt.getTime() <= now.getTime()) {
      await tx.delete(sessions).where(eq(sessions.id, id));
      return null;
    }
    if (row.u.status !== 'active') return null;
    let expiresAt = row.s.expiresAt;
    if (row.s.kind === 'password' && expiresAt.getTime() - now.getTime() < RENEW_BELOW) {
      expiresAt = new Date(now.getTime() + PASSWORD_SESSION_DAYS * DAY);
      await tx.update(sessions).set({ expiresAt }).where(eq(sessions.id, id));
    }
    return {
      sessionId: id, kind: row.s.kind, tenantId: row.s.tenantId, userId: row.u.id, registerId: row.s.registerId,
      name: row.u.name, rolePreset: row.u.rolePreset, expiresAt,
      permissions: (row.u.permissions as Permission[]).filter((p) => row.s.kind === 'password' || TILL_PERMISSIONS.includes(p)),
    };
  });
}

export async function invalidateSession(db: Db, token: string): Promise<void> {
  await asPlatform(db, (tx) => tx.delete(sessions).where(eq(sessions.id, tokenHash(token))));
}

export async function invalidateUserSessions(db: Db, tenantId: string, userId: string): Promise<void> {
  await asPlatform(db, (tx) => tx.delete(sessions).where(and(eq(sessions.tenantId, tenantId), eq(sessions.userId, userId))));
}

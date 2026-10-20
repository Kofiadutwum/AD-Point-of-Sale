import 'server-only';
import { and, asc, eq, inArray, isNull, or, type SQL } from 'drizzle-orm';
import { z } from 'zod';
import type { Db, Tx } from '@/db/client';
import { branches, sessions, users, userTokens } from '@/db/schema';
import { withTenant } from '@/db/tenant';
import { normaliseEmail, normaliseGhanaPhone } from '@/lib/contact';
import { isPermission, type Permission, ROLE_PRESETS } from '@/lib/permissions';
import { writeAudit } from './audit';
import { assertPermission, type Ctx } from './context';
import { sendEmail } from './email';
import { activationUrl, appName, issueToken, TOKEN_HOURS } from './onboarding';
import { checkPlanLimit, lockTenant } from './plan-limits';

type Member = typeof users.$inferSelect;
type MemberError = 'not_found' | 'cannot_change_owner';

/** A non-owner member of the context's shop. Row-level security hides other shops' users. */
async function findMember(tx: Tx, staffId: string): Promise<Member | MemberError> {
  if (!z.uuid().safeParse(staffId).success) return 'not_found';
  const [member] = await tx.select().from(users).where(eq(users.id, staffId));
  if (!member) return 'not_found';
  return member.rolePreset === 'owner' ? 'cannot_change_owner' : member;
}

async function emailInvite(email: string | null, url: string): Promise<void> {
  if (!email) return;
  try {
    await sendEmail({
      to: email,
      subject: `You have been added to a shop on ${appName()}`,
      text: `Set your password and till PIN here:\n${url}\n\nThe link works once and expires in ${TOKEN_HOURS} hours.`,
    });
  } catch (err) {
    console.error('invite email failed', err); // the owner still has the link to send by WhatsApp
  }
}

/** An optional contact: blank means none; anything else must be valid. */
function contact(input: string | undefined, normalise: (s: string) => string | null): string | null | 'invalid' {
  if (!input?.trim()) return null;
  return normalise(input) ?? 'invalid';
}

export type StaffMember = Pick<Member, 'id' | 'name' | 'email' | 'phone' | 'rolePreset' | 'status' | 'branchIds' | 'permissions'>;

export async function listStaff(db: Db, ctx: Ctx): Promise<StaffMember[]> {
  assertPermission(ctx, 'manage_staff');
  return withTenant(db, ctx.tenantId, (tx) => tx.select({
    id: users.id, name: users.name, email: users.email, phone: users.phone, rolePreset: users.rolePreset,
    status: users.status, branchIds: users.branchIds, permissions: users.permissions,
  }).from(users).orderBy(asc(users.name)));
}

export async function addStaff(
  db: Db, ctx: Ctx,
  input: { name: string; email?: string; phone?: string; rolePreset: 'manager' | 'cashier'; branchIds: string[] },
  now: Date,
): Promise<{ ok: true; userId: string; inviteUrl: string }
  | { ok: false; error: 'limit_reached' | 'contact_required' | 'duplicate_contact' | 'unknown_branch' | 'invalid_input' }> {
  assertPermission(ctx, 'manage_staff');
  const name = input.name.trim();
  if (!name || !['manager', 'cashier'].includes(input.rolePreset)) return { ok: false, error: 'invalid_input' };
  const email = contact(input.email, normaliseEmail);
  const phone = contact(input.phone, normaliseGhanaPhone);
  if (email === 'invalid' || phone === 'invalid' || (!email && !phone)) return { ok: false, error: 'contact_required' };
  const branchIds = [...new Set(input.branchIds)];
  if (branchIds.length === 0 || !branchIds.every((id) => z.uuid().safeParse(id).success)) return { ok: false, error: 'unknown_branch' };

  const result = await withTenant(db, ctx.tenantId, async (tx) => {
    await lockTenant(tx, ctx.tenantId);
    const found = await tx.select({ id: branches.id }).from(branches).where(inArray(branches.id, branchIds));
    if (found.length !== branchIds.length) return { ok: false, error: 'unknown_branch' } as const;
    if ((await checkPlanLimit(tx, ctx.tenantId, 'staff')) === 'limit_reached') return { ok: false, error: 'limit_reached' } as const;
    const same = [email ? eq(users.email, email) : null, phone ? eq(users.phone, phone) : null].filter((c): c is SQL => c !== null);
    const [dup] = await tx.select({ id: users.id }).from(users).where(or(...same));
    if (dup) return { ok: false, error: 'duplicate_contact' } as const;
    const [user] = await tx.insert(users).values({
      tenantId: ctx.tenantId, name, email, phone, rolePreset: input.rolePreset,
      permissions: [...ROLE_PRESETS[input.rolePreset]], branchIds, status: 'invited',
    }).returning({ id: users.id });
    const token = await issueToken(tx, ctx.tenantId, user.id, 'invite', now);
    await writeAudit(tx, { tenantId: ctx.tenantId, actorType: 'user', actorId: ctx.userId, action: 'staff_added', recordType: 'user', recordId: user.id });
    return { ok: true, userId: user.id, token } as const;
  });
  if (!result.ok) return result;
  const inviteUrl = activationUrl(result.token);
  await emailInvite(email, inviteUrl);
  return { ok: true, userId: result.userId, inviteUrl };
}

/** Clears the password and PIN, signs the member out everywhere, and issues a fresh invite. */
export async function resetStaffAccess(
  db: Db, ctx: Ctx, staffId: string, now: Date,
): Promise<{ ok: true; inviteUrl: string } | { ok: false; error: MemberError }> {
  assertPermission(ctx, 'manage_staff');
  const result = await withTenant(db, ctx.tenantId, async (tx) => {
    const member = await findMember(tx, staffId);
    if (typeof member === 'string') return { ok: false, error: member } as const;
    await tx.update(users).set({ passwordHash: null, pinHash: null, failedPinCount: 0, pinLockedUntil: null, status: 'invited' })
      .where(eq(users.id, member.id));
    await tx.delete(sessions).where(eq(sessions.userId, member.id));
    const token = await issueToken(tx, ctx.tenantId, member.id, 'invite', now);
    await writeAudit(tx, { tenantId: ctx.tenantId, actorType: 'user', actorId: ctx.userId, action: 'staff_access_reset', recordType: 'user', recordId: member.id });
    return { ok: true, token, email: member.email } as const;
  });
  if (!result.ok) return result;
  const inviteUrl = activationUrl(result.token);
  await emailInvite(result.email, inviteUrl);
  return { ok: true, inviteUrl };
}

export async function deactivateStaff(
  db: Db, ctx: Ctx, staffId: string, reason: string,
): Promise<{ ok: true } | { ok: false; error: MemberError | 'cannot_change_self' }> {
  assertPermission(ctx, 'manage_staff');
  return withTenant(db, ctx.tenantId, async (tx) => {
    const member = await findMember(tx, staffId);
    if (typeof member === 'string') return { ok: false, error: member } as const;
    if (member.id === ctx.userId) return { ok: false, error: 'cannot_change_self' } as const;
    await tx.update(users).set({ status: 'inactive' }).where(eq(users.id, member.id));
    await tx.delete(sessions).where(eq(sessions.userId, member.id));
    await tx.delete(userTokens).where(and(eq(userTokens.userId, member.id), isNull(userTokens.usedAt)));
    await writeAudit(tx, { tenantId: ctx.tenantId, actorType: 'user', actorId: ctx.userId, action: 'staff_deactivated', recordType: 'user', recordId: member.id, reason });
    return { ok: true } as const;
  });
}

/** Nobody changes their own permissions or grants a permission they do not hold themselves. */
export async function setStaffPermissions(
  db: Db, ctx: Ctx, staffId: string, permissions: string[],
): Promise<{ ok: true } | { ok: false; error: MemberError | 'invalid_permission' | 'cannot_change_self' | 'cannot_grant' }> {
  assertPermission(ctx, 'manage_staff');
  if (!permissions.every(isPermission)) return { ok: false, error: 'invalid_permission' };
  const wanted = [...new Set(permissions)] as Permission[];
  if (!wanted.every((p) => ctx.permissions.includes(p))) return { ok: false, error: 'cannot_grant' };
  return withTenant(db, ctx.tenantId, async (tx) => {
    const member = await findMember(tx, staffId);
    if (typeof member === 'string') return { ok: false, error: member } as const;
    if (member.id === ctx.userId) return { ok: false, error: 'cannot_change_self' } as const;
    await tx.update(users).set({ permissions: wanted }).where(eq(users.id, member.id));
    await writeAudit(tx, {
      tenantId: ctx.tenantId, actorType: 'user', actorId: ctx.userId, action: 'staff_permissions_changed',
      recordType: 'user', recordId: member.id, changes: { permissions: wanted },
    });
    return { ok: true } as const;
  });
}

import 'server-only';
import { and, eq, isNull } from 'drizzle-orm';
import { z } from 'zod';
import type { Db, Tx } from '@/db/client';
import { branches, registers, sessions, subscriptions, tenants, userTokens, users } from '@/db/schema';
import { asPlatform, withTenant } from '@/db/tenant';
import { normaliseEmail, normaliseGhanaPhone } from '@/lib/contact';
import { addDays, todayIn } from '@/lib/dates';
import { DEFAULT_MODULES, ROLE_PRESETS, type ShopType } from '@/lib/permissions';
import { normaliseSlug, type SlugProblem, validateSlug } from '@/lib/slug';
import { writeAudit } from './audit';
import { assertPermission, type Ctx } from './context';
import { hashSecret, newToken, tokenHash } from './crypto';
import { sendEmail } from './email';
import { applyManualPayment, type ManualPayment, type PaymentError } from './subscriptions';

export const TOKEN_HOURS = 72;
export const MIN_PASSWORD_LENGTH = 10;
export const TRIAL_DAYS = 14;

export const appName = () => process.env.APP_NAME ?? 'Multi-Shop POS';
export const activationUrl = (token: string) => `${process.env.APP_URL ?? 'http://localhost:3000'}/activate/${token}`;

/** A single-use 72-hour token for activation or an invite; the user's earlier unused tokens stop working. */
export async function issueToken(tx: Tx, tenantId: string, userId: string, purpose: 'activation' | 'invite', now: Date): Promise<string> {
  await tx.update(userTokens).set({ usedAt: now }).where(and(eq(userTokens.userId, userId), isNull(userTokens.usedAt)));
  const token = newToken();
  await tx.insert(userTokens).values({
    tenantId, userId, purpose, tokenHash: tokenHash(token), expiresAt: new Date(now.getTime() + TOKEN_HOURS * 3_600_000),
  });
  return token;
}

export type OnboardInput = {
  name: string; requestedSlug: string; shopType: ShopType;
  owner: { name: string; email?: string; phone?: string };
  start: { kind: 'trial' } | { kind: 'paid'; payment: ManualPayment };
};
export type OnboardError =
  | { error: 'choose_another_slug'; reason: SlugProblem | 'taken' }
  | { error: 'owner_contact_required' }
  | { error: 'name_required' }
  | { error: PaymentError };

class Rollback extends Error {
  constructor(readonly result: OnboardError) { super(result.error); }
}

/** Spec 6.2 and 6.48: one transaction creates the shop, its subscription, branch, till, owner, and activation token. */
export async function onboardShop(
  db: Db, adminId: string, input: OnboardInput, now: Date,
): Promise<{ ok: true; tenantId: string; slug: string; activationUrl: string } | ({ ok: false } & OnboardError)> {
  const shopName = input.name.trim();
  const ownerName = input.owner.name.trim();
  if (!shopName || !ownerName) return { ok: false, error: 'name_required' };
  const slug = normaliseSlug(input.requestedSlug);
  const problem = validateSlug(slug);
  if (problem !== 'ok') return { ok: false, error: 'choose_another_slug', reason: problem };
  const email = input.owner.email?.trim() ? (normaliseEmail(input.owner.email) ?? 'invalid') : null;
  const phone = optionalPhone(input.owner.phone ?? '');
  // a mistyped contact is refused, never dropped while the other one is kept
  if (email === 'invalid' || phone === 'invalid' || (!email && !phone)) return { ok: false, error: 'owner_contact_required' };

  let created: { token: string; tenantId: string };
  try {
    created = await asPlatform(db, async (tx) => {
      // a concurrent create of the same slug waits for ours to commit, then inserts nothing
      const [tenant] = await tx.insert(tenants).values({
        slug, name: shopName, shopType: input.shopType, modules: [...DEFAULT_MODULES[input.shopType]],
      }).onConflictDoNothing({ target: tenants.slug }).returning();
      if (!tenant) throw new Rollback({ error: 'choose_another_slug', reason: 'taken' });
      const today = todayIn(tenant.timezone, now);
      if (input.start.kind === 'trial') {
        await tx.insert(subscriptions).values({ tenantId: tenant.id, planId: 'trial', status: 'trial', endDate: addDays(today, TRIAL_DAYS) });
      } else {
        // applyManualPayment sets the paid plan and extends from today
        await tx.insert(subscriptions).values({ tenantId: tenant.id, planId: 'trial', status: 'active', endDate: today });
        const paid = await applyManualPayment(tx, adminId, tenant.id, input.start.payment, now);
        if (!paid.ok) throw new Rollback({ error: paid.error });
      }
      const [branch] = await tx.insert(branches).values({ tenantId: tenant.id, name: 'Main', branchCode: 'B1' }).returning();
      await tx.insert(registers).values({ tenantId: tenant.id, branchId: branch.id, name: 'Till 1', registerCode: 'T1' });
      const [owner] = await tx.insert(users).values({
        tenantId: tenant.id, name: ownerName, email, phone, rolePreset: 'owner',
        permissions: [...ROLE_PRESETS.owner], branchIds: [branch.id], status: 'pending_activation',
      }).returning();
      const token = await issueToken(tx, tenant.id, owner.id, 'activation', now);
      await writeAudit(tx, {
        tenantId: tenant.id, actorType: 'platform', actorId: adminId, action: 'shop_created',
        changes: { slug, shopType: input.shopType, start: input.start.kind },
      });
      return { token, tenantId: tenant.id };
    });
  } catch (e) {
    if (e instanceof Rollback) return { ok: false, ...e.result };
    throw e;
  }

  const url = activationUrl(created.token);
  if (email) {
    try {
      await sendEmail({
        to: email,
        subject: `Activate your shop on ${appName()}`,
        text: `Set your password to start using ${appName()}:\n${url}\n\nThe link works once and expires in ${TOKEN_HOURS} hours.`,
      });
    } catch (err) {
      console.error('activation email failed', err); // the admin still has the link to send by WhatsApp
    }
  }
  return { ok: true, tenantId: created.tenantId, slug, activationUrl: url };
}

/** For an owner who lost their link or password; earlier links stop working. */
export async function issueActivationLink(db: Db, adminId: string, tenantId: string, userId: string, now: Date): Promise<{ activationUrl: string }> {
  const token = await asPlatform(db, async (tx) => {
    const [user] = await tx.select({ id: users.id }).from(users).where(and(eq(users.id, userId), eq(users.tenantId, tenantId)));
    if (!user) throw new Error('user not found in shop');
    const issued = await issueToken(tx, tenantId, userId, 'activation', now);
    await writeAudit(tx, { tenantId, actorType: 'platform', actorId: adminId, action: 'activation_link_issued', recordType: 'user', recordId: userId });
    return issued;
  });
  return { activationUrl: activationUrl(token) };
}

export async function issueOwnerActivationLink(db: Db, adminId: string, tenantId: string, now: Date): Promise<{ activationUrl: string }> {
  const [owner] = await asPlatform(db, (tx) => tx.select({ id: users.id }).from(users)
    .where(and(eq(users.tenantId, tenantId), eq(users.rolePreset, 'owner'))).limit(1));
  if (!owner) throw new Error('shop has no owner');
  return issueActivationLink(db, adminId, tenantId, owner.id, now);
}

/** Sets the password (and optional PIN) from an activation or invite link. */
export async function activateAccount(
  db: Db, input: { token: string; password: string; pin?: string }, now: Date,
): Promise<{ ok: true; slug: string } | { ok: false; error: 'invalid_or_expired' | 'weak_password' | 'invalid_pin' }> {
  if (input.password.length < MIN_PASSWORD_LENGTH) return { ok: false, error: 'weak_password' };
  const pin = input.pin?.trim() || null;
  if (pin !== null && !/^\d{4,6}$/.test(pin)) return { ok: false, error: 'invalid_pin' };
  const passwordHash = await hashSecret(input.password);
  const pinHash = pin ? await hashSecret(pin) : null;

  return asPlatform(db, async (tx) => {
    const [row] = await tx.select({ token: userTokens, slug: tenants.slug }).from(userTokens)
      .innerJoin(tenants, eq(tenants.id, userTokens.tenantId))
      .where(eq(userTokens.tokenHash, tokenHash(input.token))).for('update');
    if (!row || row.token.usedAt || row.token.expiresAt.getTime() <= now.getTime()) return { ok: false, error: 'invalid_or_expired' } as const;
    await tx.update(userTokens).set({ usedAt: now }).where(eq(userTokens.id, row.token.id));
    await tx.update(users)
      .set({ passwordHash, status: 'active', ...(pinHash ? { pinHash, failedPinCount: 0, pinLockedUntil: null } : {}) })
      .where(and(eq(users.id, row.token.userId), eq(users.tenantId, row.token.tenantId)));
    // a new password must end every earlier session, e.g. one opened by whoever had the old password
    await tx.delete(sessions).where(eq(sessions.userId, row.token.userId));
    await writeAudit(tx, { tenantId: row.token.tenantId, actorType: 'user', actorId: row.token.userId, action: 'account_activated' });
    return { ok: true, slug: row.slug } as const;
  });
}

const profileSchema = z.object({
  name: z.string().trim().min(1).max(100),
  address: z.string().trim().max(200),
  phone: z.string(),
  managerPhone: z.string(),
  taxMode: z.enum(['inclusive', 'exclusive']),
  businessDayCutoff: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/),
});

/** Optional phone: blank means none; anything else must be a valid Ghana number. */
function optionalPhone(input: string): string | null | 'invalid' {
  if (!input.trim()) return null;
  return normaliseGhanaPhone(input) ?? 'invalid';
}

export type ShopProfile = {
  name: string; address: string; phone: string; managerPhone: string; taxMode: 'inclusive' | 'exclusive'; businessDayCutoff: string;
};

export async function getShopProfile(db: Db, ctx: Ctx): Promise<ShopProfile> {
  const [t] = await withTenant(db, ctx.tenantId, (tx) => tx.select().from(tenants).where(eq(tenants.id, ctx.tenantId)));
  return {
    name: t.name, address: t.address ?? '', phone: t.phone ?? '', managerPhone: t.managerPhone ?? '',
    taxMode: t.taxMode, businessDayCutoff: t.businessDayCutoff,
  };
}

export async function updateShopProfile(
  db: Db, ctx: Ctx,
  input: { name: string; address: string; phone: string; managerPhone: string; taxMode: 'inclusive' | 'exclusive'; businessDayCutoff: string },
): Promise<{ ok: true } | { ok: false; error: 'invalid_input' }> {
  assertPermission(ctx, 'manage_shop_settings');
  const parsed = profileSchema.safeParse(input);
  if (!parsed.success) return { ok: false, error: 'invalid_input' };
  const phone = optionalPhone(parsed.data.phone);
  const managerPhone = optionalPhone(parsed.data.managerPhone);
  if (phone === 'invalid' || managerPhone === 'invalid') return { ok: false, error: 'invalid_input' };
  await withTenant(db, ctx.tenantId, async (tx) => {
    await tx.update(tenants).set({
      name: parsed.data.name, address: parsed.data.address || null, phone, managerPhone,
      taxMode: parsed.data.taxMode, businessDayCutoff: parsed.data.businessDayCutoff,
    }).where(eq(tenants.id, ctx.tenantId));
    await writeAudit(tx, { tenantId: ctx.tenantId, actorType: 'user', actorId: ctx.userId, action: 'shop_profile_updated' });
  });
  return { ok: true };
}

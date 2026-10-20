import 'server-only';
import { eq } from 'drizzle-orm';
import type { Db } from '@/db/client';
import { subscriptions, tenants } from '@/db/schema';
import { asPlatform } from '@/db/tenant';
import { todayIn } from '@/lib/dates';
import { type Permission, READ_ONLY_PERMISSIONS, type RolePreset } from '@/lib/permissions';
import { type SubscriptionState, subscriptionState } from '@/lib/subscription';
import { type SessionKind, validateSession } from './sessions';

export type AccessCode = 'not_signed_in' | 'wrong_shop' | 'suspended' | 'read_only' | 'forbidden';

export class AccessError extends Error {
  constructor(readonly code: AccessCode) {
    super(code);
    this.name = 'AccessError';
  }
}

export type Ctx = {
  tenantId: string; slug: string; timezone: string; userId: string; name: string; rolePreset: RolePreset;
  permissions: Permission[]; registerId: string | null; subscription: SubscriptionState;
  sessionId: string; sessionKind: SessionKind;
};

/** The signed-in user's context for the shop in the URL. The tenant always comes from the session. */
export async function requireContext(
  db: Db,
  input: { slug: string; sessionToken: string | undefined; permission: Permission | null; allowReadOnly?: boolean },
  now: Date,
): Promise<Ctx> {
  const session = input.sessionToken ? await validateSession(db, input.sessionToken, now) : null;
  if (!session) throw new AccessError('not_signed_in');

  const [shop] = await asPlatform(db, (tx) => tx
    .select({ id: tenants.id, slug: tenants.slug, status: tenants.status, timezone: tenants.timezone, sub: subscriptions })
    .from(tenants).innerJoin(subscriptions, eq(subscriptions.tenantId, tenants.id))
    .where(eq(tenants.slug, input.slug)));
  if (!shop || shop.id !== session.tenantId) throw new AccessError('wrong_shop');
  if (shop.status !== 'active') throw new AccessError('suspended');

  const ctx: Ctx = {
    tenantId: shop.id, slug: shop.slug, timezone: shop.timezone, userId: session.userId, name: session.name,
    rolePreset: session.rolePreset, permissions: session.permissions, registerId: session.registerId,
    subscription: subscriptionState(shop.sub, todayIn(shop.timezone, now)),
    sessionId: session.sessionId, sessionKind: session.kind,
  };
  if (input.permission !== null) assertPermission(ctx, input.permission, { allowReadOnly: input.allowReadOnly });
  return ctx;
}

/**
 * Re-checked by every service that changes shop data, so a context obtained for one action cannot be reused for another.
 * allowReadOnly is for removing access (deactivating staff), which an unpaid shop must still be able to do.
 */
export function assertPermission(ctx: Ctx, permission: Permission, opts: { allowReadOnly?: boolean } = {}): void {
  if (ctx.subscription === 'read_only' && !opts.allowReadOnly && !READ_ONLY_PERMISSIONS.includes(permission)) throw new AccessError('read_only');
  if (!ctx.permissions.includes(permission)) throw new AccessError('forbidden');
}

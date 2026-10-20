import type { Db } from '@/db/client';
import { auditLog, branches, registers, subscriptions, tenants, type UserStatus, users } from '@/db/schema';
import { asPlatform } from '@/db/tenant';
import { normaliseEmail, normaliseGhanaPhone } from '@/lib/contact';
import { DEFAULT_MODULES, type Permission, ROLE_PRESETS, type RolePreset, type ShopType } from '@/lib/permissions';
import type { SubscriptionStatus } from '@/lib/subscription';
import { expect } from 'vitest';
import { type AccessCode, AccessError, type Ctx, requireContext } from '@/server/context';
import { hashSecret } from '@/server/crypto';
import { createSession } from '@/server/sessions';

export type SeedUser = {
  key: string; name?: string; email?: string; phone?: string; rolePreset?: RolePreset;
  password?: string; pin?: string; status?: UserStatus; branchIds?: string[];
};
export type SeededShop = { tenantId: string; slug: string; branchId: string; registerId: string; users: Record<string, { id: string }> };
export type SeedShopOptions = {
  slug?: string; shopType?: ShopType; status?: 'active' | 'suspended';
  subscription?: { status: SubscriptionStatus; endDate: string; planId?: string }; users?: SeedUser[];
};

let counter = 0;

/** A shop with branch Main/B1, till Till 1/T1, an active subscription, and by default one owner. */
export async function seedShop(db: Db, opts: SeedShopOptions = {}): Promise<SeededShop> {
  const slug = opts.slug ?? `shop-${++counter}`;
  const shopType = opts.shopType ?? 'retail';
  const seedUsers: SeedUser[] = opts.users ?? [{ key: 'owner', email: `owner@${slug}.test`, password: 'correct-horse-1', rolePreset: 'owner' }];
  const hashed = await Promise.all(seedUsers.map(async (u) => ({
    u,
    passwordHash: u.password ? await hashSecret(u.password) : null,
    pinHash: u.pin ? await hashSecret(u.pin) : null,
  })));

  return asPlatform(db, async (tx) => {
    const [tenant] = await tx.insert(tenants)
      .values({ slug, name: slug, shopType, modules: [...DEFAULT_MODULES[shopType]], status: opts.status ?? 'active' })
      .returning();
    await tx.insert(subscriptions).values({
      tenantId: tenant.id,
      planId: opts.subscription?.planId ?? 'standard',
      status: opts.subscription?.status ?? 'active',
      endDate: opts.subscription?.endDate ?? '2099-12-31',
    });
    const [branch] = await tx.insert(branches).values({ tenantId: tenant.id, name: 'Main', branchCode: 'B1' }).returning();
    const [register] = await tx.insert(registers)
      .values({ tenantId: tenant.id, branchId: branch.id, name: 'Till 1', registerCode: 'T1' })
      .returning();
    const seeded: Record<string, { id: string }> = {};
    for (const { u, passwordHash, pinHash } of hashed) {
      const role = u.rolePreset ?? 'owner';
      const [row] = await tx.insert(users).values({
        tenantId: tenant.id,
        name: u.name ?? u.key,
        email: u.email ? normaliseEmail(u.email) : null,
        phone: u.phone ? normaliseGhanaPhone(u.phone) : null,
        rolePreset: role,
        permissions: [...ROLE_PRESETS[role]],
        branchIds: u.branchIds ?? [branch.id],
        passwordHash,
        pinHash,
        status: u.status ?? 'active',
      }).returning();
      seeded[u.key] = { id: row.id };
    }
    await tx.insert(auditLog).values({ tenantId: tenant.id, actorType: 'system', actorId: null, action: 'seeded' });
    return { tenantId: tenant.id, slug, branchId: branch.id, registerId: register.id, users: seeded };
  });
}

/** Signs in `userKey` of `shop` and resolves the request context for `permission`. */
export async function ctxFor(
  db: Db, shop: SeededShop, userKey: string, now: Date, permission: Permission | null = null, opts: { allowReadOnly?: boolean } = {},
): Promise<Ctx> {
  const { token } = await createSession(db, { tenantId: shop.tenantId, userId: shop.users[userKey].id, kind: 'password' }, now);
  return requireContext(db, { slug: shop.slug, sessionToken: token, permission, allowReadOnly: opts.allowReadOnly }, now);
}

/** Asserts that `p` rejects with an AccessError of `code`. */
export async function expectAccess(p: Promise<unknown>, code: AccessCode): Promise<void> {
  await expect(p).rejects.toSatisfy((e: unknown) => e instanceof AccessError && e.code === code);
}

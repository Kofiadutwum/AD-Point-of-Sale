import { eq } from 'drizzle-orm';
import { afterEach, beforeEach, expect, it } from 'vitest';
import type { Db } from '@/db/client';
import { deviceCacheVersions, heldSales, mfaChallenges, mfaRecoveryCodes, registers, tenants, users, variants } from '@/db/schema';
import { asPlatform, withTenant } from '@/db/tenant';
import { ctxFor, productFor, type SeededShop, seedShop } from '../helpers/fixtures';
import { createTestDb } from '../helpers/test-db';

const t0 = new Date('2026-10-20T10:00:00Z');
let db: Db;
let close: () => Promise<void>;
let a: SeededShop;
let b: SeededShop;
beforeEach(async () => {
  ({ db, close } = await createTestDb());
  a = await seedShop(db, { slug: 'shop-a' });
  b = await seedShop(db, { slug: 'shop-b' });
});
afterEach(async () => { await close(); });

const version = (tenantId: string) => asPlatform(db, (tx) => tx.select().from(deviceCacheVersions)
  .where(eq(deviceCacheVersions.tenantId, tenantId))).then((r) => r[0]?.version ?? 0);

it('bumps the shop version when catalogue rows change', async () => {
  const before = await version(a.tenantId);
  const beforeB = await version(b.tenantId);
  await productFor(db, await ctxFor(db, a, 'owner', t0, 'manage_products'));
  expect(await version(a.tenantId)).toBeGreaterThan(before);
  expect(await version(b.tenantId)).toBe(beforeB);
});

it('bumps on PIN, staff status, and offline setting changes', async () => {
  const owner = a.users.owner.id;
  for (const change of [
    () => asPlatform(db, (tx) => tx.update(users).set({ pinHash: 'x' }).where(eq(users.id, owner))),
    () => asPlatform(db, (tx) => tx.update(users).set({ status: 'inactive' }).where(eq(users.id, owner))),
    () => asPlatform(db, (tx) => tx.update(tenants).set({ offlineEnabled: false }).where(eq(tenants.id, a.tenantId))),
  ]) {
    const before = await version(a.tenantId);
    await change();
    expect(await version(a.tenantId)).toBe(before + 1);
  }
});

it('ignores receipt counter, average cost, and failed PIN count changes', async () => {
  const { variantId } = await productFor(db, await ctxFor(db, a, 'owner', t0, 'manage_products'));
  const before = await version(a.tenantId);
  await asPlatform(db, async (tx) => {
    await tx.update(registers).set({ receiptCounter: 42 }).where(eq(registers.id, a.registerId));
    await tx.update(variants).set({ averageCost: '123.4567' }).where(eq(variants.id, variantId));
    await tx.update(users).set({ failedPinCount: 3, mfaLastStep: 99 }).where(eq(users.id, a.users.owner.id));
  });
  expect(await version(a.tenantId)).toBe(before);
});

it('pos_app sees only its own held sales and MFA rows', async () => {
  for (const s of [a, b]) {
    await asPlatform(db, async (tx) => {
      await tx.insert(heldSales).values({
        tenantId: s.tenantId, registerId: s.registerId, saleId: crypto.randomUUID(), receiptNumber: 'B1-T1-000001', totalPesewas: 500,
        error: 'cashier_not_allowed', sale: {}, deviceCreatedAt: t0, reportedAt: t0,
      });
      await tx.insert(mfaRecoveryCodes).values({ tenantId: s.tenantId, userId: s.users.owner.id, codeHash: `h-${s.slug}` });
      await tx.insert(mfaChallenges).values({ id: `c-${s.slug}`, tenantId: s.tenantId, userId: s.users.owner.id, expiresAt: t0 });
    });
  }
  for (const t of [heldSales, mfaRecoveryCodes, mfaChallenges, deviceCacheVersions]) {
    const seen = await withTenant(db, a.tenantId, (tx) => tx.select().from(t));
    expect(seen.length, String(t)).toBe(1);
  }
});

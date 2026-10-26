import { eq } from 'drizzle-orm';
import { afterEach, beforeEach, expect, it } from 'vitest';
import type { Db } from '@/db/client';
import { auditLog, subscriptions } from '@/db/schema';
import { asPlatform } from '@/db/tenant';
import { signIn } from '@/server/auth';
import { requireContext } from '@/server/context';
import { createPlatformAdmin } from '@/server/platform-admin';
import { createSession } from '@/server/sessions';
import { type ManualPayment, recordManualPayment, setShopSuspended } from '@/server/subscriptions';
import { expectAccess, seedShop } from '../helpers/fixtures';
import { createTestDb } from '../helpers/test-db';

const t0 = new Date('2026-10-20T10:00:00Z');
const pay = (reference: string, months = 12): ManualPayment =>
  ({ method: 'momo', reference, amountPesewas: 120000, periodMonths: months, planId: 'standard' });

let db: Db;
let close: () => Promise<void>;
let adminId: string;
beforeEach(async () => {
  ({ db, close } = await createTestDb());
  ({ id: adminId } = await createPlatformAdmin(db, { email: 'admin@test.local', name: 'Admin', password: 'admin-password-1' }));
});
afterEach(async () => { await close(); });

async function subscriptionOf(tenantId: string) {
  const [sub] = await asPlatform(db, (tx) => tx.select().from(subscriptions).where(eq(subscriptions.tenantId, tenantId)));
  return sub;
}

it('extends from today when the subscription has ended', async () => {
  const s = await seedShop(db, { subscription: { status: 'active', endDate: '2026-09-01' } });
  expect(await recordManualPayment(db, adminId, s.tenantId, pay('MOMO-1'), t0)).toEqual({ ok: true, endDate: '2027-10-20' });
});

it('extends from the end date on early renewal', async () => {
  const s = await seedShop(db, { subscription: { status: 'active', endDate: '2026-12-31' } });
  expect(await recordManualPayment(db, adminId, s.tenantId, pay('MOMO-2'), t0)).toEqual({ ok: true, endDate: '2027-12-31' });
});

it('turns a trial into an active paid plan', async () => {
  const s = await seedShop(db, { subscription: { status: 'trial', endDate: '2026-11-03', planId: 'trial' } });
  await recordManualPayment(db, adminId, s.tenantId, pay('MOMO-T', 12), t0);
  expect(await subscriptionOf(s.tenantId)).toMatchObject({ status: 'active', planId: 'standard', endDate: '2027-11-03' });
});

it('applies a payment reference only once, even concurrently', async () => {
  const s = await seedShop(db, { subscription: { status: 'active', endDate: '2026-09-01' } });
  const results = await Promise.all([
    recordManualPayment(db, adminId, s.tenantId, pay('MOMO-3'), t0),
    recordManualPayment(db, adminId, s.tenantId, pay('MOMO-3'), t0),
  ]);
  expect(results.filter((r) => r.ok)).toHaveLength(1);
  expect(results.filter((r) => !r.ok)).toEqual([{ ok: false, error: 'duplicate_reference' }]);
  expect((await subscriptionOf(s.tenantId)).endDate).toBe('2027-10-20');
});

it('treats references differing only in case or spaces as the same payment', async () => {
  const s = await seedShop(db);
  expect(await recordManualPayment(db, adminId, s.tenantId, pay(' MOMO-1 23 '), t0)).toMatchObject({ ok: true });
  for (const again of ['momo-123', 'Momo-1 2 3'])
    expect(await recordManualPayment(db, adminId, s.tenantId, pay(again), t0)).toEqual({ ok: false, error: 'duplicate_reference' });
});

it('rejects invalid payments', async () => {
  const s = await seedShop(db);
  const bad: ManualPayment[] = [
    { ...pay('X1'), amountPesewas: 0 },
    { ...pay('X2'), amountPesewas: 12.5 },
    { ...pay('X3'), periodMonths: 37 },
    { ...pay('   '), periodMonths: 1 },
    { ...pay('X4'), planId: 'gold' },
    { ...pay('X5'), amountPesewas: 2_147_483_648 }, // above the int4 column
  ];
  for (const p of bad) expect(await recordManualPayment(db, adminId, s.tenantId, p, t0)).toEqual({ ok: false, error: 'invalid_payment' });
});

it('audits each applied payment', async () => {
  const s = await seedShop(db);
  await recordManualPayment(db, adminId, s.tenantId, pay('MOMO-A'), t0);
  const found = await asPlatform(db, (tx) => tx.select().from(auditLog).where(eq(auditLog.action, 'subscription_activated')));
  expect(found).toHaveLength(1);
  expect(found[0]).toMatchObject({ tenantId: s.tenantId, actorType: 'platform', actorId: adminId });
});

it('suspending a shop blocks sign-in and ends its sessions', async () => {
  const s = await seedShop(db, { slug: 'shop-s' });
  const owner = { slug: 'shop-s', identifier: 'owner@shop-s.test', password: 'correct-horse-1', ip: '1.1.1.1' };
  const { token } = await createSession(db, { tenantId: s.tenantId, userId: s.users.owner.id, kind: 'password' }, t0);
  await setShopSuspended(db, adminId, s.tenantId, true, 'unpaid');
  expect(await signIn(db, owner, t0)).toEqual({ ok: false, error: 'access_denied' });
  await expectAccess(requireContext(db, { slug: 'shop-s', sessionToken: token, permission: null }, t0), 'not_signed_in');
  await setShopSuspended(db, adminId, s.tenantId, false, 'paid');
  expect(await signIn(db, owner, t0)).toMatchObject({ ok: true });
});

import { eq } from 'drizzle-orm';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { Db } from '@/db/client';
import { auditLog, branches, registers, subscriptions, tenants, users } from '@/db/schema';
import { asPlatform } from '@/db/tenant';
import { signIn } from '@/server/auth';
import { sendEmail } from '@/server/email';
import {
  activateAccount, getShopProfile, issueActivationLink, issueOwnerActivationLink, type OnboardInput, onboardShop, updateShopProfile,
} from '@/server/onboarding';
import { createPlatformAdmin } from '@/server/platform-admin';
import type { ManualPayment } from '@/server/subscriptions';
import { ctxFor, expectAccess, seedShop } from '../helpers/fixtures';
import { createTestDb } from '../helpers/test-db';

vi.mock('@/server/email', () => ({ sendEmail: vi.fn() }));

const t0 = new Date('2026-10-20T10:00:00Z');
const HOUR = 3_600_000;
const pay = (reference: string): ManualPayment => ({ method: 'momo', reference, amountPesewas: 120000, periodMonths: 12, planId: 'standard' });
const base: OnboardInput = {
  name: 'Ama Pharmacy', requestedSlug: 'Ama Pharmacy', shopType: 'pharmacy',
  owner: { name: 'Ama', phone: '024 123 4567' }, start: { kind: 'trial' },
};
const tokenOf = (url: string) => url.split('/activate/')[1];

let db: Db;
let close: () => Promise<void>;
let adminId: string;
beforeEach(async () => {
  vi.mocked(sendEmail).mockClear();
  ({ db, close } = await createTestDb());
  ({ id: adminId } = await createPlatformAdmin(db, { email: 'admin@test.local', name: 'Admin', password: 'admin-password-1' }));
});
afterEach(async () => { await close(); });

it('creates a trial shop with branch, till, owner, and token', async () => {
  const r = await onboardShop(db, adminId, base, t0);
  expect(r).toMatchObject({ ok: true, slug: 'ama-pharmacy' });
  const [t] = await asPlatform(db, (tx) => tx.select().from(tenants));
  expect(t).toMatchObject({ modules: ['batches', 'prescriptions', 'units'], timezone: 'Africa/Accra', currency: 'GHS', shopType: 'pharmacy' });
  const [sub] = await asPlatform(db, (tx) => tx.select().from(subscriptions));
  expect(sub).toMatchObject({ planId: 'trial', status: 'trial', endDate: '2026-11-03' });
  const [branch] = await asPlatform(db, (tx) => tx.select().from(branches));
  expect(branch).toMatchObject({ name: 'Main', branchCode: 'B1' });
  expect(await asPlatform(db, (tx) => tx.select().from(registers))).toMatchObject([{ name: 'Till 1', registerCode: 'T1', branchId: branch.id }]);
  const [owner] = await asPlatform(db, (tx) => tx.select().from(users));
  expect(owner).toMatchObject({ phone: '233241234567', status: 'pending_activation', rolePreset: 'owner', branchIds: [branch.id] });
  expect(await asPlatform(db, (tx) => tx.select().from(auditLog).where(eq(auditLog.action, 'shop_created')))).toHaveLength(1);
});

it('emails the activation link when the owner has an email', async () => {
  const r = await onboardShop(db, adminId, { ...base, owner: { name: 'Ama', email: 'ama@pharm.test' } }, t0);
  expect(vi.mocked(sendEmail)).toHaveBeenCalledOnce();
  expect(vi.mocked(sendEmail).mock.calls[0][0]).toMatchObject({ to: 'ama@pharm.test' });
  expect(vi.mocked(sendEmail).mock.calls[0][0].text).toContain((r as { activationUrl: string }).activationUrl);
});

it('refuses reserved and taken slugs', async () => {
  expect(await onboardShop(db, adminId, { ...base, requestedSlug: 'Admin' }, t0)).toEqual({ ok: false, error: 'choose_another_slug', reason: 'reserved' });
  await onboardShop(db, adminId, base, t0);
  expect(await onboardShop(db, adminId, base, t0)).toEqual({ ok: false, error: 'choose_another_slug', reason: 'taken' });
});

it('requires an owner email or phone', async () => {
  expect(await onboardShop(db, adminId, { ...base, owner: { name: 'Ama' } }, t0)).toEqual({ ok: false, error: 'owner_contact_required' });
  expect(await onboardShop(db, adminId, { ...base, owner: { name: 'Ama', phone: '12345' } }, t0)).toEqual({ ok: false, error: 'owner_contact_required' });
});

it('starts a paid shop from the payment', async () => {
  await onboardShop(db, adminId, { ...base, start: { kind: 'paid', payment: pay('REF-0') } }, t0);
  const [sub] = await asPlatform(db, (tx) => tx.select().from(subscriptions));
  expect(sub).toMatchObject({ planId: 'standard', status: 'active', endDate: '2027-10-20' });
});

it('rolls back everything when the paid start fails', async () => {
  await onboardShop(db, adminId, { ...base, requestedSlug: 'first', start: { kind: 'paid', payment: pay('REF-1') } }, t0);
  expect(await onboardShop(db, adminId, { ...base, requestedSlug: 'second', start: { kind: 'paid', payment: pay('REF-1') } }, t0))
    .toEqual({ ok: false, error: 'duplicate_reference' });
  expect((await asPlatform(db, (tx) => tx.select().from(tenants))).map((x) => x.slug)).toEqual(['first']);
});

it('activates once, then the owner can sign in', async () => {
  const token = tokenOf((await onboardShop(db, adminId, base, t0) as { activationUrl: string }).activationUrl);
  expect(await activateAccount(db, { token, password: 'short' }, t0)).toEqual({ ok: false, error: 'weak_password' });
  expect(await activateAccount(db, { token, password: 'long-enough-1', pin: '12a4' }, t0)).toEqual({ ok: false, error: 'invalid_pin' });
  expect(await activateAccount(db, { token, password: 'long-enough-1', pin: '1234' }, t0)).toEqual({ ok: true, slug: 'ama-pharmacy' });
  expect(await activateAccount(db, { token, password: 'long-enough-1' }, t0)).toEqual({ ok: false, error: 'invalid_or_expired' });
  expect(await signIn(db, { slug: 'ama-pharmacy', identifier: '0241234567', password: 'long-enough-1', ip: '1.1.1.1' }, t0)).toMatchObject({ ok: true });
});

it('expires activation links after 72 hours', async () => {
  const token = tokenOf((await onboardShop(db, adminId, base, t0) as { activationUrl: string }).activationUrl);
  expect(await activateAccount(db, { token, password: 'long-enough-1' }, new Date(t0.getTime() + 73 * HOUR)))
    .toEqual({ ok: false, error: 'invalid_or_expired' });
});

it('a new activation link cancels the old one', async () => {
  const r = await onboardShop(db, adminId, base, t0) as { tenantId: string; activationUrl: string };
  const [owner] = await asPlatform(db, (tx) => tx.select().from(users));
  const fresh = await issueActivationLink(db, adminId, r.tenantId, owner.id, t0);
  expect(await activateAccount(db, { token: tokenOf(r.activationUrl), password: 'long-enough-1' }, t0)).toEqual({ ok: false, error: 'invalid_or_expired' });
  expect(await activateAccount(db, { token: tokenOf(fresh.activationUrl), password: 'long-enough-1' }, t0)).toMatchObject({ ok: true });
});

it('updates the shop profile with validation', async () => {
  const s = await seedShop(db, { users: [{ key: 'owner', email: 'o@x.test', rolePreset: 'owner' }, { key: 'cashier', phone: '0201234567', rolePreset: 'cashier' }] });
  const profile = { name: 'Kofi Provisions', address: 'Osu, Accra', phone: '024 111 2222', managerPhone: '0203334444', taxMode: 'exclusive' as const, businessDayCutoff: '04:00' };
  const owner = await ctxFor(db, s, 'owner', t0);
  expect(await updateShopProfile(db, owner, profile)).toEqual({ ok: true });
  const [t] = await asPlatform(db, (tx) => tx.select().from(tenants).where(eq(tenants.id, s.tenantId)));
  expect(t).toMatchObject({ name: 'Kofi Provisions', phone: '233241112222', managerPhone: '233203334444', taxMode: 'exclusive', businessDayCutoff: '04:00' });
  expect(await getShopProfile(db, owner)).toEqual({ name: 'Kofi Provisions', address: 'Osu, Accra', phone: '233241112222', managerPhone: '233203334444', taxMode: 'exclusive', businessDayCutoff: '04:00' });
  expect(await updateShopProfile(db, owner, { ...profile, businessDayCutoff: '24:00' })).toEqual({ ok: false, error: 'invalid_input' });
  await expectAccess(updateShopProfile(db, await ctxFor(db, s, 'cashier', t0), profile), 'forbidden');
});

it('issues a new link for the shop owner', async () => {
  const r = await onboardShop(db, adminId, base, t0) as { tenantId: string; activationUrl: string };
  const fresh = await issueOwnerActivationLink(db, adminId, r.tenantId, t0);
  expect(fresh.activationUrl).not.toBe(r.activationUrl);
  expect(await activateAccount(db, { token: tokenOf(fresh.activationUrl), password: 'long-enough-1' }, t0)).toEqual({ ok: true, slug: 'ama-pharmacy' });
});

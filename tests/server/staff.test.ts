import { eq } from 'drizzle-orm';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { Db } from '@/db/client';
import { branches, users } from '@/db/schema';
import { asPlatform } from '@/db/tenant';
import { activateAccount } from '@/server/onboarding';
import { createSession, validateSession } from '@/server/sessions';
import { addStaff, deactivateStaff, listStaff, resetStaffAccess, setStaffBranches, setStaffPermissions } from '@/server/staff';
import { ctxFor, expectAccess, seedShop } from '../helpers/fixtures';
import { createTestDb } from '../helpers/test-db';

vi.mock('@/server/email', () => ({ sendEmail: vi.fn() }));

const t0 = new Date('2026-10-20T10:00:00Z');
const trial = { status: 'trial' as const, endDate: '2026-11-03', planId: 'trial' };
const cashier = (i: number, branchId: string) => ({ name: `S${i}`, phone: `024000000${i}`, rolePreset: 'cashier' as const, branchIds: [branchId] });
const tokenOf = (url: string) => url.split('/activate/')[1];
const userRow = async (id: string) => (await asPlatform(db, (tx) => tx.select().from(users).where(eq(users.id, id))))[0];

let db: Db;
let close: () => Promise<void>;
beforeEach(async () => { ({ db, close } = await createTestDb()); });
afterEach(async () => { await close(); });

it('stops at the plan staff limit and frees a place on deactivation', async () => {
  const shop = await seedShop(db, { subscription: trial });
  const ctx = await ctxFor(db, shop, 'owner', t0, 'manage_staff');
  const ids: string[] = [];
  for (let i = 1; i <= 4; i++) {
    const r = await addStaff(db, ctx, cashier(i, shop.branchId), t0);
    expect(r).toMatchObject({ ok: true });
    ids.push((r as { userId: string }).userId);
  }
  expect(await addStaff(db, ctx, cashier(5, shop.branchId), t0)).toEqual({ ok: false, error: 'limit_reached' });
  expect(await deactivateStaff(db, ctx, ids[0], 'left the job')).toEqual({ ok: true });
  expect(await addStaff(db, ctx, cashier(5, shop.branchId), t0)).toMatchObject({ ok: true });
});

it('creates an invited member with preset permissions and a working invite link', async () => {
  const shop = await seedShop(db);
  const ctx = await ctxFor(db, shop, 'owner', t0, 'manage_staff');
  const r = await addStaff(db, ctx, { name: 'Kofi', phone: '020 123 4567', rolePreset: 'cashier', branchIds: [shop.branchId] }, t0) as { userId: string; inviteUrl: string };
  expect(await userRow(r.userId)).toMatchObject({ status: 'invited', permissions: ['make_sale', 'mark_sold_out', 'run_kitchen', 'record_kitchen_stock', 'enter_channel_orders'], phone: '233201234567', rolePreset: 'cashier' });
  expect(await activateAccount(db, { token: tokenOf(r.inviteUrl), password: 'kofi-password', pin: '5678' }, t0)).toMatchObject({ ok: true });
  expect(await userRow(r.userId)).toMatchObject({ status: 'active' });
});

it('rejects duplicate contacts within a shop but allows them across shops', async () => {
  const a = await seedShop(db);
  const b = await seedShop(db);
  const ctxA = await ctxFor(db, a, 'owner', t0, 'manage_staff');
  const ctxB = await ctxFor(db, b, 'owner', t0, 'manage_staff');
  expect(await addStaff(db, ctxA, cashier(1, a.branchId), t0)).toMatchObject({ ok: true });
  expect(await addStaff(db, ctxA, { ...cashier(1, a.branchId), name: 'Other' }, t0)).toEqual({ ok: false, error: 'duplicate_contact' });
  expect(await addStaff(db, ctxB, cashier(1, b.branchId), t0)).toMatchObject({ ok: true });
});

it('requires an email or phone and known branches', async () => {
  const a = await seedShop(db);
  const b = await seedShop(db);
  const ctx = await ctxFor(db, a, 'owner', t0, 'manage_staff');
  expect(await addStaff(db, ctx, { name: 'X', rolePreset: 'cashier', branchIds: [a.branchId] }, t0)).toEqual({ ok: false, error: 'contact_required' });
  expect(await addStaff(db, ctx, { name: 'X', phone: '123', rolePreset: 'cashier', branchIds: [a.branchId] }, t0)).toEqual({ ok: false, error: 'contact_required' });
  expect(await addStaff(db, ctx, { ...cashier(1, b.branchId) }, t0)).toEqual({ ok: false, error: 'unknown_branch' });
  expect(await addStaff(db, ctx, { ...cashier(1, a.branchId), branchIds: [] }, t0)).toEqual({ ok: false, error: 'unknown_branch' });
});

it('ends a deactivated member’s sessions immediately', async () => {
  const shop = await seedShop(db, { users: [{ key: 'owner', email: 'o@x.test' }, { key: 'kofi', phone: '0201234567', rolePreset: 'cashier' }] });
  const ctx = await ctxFor(db, shop, 'owner', t0, 'manage_staff');
  const { token } = await createSession(db, { tenantId: shop.tenantId, userId: shop.users.kofi.id, kind: 'password' }, t0);
  await deactivateStaff(db, ctx, shop.users.kofi.id, 'left the job');
  expect(await validateSession(db, token, t0)).toBeNull();
  expect(await userRow(shop.users.kofi.id)).toMatchObject({ status: 'inactive' });
});

it('protects the owner and the acting user', async () => {
  const shop = await seedShop(db, { users: [{ key: 'owner', email: 'o@x.test' }, { key: 'manager', email: 'm@x.test', rolePreset: 'manager' }] });
  const ctx = await ctxFor(db, shop, 'manager', t0, 'manage_staff');
  expect(await deactivateStaff(db, ctx, shop.users.owner.id, 'x')).toEqual({ ok: false, error: 'cannot_change_owner' });
  expect(await deactivateStaff(db, ctx, shop.users.manager.id, 'x')).toEqual({ ok: false, error: 'cannot_change_self' });
  expect(await resetStaffAccess(db, ctx, shop.users.owner.id, t0)).toEqual({ ok: false, error: 'cannot_change_owner' });
  expect(await setStaffPermissions(db, ctx, shop.users.owner.id, ['make_sale'])).toEqual({ ok: false, error: 'cannot_change_owner' });
});

it('lets a cashier do none of this', async () => {
  const shop = await seedShop(db, { users: [{ key: 'owner', email: 'o@x.test' }, { key: 'kofi', phone: '0201234567', rolePreset: 'cashier' }] });
  const ctx = await ctxFor(db, shop, 'kofi', t0);
  await expectAccess(addStaff(db, ctx, cashier(1, shop.branchId), t0), 'forbidden');
  await expectAccess(deactivateStaff(db, ctx, shop.users.owner.id, 'x'), 'forbidden');
});

it('reset access issues a new invite and clears the PIN', async () => {
  const shop = await seedShop(db, { users: [{ key: 'owner', email: 'o@x.test' }, { key: 'kofi', phone: '0201234567', rolePreset: 'cashier', password: 'kofi-password', pin: '5678' }] });
  const ctx = await ctxFor(db, shop, 'owner', t0, 'manage_staff');
  const { token } = await createSession(db, { tenantId: shop.tenantId, userId: shop.users.kofi.id, kind: 'password' }, t0);
  const r = await resetStaffAccess(db, ctx, shop.users.kofi.id, t0) as { inviteUrl: string };
  expect(await userRow(shop.users.kofi.id)).toMatchObject({ status: 'invited', pinHash: null, passwordHash: null, failedPinCount: 0 });
  expect(await validateSession(db, token, t0)).toBeNull();
  expect(await activateAccount(db, { token: tokenOf(r.inviteUrl), password: 'new-password-1' }, t0)).toMatchObject({ ok: true });
});

it('stops a manager from raising permissions above their own or changing their own', async () => {
  const shop = await seedShop(db, { users: [
    { key: 'owner', email: 'o@x.test' }, { key: 'manager', email: 'm@x.test', rolePreset: 'manager' },
    { key: 'kofi', phone: '0201234567', rolePreset: 'cashier' },
  ] });
  const ctx = await ctxFor(db, shop, 'manager', t0, 'manage_staff');
  expect(await setStaffPermissions(db, ctx, shop.users.kofi.id, ['make_sale', 'manage_shop_settings'])).toEqual({ ok: false, error: 'cannot_grant' });
  expect(await setStaffPermissions(db, ctx, shop.users.manager.id, ['make_sale'])).toEqual({ ok: false, error: 'cannot_change_self' });
  expect(await setStaffPermissions(db, ctx, shop.users.kofi.id, ['make_sale', 'view_reports'])).toEqual({ ok: true });
});

it('refuses to add staff whose role carries permissions the actor lacks', async () => {
  const shop = await seedShop(db, { users: [{ key: 'owner', email: 'o@x.test' }, { key: 'lead', email: 'l@x.test', rolePreset: 'cashier' }] });
  await asPlatform(db, (tx) => tx.update(users).set({ permissions: ['make_sale', 'mark_sold_out', 'run_kitchen', 'record_kitchen_stock', 'enter_channel_orders', 'manage_staff'] }).where(eq(users.id, shop.users.lead.id)));
  const ctx = await ctxFor(db, shop, 'lead', t0, 'manage_staff');
  expect(await addStaff(db, ctx, { name: 'M', email: 'm2@x.test', rolePreset: 'manager', branchIds: [shop.branchId] }, t0))
    .toEqual({ ok: false, error: 'cannot_grant' });
  expect(await addStaff(db, ctx, cashier(1, shop.branchId), t0)).toMatchObject({ ok: true });
});

it('refuses to reset, deactivate, or edit a member who holds more permissions', async () => {
  const shop = await seedShop(db, { users: [
    { key: 'owner', email: 'o@x.test' }, { key: 'm1', email: 'm1@x.test', rolePreset: 'manager' }, { key: 'm2', email: 'm2@x.test', rolePreset: 'manager' },
  ] });
  await asPlatform(db, (tx) => tx.update(users).set({ permissions: ['make_sale', 'manage_staff', 'manage_shop_settings'] }).where(eq(users.id, shop.users.m2.id)));
  const ctx = await ctxFor(db, shop, 'm1', t0, 'manage_staff');
  expect(await resetStaffAccess(db, ctx, shop.users.m2.id, t0)).toEqual({ ok: false, error: 'cannot_change' });
  expect(await deactivateStaff(db, ctx, shop.users.m2.id, 'x')).toEqual({ ok: false, error: 'cannot_change' });
  expect(await setStaffPermissions(db, ctx, shop.users.m2.id, ['make_sale'])).toEqual({ ok: false, error: 'cannot_change' });
  expect(await setStaffBranches(db, ctx, shop.users.m2.id, [shop.branchId])).toEqual({ ok: false, error: 'cannot_change' });
});

it('reactivating a former member counts against the plan staff limit', async () => {
  const shop = await seedShop(db, { subscription: trial });
  const ctx = await ctxFor(db, shop, 'owner', t0, 'manage_staff');
  const ids: string[] = [];
  for (let i = 1; i <= 4; i++) ids.push((await addStaff(db, ctx, cashier(i, shop.branchId), t0) as { userId: string }).userId);
  await deactivateStaff(db, ctx, ids[0], 'left');
  const fifth = await addStaff(db, ctx, cashier(5, shop.branchId), t0) as { userId: string };
  expect(await resetStaffAccess(db, ctx, ids[0], t0)).toEqual({ ok: false, error: 'limit_reached' });
  await deactivateStaff(db, ctx, fifth.userId, 'left');
  expect(await resetStaffAccess(db, ctx, ids[0], t0)).toMatchObject({ ok: true });
  expect(await userRow(ids[0])).toMatchObject({ status: 'invited' });
});

it('lets the owner remove staff while the shop is read-only, but not add any', async () => {
  const shop = await seedShop(db, { subscription: { status: 'active', endDate: '2026-09-01' }, users: [
    { key: 'owner', email: 'o@x.test' }, { key: 'kofi', phone: '0201234567', rolePreset: 'cashier' },
  ] });
  const ctx = await ctxFor(db, shop, 'owner', t0, 'manage_staff', { allowReadOnly: true });
  expect(await deactivateStaff(db, ctx, shop.users.kofi.id, 'left the job')).toEqual({ ok: true });
  await expectAccess(addStaff(db, ctx, cashier(1, shop.branchId), t0), 'read_only');
  await expectAccess(ctxFor(db, shop, 'owner', t0, 'manage_staff'), 'read_only');
});

it('changes a member’s branches within the shop', async () => {
  const shop = await seedShop(db, { users: [{ key: 'owner', email: 'o@x.test' }, { key: 'kofi', phone: '0201234567', rolePreset: 'cashier' }] });
  const other = await seedShop(db);
  const ctx = await ctxFor(db, shop, 'owner', t0, 'manage_staff');
  const [b2] = await asPlatform(db, (tx) => tx.insert(branches).values({ tenantId: shop.tenantId, name: 'Kumasi', branchCode: 'B2' }).returning());
  expect(await setStaffBranches(db, ctx, shop.users.kofi.id, [b2.id])).toEqual({ ok: true });
  expect(await userRow(shop.users.kofi.id)).toMatchObject({ branchIds: [b2.id] });
  expect(await setStaffBranches(db, ctx, shop.users.kofi.id, [other.branchId])).toEqual({ ok: false, error: 'unknown_branch' });
  expect(await setStaffBranches(db, ctx, shop.users.kofi.id, [])).toEqual({ ok: false, error: 'unknown_branch' });
});

it('sets known permissions and rejects unknown ones', async () => {
  const shop = await seedShop(db, { users: [{ key: 'owner', email: 'o@x.test' }, { key: 'kofi', phone: '0201234567', rolePreset: 'cashier' }] });
  const ctx = await ctxFor(db, shop, 'owner', t0, 'manage_staff');
  expect(await setStaffPermissions(db, ctx, shop.users.kofi.id, ['make_sale', 'fly'])).toEqual({ ok: false, error: 'invalid_permission' });
  expect(await setStaffPermissions(db, ctx, shop.users.kofi.id, ['make_sale', 'give_discount'])).toEqual({ ok: true });
  expect(await userRow(shop.users.kofi.id)).toMatchObject({ permissions: ['make_sale', 'give_discount'] });
});

it('lists the shop’s staff by name, without other shops', async () => {
  const shop = await seedShop(db, { users: [{ key: 'owner', name: 'Ama', email: 'o@x.test' }, { key: 'kofi', name: 'Kofi', phone: '0201234567', rolePreset: 'cashier' }] });
  await seedShop(db);
  const list = await listStaff(db, await ctxFor(db, shop, 'owner', t0, 'manage_staff'));
  expect(list.map((s) => [s.name, s.rolePreset, s.status, s.phone])).toEqual([['Ama', 'owner', 'active', null], ['Kofi', 'cashier', 'active', '233201234567']]);
});

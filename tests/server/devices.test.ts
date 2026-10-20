import { eq } from 'drizzle-orm';
import { afterEach, beforeEach, expect, it } from 'vitest';
import type { Db } from '@/db/client';
import { auditLog, users } from '@/db/schema';
import { asPlatform } from '@/db/tenant';
import { findDeviceRegister, listTillStaff, registerDevice, switchCashierWithPin } from '@/server/devices';
import { requireContext } from '@/server/context';
import { hashSecret } from '@/server/crypto';
import { validateSession } from '@/server/sessions';
import { ctxFor, expectAccess, type SeededShop, seedShop } from '../helpers/fixtures';
import { createTestDb } from '../helpers/test-db';

const t0 = new Date('2026-10-20T10:00:00Z');
const at = (ms: number) => new Date(t0.getTime() + ms);
const MIN = 60_000;

let db: Db;
let close: () => Promise<void>;
let shop: SeededShop;
let kofi: string;
let deviceToken: string;
beforeEach(async () => {
  ({ db, close } = await createTestDb());
  shop = await seedShop(db, { slug: 'shop-a', users: [
    { key: 'owner', email: 'o@x.test' },
    { key: 'kofi', phone: '0201234567', rolePreset: 'cashier', pin: '5678' },
    { key: 'esi', phone: '0207654321', rolePreset: 'cashier', pin: '1111', branchIds: [] },
    { key: 'yaw', phone: '0209999999', rolePreset: 'cashier', pin: '2222', status: 'inactive' },
  ] });
  kofi = shop.users.kofi.id;
  const owner = await ctxFor(db, shop, 'owner', t0, 'manage_devices');
  deviceToken = (await registerDevice(db, owner, shop.registerId, t0) as { deviceToken: string }).deviceToken;
});
afterEach(async () => { await close(); });

const pin = (staffId: string, value: string, when = t0, token: string | undefined = deviceToken) =>
  switchCashierWithPin(db, { deviceToken: token, staffId, pin: value }, when);

it('refuses unregistered devices', async () => {
  expect(await pin(kofi, '5678', t0, 'nope')).toEqual({ ok: false, error: 'device_not_registered' });
  expect(await switchCashierWithPin(db, { deviceToken: undefined, staffId: kofi, pin: '5678' }, t0)).toEqual({ ok: false, error: 'device_not_registered' });
});

it('knows which till a registered device is', async () => {
  expect(await findDeviceRegister(db, deviceToken)).toMatchObject({ tenantId: shop.tenantId, slug: 'shop-a', registerId: shop.registerId, registerName: 'Till 1' });
});

it('lists only active staff on this branch who can sell and have a PIN', async () => {
  expect(await listTillStaff(db, deviceToken)).toEqual([{ id: kofi, name: 'kofi' }]);
  expect(await listTillStaff(db, 'nope')).toBeNull();
});

it('switches to a cashier with the right PIN', async () => {
  const r = await pin(kofi, '5678') as { token: string };
  expect(await validateSession(db, r.token, t0)).toMatchObject({ kind: 'pin', registerId: shop.registerId, rolePreset: 'cashier', userId: kofi });
});

it('locks the PIN after 5 wrong tries for 15 minutes', async () => {
  for (let i = 0; i < 5; i++) expect(await pin(kofi, '0000')).toEqual({ ok: false, error: 'wrong_pin' });
  expect(await pin(kofi, '5678', at(MIN))).toEqual({ ok: false, error: 'pin_locked' });
  expect(await pin(kofi, '5678', at(16 * MIN))).toMatchObject({ ok: true });
  expect(await asPlatform(db, (tx) => tx.select().from(auditLog).where(eq(auditLog.action, 'pin_locked')))).toHaveLength(1);
  const [row] = await asPlatform(db, (tx) => tx.select().from(users).where(eq(users.id, kofi)));
  expect(row).toMatchObject({ failedPinCount: 0, pinLockedUntil: null });
});

it('refuses staff from another branch, inactive staff, and staff of another shop', async () => {
  const other = await seedShop(db, { users: [{ key: 'ama', phone: '0241111111', rolePreset: 'cashier', pin: '5678' }] });
  expect(await pin(shop.users.esi.id, '1111')).toEqual({ ok: false, error: 'not_assigned' });
  expect(await pin(shop.users.yaw.id, '2222')).toEqual({ ok: false, error: 'not_assigned' });
  expect(await pin(other.users.ama.id, '5678')).toEqual({ ok: false, error: 'not_assigned' });
  expect(await pin('not-a-uuid', '5678')).toEqual({ ok: false, error: 'not_assigned' });
});

it('re-registering a till cuts off the old device', async () => {
  const owner = await ctxFor(db, shop, 'owner', t0, 'manage_devices');
  await registerDevice(db, owner, shop.registerId, t0);
  expect(await pin(kofi, '5678')).toEqual({ ok: false, error: 'device_not_registered' });
});

it('requires manage_devices and a till of this shop to register', async () => {
  const other = await seedShop(db);
  const owner = await ctxFor(db, shop, 'owner', t0, 'manage_devices');
  expect(await registerDevice(db, owner, other.registerId, t0)).toEqual({ ok: false, error: 'unknown_register' });
  await expectAccess(registerDevice(db, await ctxFor(db, shop, 'kofi', t0), shop.registerId, t0), 'forbidden');
});

it('a PIN session only carries till permissions, even for the owner', async () => {
  await asPlatform(db, async (tx) => {
    await tx.update(users).set({ pinHash: (await hashSecret('1234')) }).where(eq(users.id, shop.users.owner.id));
  });
  const r = await pin(shop.users.owner.id, '1234') as { token: string };
  const session = await validateSession(db, r.token, t0);
  expect(session!.permissions.sort()).toEqual(['approve_actions', 'give_discount', 'make_sale']);
  await expectAccess(requireContext(db, { slug: 'shop-a', sessionToken: r.token, permission: 'manage_staff' }, t0), 'forbidden');
});

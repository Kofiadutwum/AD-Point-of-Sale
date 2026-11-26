import { afterEach, beforeEach, expect, it } from 'vitest';
import type { Db } from '@/db/client';
import type { Ctx } from '@/server/context';
import { createPlatformAdmin, platformSignIn } from '@/server/platform-admin';
import { currentSupportSession, grantSupportAccess, openEmergencyAccess, revokeSupportAccess, supportHistory, supportView } from '@/server/support';
import { ctxFor, expectAccess, type SeededShop, seedShop } from '../helpers/fixtures';
import { createTestDb } from '../helpers/test-db';

const t0 = new Date('2026-11-26T09:00:00Z');
const hours = (h: number) => new Date(t0.getTime() + h * 3_600_000);
let db: Db;
let close: () => Promise<void>;
let shop: SeededShop;
let owner: Ctx;
let manager: Ctx;
let admin: string;
beforeEach(async () => {
  ({ db, close } = await createTestDb());
  shop = await seedShop(db, { users: [
    { key: 'owner', email: 'o@sup.test', password: 'correct-horse-1', rolePreset: 'owner' },
    { key: 'manager', email: 'm@sup.test', password: 'correct-horse-2', rolePreset: 'manager' },
  ] });
  owner = await ctxFor(db, shop, 'owner', t0);
  manager = await ctxFor(db, shop, 'manager', t0);
  await createPlatformAdmin(db, { email: 'admin@test.local', name: 'Support Kwame', password: 'admin-password-1' });
  admin = ((await platformSignIn(db, { email: 'admin@test.local', password: 'admin-password-1', ip: '1.1.1.1' }, t0)) as { token: string }).token;
});
afterEach(async () => { await close(); });

it('support sees a shop only inside a session the owner granted, and every view is logged', async () => {
  await expectAccess(supportView(db, admin, shop.tenantId, t0), 'forbidden');
  expect(await grantSupportAccess(db, owner, { hours: 73, reason: 'Help with stock' }, t0)).toEqual({ ok: false, error: 'invalid_input' });
  await expectAccess(grantSupportAccess(db, manager, { hours: 2, reason: 'Help' }, t0), 'forbidden');
  const g = await grantSupportAccess(db, owner, { hours: 2, reason: 'Help with stock' }, t0) as { sessionId: string };
  expect(await currentSupportSession(db, admin, shop.tenantId, hours(1))).toMatchObject({ id: g.sessionId, emergency: false });
  expect(await supportView(db, admin, shop.tenantId, hours(1))).toMatchObject({ shop: { slug: shop.slug }, counts: { staff: 2 }, emergency: false });
  await expectAccess(supportView(db, admin, shop.tenantId, hours(2)), 'forbidden'); // expired
  const h = await supportHistory(db, owner, hours(1));
  expect(h.actions.map((a) => [a.action, (a.changes as { by: string }).by])).toEqual([['platform_support_view', 'Support Kwame']]);
  await expectAccess(supportView(db, 'not-a-token', shop.tenantId, hours(1)), 'not_signed_in');
});

it('emergency access needs a written reason, lasts 2 hours, and the owner can end it', async () => {
  expect(await openEmergencyAccess(db, admin, shop.tenantId, 'short', t0)).toEqual({ ok: false, error: 'reason_required' });
  expect(await openEmergencyAccess(db, admin, shop.tenantId, 'Owner reported sales missing after sync; checking', t0)).toEqual({ ok: true });
  expect(await supportView(db, admin, shop.tenantId, hours(1))).toMatchObject({ emergency: true });
  const h = await supportHistory(db, owner, hours(1));
  expect(h.sessions[0]).toMatchObject({ emergency: true, isActive: true });
  expect(h.actions.map((a) => a.action).sort()).toEqual(['platform_support_emergency', 'platform_support_view']);
  expect(await revokeSupportAccess(db, owner, h.sessions[0].id, hours(1))).toEqual({ ok: true });
  await expectAccess(supportView(db, admin, shop.tenantId, hours(1)), 'forbidden');
  expect(await revokeSupportAccess(db, owner, h.sessions[0].id, hours(1))).toEqual({ ok: false, error: 'not_found' });
});

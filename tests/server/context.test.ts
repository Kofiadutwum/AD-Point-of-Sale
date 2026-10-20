import { afterEach, beforeEach, expect, it } from 'vitest';
import type { Db } from '@/db/client';
import { requireContext } from '@/server/context';
import { createSession } from '@/server/sessions';
import { ctxFor, expectAccess, type SeededShop, seedShop } from '../helpers/fixtures';
import { createTestDb } from '../helpers/test-db';

const t0 = new Date('2026-10-20T10:00:00Z');
let db: Db;
let close: () => Promise<void>;
let a: SeededShop;
beforeEach(async () => {
  ({ db, close } = await createTestDb());
  a = await seedShop(db, {
    slug: 'shop-a',
    users: [
      { key: 'owner', email: 'owner@shop-a.test', password: 'correct-horse-1', rolePreset: 'owner' },
      { key: 'cashier', phone: '0201234567', rolePreset: 'cashier' },
    ],
  });
  await seedShop(db, { slug: 'shop-b' });
});
afterEach(async () => { await close(); });

it('rejects a missing session', async () => {
  await expectAccess(requireContext(db, { slug: 'shop-a', sessionToken: undefined, permission: null }, t0), 'not_signed_in');
});

it('rejects a shop A session at a shop B URL', async () => {
  const { token } = await createSession(db, { tenantId: a.tenantId, userId: a.users.owner.id, kind: 'password' }, t0);
  await expectAccess(requireContext(db, { slug: 'shop-b', sessionToken: token, permission: null }, t0), 'wrong_shop');
});

it('blocks a cashier from staff management', async () => {
  await expectAccess(ctxFor(db, a, 'cashier', t0, 'manage_staff'), 'forbidden');
});

it('allows only view and export when read-only', async () => {
  const r = await seedShop(db, { slug: 'shop-r', subscription: { status: 'active', endDate: '2026-09-01' } });
  await expectAccess(ctxFor(db, r, 'owner', t0, 'make_sale'), 'read_only');
  await expect(ctxFor(db, r, 'owner', t0, 'view_dashboard')).resolves.toMatchObject({ subscription: 'read_only' });
});

it('reports suspended shops', async () => {
  const s = await seedShop(db, { slug: 'shop-s', status: 'suspended' });
  await expectAccess(ctxFor(db, s, 'owner', t0), 'suspended');
});

it('returns the context for an allowed action', async () => {
  expect(await ctxFor(db, a, 'owner', t0, 'manage_staff')).toMatchObject({
    tenantId: a.tenantId, slug: 'shop-a', rolePreset: 'owner', subscription: 'active', timezone: 'Africa/Accra', name: 'owner',
  });
});

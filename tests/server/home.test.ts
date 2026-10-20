import { afterEach, beforeEach, expect, it } from 'vitest';
import type { Db } from '@/db/client';
import { signIn } from '@/server/auth';
import { getHomeSummary } from '@/server/home';
import { ctxFor, type SeedShopOptions, seedShop } from '../helpers/fixtures';
import { createTestDb } from '../helpers/test-db';

const t0 = new Date('2026-10-20T10:00:00Z');
let db: Db;
let close: () => Promise<void>;
beforeEach(async () => { ({ db, close } = await createTestDb()); });
afterEach(async () => { await close(); });

const bannerFor = async (subscription: SeedShopOptions['subscription']) => {
  const shop = await seedShop(db, { subscription });
  return (await getHomeSummary(db, await ctxFor(db, shop, 'owner', t0), t0)).banner;
};

it('shows trial days left', async () => {
  expect(await bannerFor({ status: 'trial', endDate: '2026-11-03', planId: 'trial' })).toBe('Free trial: 14 days left.');
});

it('shows the grace banner', async () => {
  expect(await bannerFor({ status: 'active', endDate: '2026-10-15' }))
    .toBe('Your subscription ended on 2026-10-15. Renew within 9 days to keep selling.');
});

it('shows the read-only banner', async () => {
  expect(await bannerFor({ status: 'active', endDate: '2026-09-01' }))
    .toBe('Your subscription has ended. You can view and export records. Renew to sell again.');
});

it('shows no banner while the subscription is active', async () => {
  expect(await bannerFor({ status: 'active', endDate: '2027-01-01' })).toBeNull();
});

it('shows security events to managers but not cashiers', async () => {
  const shop = await seedShop(db, { slug: 'shop-h', users: [
    { key: 'owner', name: 'Ama', email: 'ama@x.test', password: 'correct-horse-1' },
    { key: 'kofi', phone: '0201234567', rolePreset: 'cashier' },
  ] });
  await signIn(db, { slug: 'shop-h', identifier: 'AMA@x.test', password: 'wrong-password', ip: '1.1.1.1' }, t0);
  const owner = await getHomeSummary(db, await ctxFor(db, shop, 'owner', t0), t0);
  expect(owner).toMatchObject({ shopName: 'shop-h', userName: 'Ama', rolePreset: 'owner' });
  expect(owner.securityEvents.map((e) => [e.action, e.detail])).toEqual([['failed_sign_in', 'ama@x.test']]);
  expect((await getHomeSummary(db, await ctxFor(db, shop, 'kofi', t0), t0)).securityEvents).toEqual([]);
});

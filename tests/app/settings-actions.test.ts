import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { addBranchAction, addRegisterAction } from '@/app/[slug]/app/settings/actions';
import type { Db } from '@/db/client';
import { createSession } from '@/server/sessions';
import { seedShop } from '../helpers/fixtures';
import { createTestDb } from '../helpers/test-db';

let db: Db;
let token: string | undefined;
vi.mock('@/db/client', async (importOriginal) => ({ ...(await importOriginal<typeof import('@/db/client')>()), getDb: () => db }));
vi.mock('next/headers', () => ({ cookies: async () => ({ get: () => (token ? { value: token } : undefined) }) }));
vi.mock('next/cache', () => ({ revalidatePath: vi.fn() }));

let close: () => Promise<void>;
beforeEach(async () => { ({ db, close } = await createTestDb()); });
afterEach(async () => { token = undefined; await close(); });

const form = (fields: Record<string, string>) => {
  const f = new FormData();
  for (const [k, v] of Object.entries(fields)) f.set(k, v);
  return f;
};

it('says which thing the plan has run out of', async () => {
  // the trial plan allows 1 branch and 2 tills
  const shop = await seedShop(db, { slug: 'shop-l', subscription: { status: 'trial', endDate: '2099-12-31', planId: 'trial' } });
  ({ token } = await createSession(db, { tenantId: shop.tenantId, userId: shop.users.owner.id, kind: 'password' }, new Date()));
  expect((await addBranchAction('shop-l', { error: null }, form({ name: 'Kumasi', code: 'B2' }))).error).toMatch(/\bbranches\b/);
  expect(await addRegisterAction('shop-l', { error: null }, form({ branchId: shop.branchId, name: 'Till 2', code: 'T2' })))
    .toMatchObject({ error: null });
  expect((await addRegisterAction('shop-l', { error: null }, form({ branchId: shop.branchId, name: 'Till 3', code: 'T3' }))).error)
    .toMatch(/\btills\b/);
});

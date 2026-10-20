import { eq } from 'drizzle-orm';
import { afterEach, beforeEach, expect, it } from 'vitest';
import type { Db } from '@/db/client';
import { registers, users } from '@/db/schema';
import { asPlatform } from '@/db/tenant';
import { addBranch, addRegister, listBranches } from '@/server/branches';
import { ctxFor, expectAccess, seedShop } from '../helpers/fixtures';
import { createTestDb } from '../helpers/test-db';

const t0 = new Date('2026-10-20T10:00:00Z');
let db: Db;
let close: () => Promise<void>;
beforeEach(async () => { ({ db, close } = await createTestDb()); });
afterEach(async () => { await close(); });

it('enforces branch and till limits on the trial plan', async () => {
  const shop = await seedShop(db, { subscription: { status: 'trial', endDate: '2026-11-03', planId: 'trial' } });
  const ctx = await ctxFor(db, shop, 'owner', t0, 'manage_shop_settings');
  expect(await addBranch(db, ctx, { name: 'Kumasi', branchCode: 'B2' })).toEqual({ ok: false, error: 'limit_reached' });
  expect(await addRegister(db, ctx, { branchId: shop.branchId, name: 'Till 2', registerCode: 'T2' })).toMatchObject({ ok: true });
  expect(await addRegister(db, ctx, { branchId: shop.branchId, name: 'Till 3', registerCode: 'T3' })).toEqual({ ok: false, error: 'limit_reached' });
});

it('adds branches and tills on a larger plan, uppercasing codes', async () => {
  const shop = await seedShop(db);
  const ctx = await ctxFor(db, shop, 'owner', t0, 'manage_shop_settings');
  const branch = await addBranch(db, ctx, { name: 'Kumasi', branchCode: 'ksi1', phone: '0244000000' }) as { branchId: string };
  expect(branch).toMatchObject({ ok: true });
  const till = await addRegister(db, ctx, { branchId: branch.branchId, name: 'Kumasi till', registerCode: 'k1' }) as { registerId: string };
  const [row] = (await asPlatform(db, (tx) => tx.select().from(registers))).filter((r) => r.id === till.registerId);
  expect(row).toMatchObject({ registerCode: 'K1', branchId: branch.branchId });
});

it('rejects duplicate and malformed codes and unknown branches', async () => {
  const a = await seedShop(db);
  const b = await seedShop(db);
  const ctx = await ctxFor(db, a, 'owner', t0, 'manage_shop_settings');
  expect(await addBranch(db, ctx, { name: 'Again', branchCode: 'B1' })).toEqual({ ok: false, error: 'duplicate_code' });
  expect(await addBranch(db, ctx, { name: 'Bad', branchCode: 'b-2' })).toEqual({ ok: false, error: 'invalid_input' });
  expect(await addBranch(db, ctx, { name: '  ', branchCode: 'B3' })).toEqual({ ok: false, error: 'invalid_input' });
  expect(await addRegister(db, ctx, { branchId: a.branchId, name: 'Dup', registerCode: 'T1' })).toEqual({ ok: false, error: 'duplicate_code' });
  expect(await addRegister(db, ctx, { branchId: b.branchId, name: 'Other shop', registerCode: 'T9' })).toEqual({ ok: false, error: 'unknown_branch' });
});

it('needs the shop settings permission', async () => {
  const shop = await seedShop(db, { users: [{ key: 'owner', email: 'o@x.test' }, { key: 'manager', email: 'm@x.test', rolePreset: 'manager' }] });
  const ctx = await ctxFor(db, shop, 'manager', t0);
  await expectAccess(addBranch(db, ctx, { name: 'Kumasi', branchCode: 'B2' }), 'forbidden');
  await expectAccess(addRegister(db, ctx, { branchId: shop.branchId, name: 'Till 2', registerCode: 'T2' }), 'forbidden');
});

it('lists branches with their tills', async () => {
  const shop = await seedShop(db);
  await seedShop(db);
  const ctx = await ctxFor(db, shop, 'owner', t0, 'manage_shop_settings');
  await addRegister(db, ctx, { branchId: shop.branchId, name: 'Till 2', registerCode: 'T2' });
  const list = await listBranches(db, ctx);
  expect(list).toHaveLength(1);
  expect(list[0]).toMatchObject({ name: 'Main', branchCode: 'B1' });
  expect(list[0].registers.map((r) => r.registerCode)).toEqual(['T1', 'T2']);
});

it('adds the owner to every new branch so they can sell there', async () => {
  const shop = await seedShop(db);
  const ctx = await ctxFor(db, shop, 'owner', t0, 'manage_shop_settings');
  const added = await addBranch(db, ctx, { name: 'Kumasi', branchCode: 'B2' }) as { branchId: string };
  const [owner] = await asPlatform(db, (tx) => tx.select().from(users).where(eq(users.id, shop.users.owner.id)));
  expect(owner.branchIds).toEqual([shop.branchId, added.branchId]);
});

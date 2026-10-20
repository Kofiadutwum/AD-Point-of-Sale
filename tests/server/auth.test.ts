import { eq } from 'drizzle-orm';
import { afterEach, beforeEach, expect, it } from 'vitest';
import type { Db } from '@/db/client';
import { auditLog, tenants, users } from '@/db/schema';
import { asPlatform, withTenant } from '@/db/tenant';
import { signIn } from '@/server/auth';
import { type SeededShop, seedShop } from '../helpers/fixtures';
import { createTestDb } from '../helpers/test-db';

const t0 = new Date('2026-10-20T10:00:00Z');
let db: Db;
let close: () => Promise<void>;
let a: SeededShop;
beforeEach(async () => {
  ({ db, close } = await createTestDb());
  a = await seedShop(db, { slug: 'shop-a', users: [{ key: 'owner', email: 'ama@shop-a.test', phone: '0241234567', password: 'correct-horse-1' }] });
  await seedShop(db, { slug: 'shop-b', users: [{ key: 'owner', email: 'ama@shop-a.test', password: 'other-pass-22' }] });
});
afterEach(async () => { await close(); });

const go = (identifier: string, password = 'correct-horse-1', slug = 'shop-a') =>
  signIn(db, { slug, identifier, password, ip: '1.1.1.1' }, t0);

it('signs in with email ignoring case and spaces', async () => {
  expect(await go('  AMA@shop-a.test ')).toMatchObject({ ok: true });
});

it('signs in with phone in any Ghana format', async () => {
  for (const p of ['024 123 4567', '+233 24 123 4567', '0241234567']) expect(await go(p)).toMatchObject({ ok: true });
});

it('gives the same error for unknown user and wrong password, and audits both', async () => {
  expect(await go('nobody@shop-a.test')).toEqual({ ok: false, error: 'access_denied' });
  expect(await go('ama@shop-a.test', 'wrong-password')).toEqual({ ok: false, error: 'access_denied' });
  const failed = await withTenant(db, a.tenantId, (tx) => tx.select().from(auditLog).where(eq(auditLog.action, 'failed_sign_in')));
  expect(failed).toHaveLength(2);
});

it('denies unknown and suspended shops with access_denied', async () => {
  expect(await go('ama@shop-a.test', 'correct-horse-1', 'no-such-shop')).toEqual({ ok: false, error: 'access_denied' });
  await asPlatform(db, (tx) => tx.update(tenants).set({ status: 'suspended' }).where(eq(tenants.id, a.tenantId)));
  expect(await go('ama@shop-a.test')).toEqual({ ok: false, error: 'access_denied' });
});

it('reports disabled accounts', async () => {
  await asPlatform(db, (tx) => tx.update(users).set({ status: 'inactive' }).where(eq(users.id, a.users.owner.id)));
  expect(await go('ama@shop-a.test')).toEqual({ ok: false, error: 'account_disabled' });
});

it('locks out after 10 failures from the same IP and identifier', async () => {
  for (let i = 0; i < 10; i++) await go('ama@shop-a.test', 'wrong-password');
  expect(await go('ama@shop-a.test')).toEqual({ ok: false, error: 'try_again_later' });
});

it('never authenticates a shop B account at shop A', async () => {
  expect(await go('ama@shop-a.test', 'other-pass-22', 'shop-a')).toEqual({ ok: false, error: 'access_denied' });
  expect(await go('ama@shop-a.test', 'other-pass-22', 'shop-b')).toMatchObject({ ok: true });
});

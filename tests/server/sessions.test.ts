import { afterEach, beforeEach, expect, it } from 'vitest';
import type { Db } from '@/db/client';
import { sessions, users } from '@/db/schema';
import { asPlatform } from '@/db/tenant';
import { tokenHash } from '@/server/crypto';
import { createSession, invalidateSession, invalidateUserSessions, validateSession } from '@/server/sessions';
import { type SeededShop, seedShop } from '../helpers/fixtures';
import { createTestDb } from '../helpers/test-db';

const t0 = new Date('2026-10-20T10:00:00Z');
const at = (ms: number) => new Date(t0.getTime() + ms);
const DAY = 86_400_000;
const HOUR = 3_600_000;

let db: Db;
let close: () => Promise<void>;
let a: SeededShop;
beforeEach(async () => {
  ({ db, close } = await createTestDb());
  a = await seedShop(db, { slug: 'shop-a' });
});
afterEach(async () => { await close(); });

const passwordSession = () => createSession(db, { tenantId: a.tenantId, userId: a.users.owner.id, kind: 'password' }, t0);

it('validates a fresh password session', async () => {
  const { token } = await passwordSession();
  expect(await validateSession(db, token, at(DAY))).toMatchObject({
    tenantId: a.tenantId, userId: a.users.owner.id, rolePreset: 'owner', kind: 'password', registerId: null, name: 'owner',
  });
});

it('extends a password session when under 15 days remain', async () => {
  const { token } = await passwordSession();
  expect((await validateSession(db, token, at(20 * DAY)))!.expiresAt).toEqual(at(50 * DAY));
  expect(await validateSession(db, token, at(45 * DAY))).not.toBeNull();
});

it('does not extend a password session with more than 15 days left', async () => {
  const { token, expiresAt } = await passwordSession();
  expect((await validateSession(db, token, at(10 * DAY)))!.expiresAt).toEqual(expiresAt);
});

it('expires a password session after 30 days without use', async () => {
  const { token } = await passwordSession();
  expect(await validateSession(db, token, at(31 * DAY))).toBeNull();
});

it('expires a PIN session after 12 hours', async () => {
  const { token } = await createSession(db, { tenantId: a.tenantId, userId: a.users.owner.id, kind: 'pin', registerId: a.registerId }, t0);
  expect(await validateSession(db, token, at(11 * HOUR))).toMatchObject({ kind: 'pin', registerId: a.registerId });
  expect(await validateSession(db, token, at(13 * HOUR))).toBeNull();
});

it('rejects sessions of users who are no longer active', async () => {
  const { token } = await passwordSession();
  await asPlatform(db, (tx) => tx.update(users).set({ status: 'inactive' }));
  expect(await validateSession(db, token, at(HOUR))).toBeNull();
});

it('invalidates single and all sessions', async () => {
  const one = await passwordSession();
  await invalidateSession(db, one.token);
  expect(await validateSession(db, one.token, at(HOUR))).toBeNull();
  const two = await passwordSession();
  const three = await passwordSession();
  await invalidateUserSessions(db, a.tenantId, a.users.owner.id);
  expect(await validateSession(db, two.token, at(HOUR))).toBeNull();
  expect(await validateSession(db, three.token, at(HOUR))).toBeNull();
});

it('stores only the token hash', async () => {
  const { token } = await passwordSession();
  const [row] = await asPlatform(db, (tx) => tx.select().from(sessions));
  expect(row.id).toBe(tokenHash(token));
});

it('returns null for an unknown token', async () => {
  expect(await validateSession(db, 'not-a-token', t0)).toBeNull();
});

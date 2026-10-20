import { afterEach, beforeEach, expect, it } from 'vitest';
import type { Db } from '@/db/client';
import { AccessError } from '@/server/context';
import { createPlatformAdmin, platformSignIn, requirePlatformAdmin } from '@/server/platform-admin';
import { createTestDb } from '../helpers/test-db';

const t0 = new Date('2026-10-20T10:00:00Z');
let db: Db;
let close: () => Promise<void>;
beforeEach(async () => {
  ({ db, close } = await createTestDb());
  await createPlatformAdmin(db, { email: ' Admin@Test.Local ', name: 'Admin', password: 'admin-password-1' });
});
afterEach(async () => { await close(); });

it('signs in a platform admin and validates the session', async () => {
  const r = await platformSignIn(db, { email: 'admin@test.local', password: 'admin-password-1', ip: '1.1.1.1' }, t0);
  expect(r).toMatchObject({ ok: true });
  expect(await requirePlatformAdmin(db, (r as { token: string }).token, t0)).toMatchObject({ name: 'Admin' });
});

it('rejects a wrong password and expired sessions', async () => {
  expect(await platformSignIn(db, { email: 'admin@test.local', password: 'nope', ip: '1.1.1.1' }, t0)).toEqual({ ok: false, error: 'access_denied' });
  const r = await platformSignIn(db, { email: 'admin@test.local', password: 'admin-password-1', ip: '1.1.1.1' }, t0);
  const later = new Date(t0.getTime() + 13 * 3_600_000);
  await expect(requirePlatformAdmin(db, (r as { token: string }).token, later)).rejects.toBeInstanceOf(AccessError);
  await expect(requirePlatformAdmin(db, undefined, t0)).rejects.toBeInstanceOf(AccessError);
});

it('locks out after 10 failures', async () => {
  for (let i = 0; i < 10; i++) await platformSignIn(db, { email: 'admin@test.local', password: 'nope', ip: '1.1.1.1' }, t0);
  expect(await platformSignIn(db, { email: 'admin@test.local', password: 'admin-password-1', ip: '1.1.1.1' }, t0))
    .toEqual({ ok: false, error: 'try_again_later' });
});

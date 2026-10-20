import { eq } from 'drizzle-orm';
import { afterEach, beforeEach, expect, it } from 'vitest';
import type { Db } from '@/db/client';
import { sessions, users } from '@/db/schema';
import { asPlatform } from '@/db/tenant';
import { TILL_PERMISSIONS } from '@/lib/permissions';
import { signIn } from '@/server/auth';
import { type Ctx, requireContext } from '@/server/context';
import { registerDevice, switchCashierWithPin } from '@/server/devices';
import {
  confirmMfaEnrolment, disableMfa, getMfaStatus, regenerateRecoveryCodes, startMfaEnrolment, verifyMfaSignIn,
} from '@/server/mfa';
import { createPlatformAdmin, platformSignIn, resetOwnerMfa } from '@/server/platform-admin';
import { createSession, validateSession } from '@/server/sessions';
import { totpAt, totpStep } from '@/server/totp';
import { ctxFor, type SeededShop, seedShop } from '../helpers/fixtures';
import { createTestDb } from '../helpers/test-db';

const t0 = new Date('2026-10-20T10:00:00Z');
const at = (ms: number) => new Date(t0.getTime() + ms);
const code = (secret: string, when = t0) => totpAt(secret, totpStep(when));
const login = { slug: 'shop-a', identifier: 'ama@shop-a.test', password: 'correct-horse-1', ip: '1.1.1.1' };

let db: Db;
let close: () => Promise<void>;
let shop: SeededShop;
let owner: Ctx;
beforeEach(async () => {
  ({ db, close } = await createTestDb());
  shop = await seedShop(db, { slug: 'shop-a', users: [{ key: 'owner', email: 'ama@shop-a.test', password: 'correct-horse-1', pin: '4321' }] });
  await seedShop(db, { slug: 'shop-b' });
  owner = await ctxFor(db, shop, 'owner', t0);
});
afterEach(async () => { await close(); });

/** Turns MFA on for the owner at `when`; returns the secret and recovery codes. */
async function enrol(when = t0): Promise<{ secret: string; recoveryCodes: string[] }> {
  expect(await startMfaEnrolment(db, owner)).toEqual({ ok: true });
  const { pending } = await getMfaStatus(db, owner);
  const r = await confirmMfaEnrolment(db, owner, code(pending!.secret, when), when);
  if (!r.ok) throw new Error(r.error);
  return { secret: pending!.secret, recoveryCodes: r.recoveryCodes };
}

async function challenge(when = t0): Promise<string> {
  const r = await signIn(db, login, when);
  if (!r.ok || !r.mfaRequired) throw new Error('expected an MFA challenge');
  return r.challengeToken;
}

it('enrols with a correct code, issues 10 recovery codes, and ends other sessions', async () => {
  const other = await createSession(db, { tenantId: shop.tenantId, userId: shop.users.owner.id, kind: 'password' }, t0);
  const { recoveryCodes } = await enrol();
  expect(recoveryCodes).toHaveLength(10);
  expect(recoveryCodes[0]).toMatch(/^[A-Z2-7]{5}-[A-Z2-7]{5}$/);
  expect(await getMfaStatus(db, owner)).toMatchObject({ enabled: true, pending: null, recoveryCodesLeft: 10 });
  expect(await validateSession(db, other.token, t0)).toBeNull();
  const mine = await asPlatform(db, (tx) => tx.select().from(sessions).where(eq(sessions.id, owner.sessionId)));
  expect(mine).toHaveLength(1);
});

it('refuses enrolment from a PIN session', async () => {
  const { token } = await createSession(db, { tenantId: shop.tenantId, userId: shop.users.owner.id, kind: 'pin' }, t0);
  const pinCtx = await requireContext(db, { slug: 'shop-a', sessionToken: token, permission: null }, t0);
  expect(await startMfaEnrolment(db, pinCtx)).toEqual({ ok: false, error: 'password_session_required' });
});

it('keeps MFA off after a wrong confirmation code', async () => {
  await startMfaEnrolment(db, owner);
  expect(await confirmMfaEnrolment(db, owner, '000000', t0)).toEqual({ ok: false, error: 'wrong_code' });
  expect((await getMfaStatus(db, owner)).enabled).toBe(false);
  expect(await signIn(db, login, t0)).toMatchObject({ ok: true, mfaRequired: false });
});

it('asks for a code at sign-in and creates no session until it is given', async () => {
  const { secret } = await enrol();
  const count = async () => (await asPlatform(db, (tx) => tx.select().from(sessions).where(eq(sessions.userId, shop.users.owner.id)))).length;
  const before = await count();
  const token = await challenge(at(60_000));
  expect(await count()).toBe(before);
  const r = await verifyMfaSignIn(db, { slug: 'shop-a', challengeToken: token, code: code(secret, at(60_000)), ip: '1.1.1.1' }, at(60_000));
  expect(r).toMatchObject({ ok: true });
  expect(await validateSession(db, (r as { token: string }).token, at(60_000))).toMatchObject({ kind: 'password' });
});

it('refuses the same TOTP code twice', async () => {
  const { secret } = await enrol(); // enrolment used the code for t0's step
  const token = await challenge();
  expect(await verifyMfaSignIn(db, { slug: 'shop-a', challengeToken: token, code: code(secret), ip: '1.1.1.1' }, t0))
    .toEqual({ ok: false, error: 'wrong_code' });
});

it('accepts each recovery code once, in any case and with or without the dash', async () => {
  const { recoveryCodes } = await enrol();
  const messy = recoveryCodes[0].replace('-', '').toLowerCase();
  expect(await verifyMfaSignIn(db, { slug: 'shop-a', challengeToken: await challenge(), code: messy, ip: '1.1.1.1' }, t0)).toMatchObject({ ok: true });
  expect(await verifyMfaSignIn(db, { slug: 'shop-a', challengeToken: await challenge(), code: recoveryCodes[0], ip: '1.1.1.1' }, t0))
    .toEqual({ ok: false, error: 'wrong_code' });
  expect((await getMfaStatus(db, owner)).recoveryCodesLeft).toBe(9);
});

it('ends the challenge after 5 wrong codes and after 5 minutes', async () => {
  const { secret } = await enrol();
  const token = await challenge();
  for (let i = 0; i < 5; i++) await verifyMfaSignIn(db, { slug: 'shop-a', challengeToken: token, code: '000000', ip: '1.1.1.1' }, t0);
  expect(await verifyMfaSignIn(db, { slug: 'shop-a', challengeToken: token, code: code(secret, at(30_000)), ip: '1.1.1.1' }, at(30_000)))
    .toEqual({ ok: false, error: 'expired' });
  const late = await challenge(at(60_000));
  const when = at(60_000 + 5 * 60_000 + 1);
  expect(await verifyMfaSignIn(db, { slug: 'shop-a', challengeToken: late, code: code(secret, when), ip: '2.2.2.2' }, when))
    .toEqual({ ok: false, error: 'expired' });
});

it('refuses a challenge used at another shop address', async () => {
  const { secret } = await enrol();
  const token = await challenge(at(60_000));
  expect(await verifyMfaSignIn(db, { slug: 'shop-b', challengeToken: token, code: code(secret, at(60_000)), ip: '1.1.1.1' }, at(60_000)))
    .toEqual({ ok: false, error: 'expired' });
});

it('never lets a PIN bypass MFA', async () => {
  await enrol();
  const ownerCtx = await ctxFor(db, shop, 'owner', t0, 'manage_devices');
  const { deviceToken } = (await registerDevice(db, ownerCtx, shop.registerId, t0)) as { deviceToken: string };
  const r = await switchCashierWithPin(db, { deviceToken, staffId: shop.users.owner.id, pin: '4321' }, t0);
  const pinCtx = await requireContext(db, { slug: 'shop-a', sessionToken: (r as { token: string }).token, permission: null }, t0);
  expect([...pinCtx.permissions].sort()).toEqual([...TILL_PERMISSIONS].sort());
  expect(pinCtx.sessionKind).toBe('pin');
  expect(await disableMfa(db, pinCtx, '000000', t0)).toEqual({ ok: false, error: 'password_session_required' });
});

it('disables MFA with a valid code, regenerates codes, and the platform admin can reset it', async () => {
  const { secret } = await enrol();
  expect(await disableMfa(db, owner, '123456', at(60_000))).toEqual({ ok: false, error: 'wrong_code' });
  expect(await disableMfa(db, owner, code(secret, at(60_000)), at(60_000))).toEqual({ ok: true });
  expect(await signIn(db, login, at(60_000))).toMatchObject({ ok: true, mfaRequired: false });

  owner = await ctxFor(db, shop, 'owner', at(90_000));
  const again = await enrol(at(90_000));
  expect(await regenerateRecoveryCodes(db, owner, code(again.secret, at(120_000)), at(120_000))).toMatchObject({ ok: true });
  await createPlatformAdmin(db, { email: 'admin@test.local', name: 'Admin', password: 'admin-password-1' });
  const admin = await platformSignIn(db, { email: 'admin@test.local', password: 'admin-password-1', ip: '1.1.1.1' }, t0);
  await resetOwnerMfa(db, (admin as { token: string }).token, shop.tenantId, t0);
  const [u] = await asPlatform(db, (tx) => tx.select().from(users).where(eq(users.id, shop.users.owner.id)));
  expect(u.mfaEnabledAt).toBeNull();
  expect(await signIn(db, login, at(150_000))).toMatchObject({ ok: true, mfaRequired: false });
});

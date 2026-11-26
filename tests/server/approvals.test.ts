import { afterEach, beforeEach, expect, it } from 'vitest';
import type { Db } from '@/db/client';
import { withTenant } from '@/db/tenant';
import { consumeApproval, requestApproval } from '@/server/approvals';
import type { Ctx } from '@/server/context';
import { ctxFor, type SeededShop, seedShop } from '../helpers/fixtures';
import { createTestDb } from '../helpers/test-db';

const t0 = new Date('2026-11-26T10:00:00Z');
let db: Db;
let close: () => Promise<void>;
let shop: SeededShop;
let cashier: Ctx;
beforeEach(async () => {
  ({ db, close } = await createTestDb());
  shop = await seedShop(db, { users: [
    { key: 'owner', email: 'o@x.test', rolePreset: 'owner', pin: '9999' }, { key: 'manager', email: 'm@x.test', rolePreset: 'manager', pin: '1234' },
    { key: 'cashier', email: 'c@x.test', rolePreset: 'cashier', pin: '5555' }, { key: 'other', email: 'x@x.test', rolePreset: 'cashier', pin: '7777' },
  ] });
  cashier = await ctxFor(db, shop, 'cashier', t0);
});
afterEach(async () => { await close(); });

const ask = (approver: string, pin: string, contextKey = 'sale-1:500') =>
  requestApproval(db, cashier, { action: 'refund', contextKey, approverId: shop.users[approver].id, pin }, t0);
const use = (ctx: Ctx, token: string, contextKey = 'sale-1:500', at = t0) =>
  withTenant(db, shop.tenantId, (tx) => consumeApproval(tx, ctx, { token, action: 'refund', contextKey }, at));

it('a manager approves with their PIN', async () => {
  const r = await ask('manager', '1234');
  expect(r).toMatchObject({ ok: true });
  expect(await use(cashier, (r as { token: string }).token)).toEqual({ approverId: shop.users.manager.id });
  expect(await ask('manager', '0000')).toEqual({ ok: false, error: 'wrong_pin' });
  expect(await ask('other', '7777')).toEqual({ ok: false, error: 'not_authorised' });
});

it('self-approval is refused', async () => {
  const manager = await ctxFor(db, shop, 'manager', t0);
  expect(await requestApproval(db, manager, { action: 'refund', contextKey: 'k', approverId: shop.users.manager.id, pin: '1234' }, t0)).toEqual({ ok: false, error: 'self_approval' });
});

it('an approval is single use, short-lived, and bound to its amount', async () => {
  const { token } = await ask('manager', '1234') as { token: string };
  expect(await use(cashier, token, 'sale-1:600')).toBeNull(); // a different amount
  expect(await use(cashier, token, 'sale-1:500', new Date(t0.getTime() + 3 * 60_000))).toBeNull(); // expired
  expect(await use(await ctxFor(db, shop, 'other', t0), token)).toBeNull(); // someone else
  expect(await use(cashier, token)).not.toBeNull();
  expect(await use(cashier, token)).toBeNull(); // used once already
});

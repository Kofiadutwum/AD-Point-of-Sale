import { eq } from 'drizzle-orm';
import { afterEach, beforeEach, expect, it } from 'vitest';
import type { Db } from '@/db/client';
import { tenants } from '@/db/schema';
import { asPlatform } from '@/db/tenant';
import { requestApproval } from '@/server/approvals';
import type { Ctx } from '@/server/context';
import { expenseKey, listExpenses, recordExpense } from '@/server/expenses';
import { currentShift, openShift } from '@/server/shifts';
import { ctxFor, type SeededShop, seedShop, tillCtxFor } from '../helpers/fixtures';
import { createTestDb } from '../helpers/test-db';

const t0 = new Date('2026-11-26T09:00:00Z');
let db: Db;
let close: () => Promise<void>;
let shop: SeededShop;
let owner: Ctx;
let manager: Ctx;
beforeEach(async () => {
  ({ db, close } = await createTestDb());
  shop = await seedShop(db, { users: [
    { key: 'owner', email: 'o@e.test', password: 'correct-horse-1', rolePreset: 'owner' },
    { key: 'manager', phone: '0200000009', pin: '4321', rolePreset: 'manager' },
    { key: 'supervisor', phone: '0200000008', pin: '8888', rolePreset: 'manager' },
  ] });
  owner = await ctxFor(db, shop, 'owner', t0);
  manager = await tillCtxFor(db, shop, 'manager', t0); // at the till, so a cash expense comes out of the shift
});
afterEach(async () => { await close(); });

it('a cash expense comes out of the open shift', async () => {
  await openShift(db, manager, { openingCashPesewas: 10000 }, t0);
  expect(await recordExpense(db, manager, { category: 'Gas refill', amountPesewas: 2500, method: 'cash' }, t0)).toEqual({ ok: true, expenseId: expect.any(String), fromShift: true });
  expect(await recordExpense(db, owner, { category: 'Electricity', amountPesewas: 30000, method: 'momo_manual' }, t0)).toEqual({ ok: false, error: 'reference_required' });
  expect(await recordExpense(db, owner, { category: 'Electricity', amountPesewas: 30000, method: 'momo_manual', reference: 'ECG-123' }, t0))
    .toEqual({ ok: true, expenseId: expect.any(String), fromShift: false }); // not at a till, not cash
  expect(await currentShift(db, manager)).toMatchObject({ paidOutPesewas: 2500, expectedCashPesewas: 7500 });
  expect(await listExpenses(db, owner, { from: '2026-11-26', to: '2026-11-26' })).toMatchObject({ totalPesewas: 32500 });
});

it('an expense above the limit needs approval', async () => {
  await asPlatform(db, (tx) => tx.update(tenants).set({ expenseApprovalLimitPesewas: 5000 }).where(eq(tenants.id, shop.tenantId)));
  const clerk = { ...owner, permissions: owner.permissions.filter((p) => p !== 'approve_actions') }; // someone who records but cannot approve
  expect(await recordExpense(db, clerk, { category: 'Cleaning', amountPesewas: 5000, method: 'cash' }, t0)).toMatchObject({ ok: true }); // at the limit
  expect(await recordExpense(db, clerk, { category: 'Repairs', amountPesewas: 9000, method: 'cash' }, t0)).toEqual({ ok: false, error: 'approval_required' });
  const a = await requestApproval(db, clerk, { action: 'expense', contextKey: expenseKey(shop.branchId, 9000), approverId: shop.users.supervisor.id, pin: '8888' }, t0);
  expect(await recordExpense(db, clerk, { category: 'Repairs', amountPesewas: 9000, method: 'cash', approvalToken: (a as { token: string }).token }, t0)).toMatchObject({ ok: true });
});

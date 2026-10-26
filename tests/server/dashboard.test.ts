import { afterEach, beforeEach, expect, it } from 'vitest';
import type { Db } from '@/db/client';
import type { Ctx } from '@/server/context';
import { getDashboard } from '@/server/dashboard';
import { completeSale } from '@/server/sales';
import { updateVariant } from '@/server/variants';
import { ctxFor, expectAccess, productFor, saleInput, type SeededShop, seedShop, stockFor, tillCtxFor } from '../helpers/fixtures';
import { createTestDb } from '../helpers/test-db';

const t0 = new Date('2026-10-20T10:00:00Z');
let db: Db;
let close: () => Promise<void>;
let shop: SeededShop;
let owner: Ctx;
let cashier: Ctx;
let p: { variantId: string; baseUnitId: string };
beforeEach(async () => {
  ({ db, close } = await createTestDb());
  shop = await seedShop(db, { users: [
    { key: 'owner', email: 'o@a.test', password: 'correct-horse-1', rolePreset: 'owner' },
    { key: 'cashier', phone: '0200000001', pin: '1234', rolePreset: 'cashier' },
  ] });
  owner = await ctxFor(db, shop, 'owner', t0);
  cashier = await tillCtxFor(db, shop, 'cashier', t0);
  p = await productFor(db, owner);
  await stockFor(db, owner, shop.branchId, { variantId: p.variantId, unitId: p.baseUnitId, quantity: '20', totalCostPesewas: 0 }, t0);
});
afterEach(async () => { await close(); });

const sell = (quantity: string, tenders: Parameters<typeof saleInput>[0]['tenders'], extra = {}) => completeSale(db, cashier, saleInput({
  lines: [{ variantId: p.variantId, unitId: p.baseUnitId, quantity, unitPricePesewas: 500, discountPesewas: 0 }], tenders, ...extra,
}), t0);
const tender = (method: 'cash' | 'momo_manual', amountPesewas: number) => ({ id: crypto.randomUUID(), method, amountPesewas, reference: method === 'cash' ? undefined : 'R1' });

it("counts only today's completed sales", async () => {
  await sell('2', [tender('cash', 1200)]);
  await sell('3', [tender('momo_manual', 1500)]);
  await sell('2', [tender('cash', 400)], { fromOfflineOutbox: true }); // underpaid: pending, needs review
  await sell('1', [tender('cash', 500)], { deviceCreatedAt: '2026-10-19T09:00:00Z', fromOfflineOutbox: true });
  const d = await getDashboard(db, owner, t0);
  expect(d).toMatchObject({ businessDate: '2026-10-20', salesCount: 2, grossPesewas: 2500, netPesewas: 2500, totalPesewas: 2500, averagePesewas: 1250, needsReview: 1 });
  expect(d.payments).toEqual([{ method: 'cash', amountPesewas: 1000 }, { method: 'momo_manual', amountPesewas: 1500 }]);
});

it('lists low and negative stock', async () => {
  await updateVariant(db, owner, p.variantId, { name: '', sku: null, basePricePesewas: 500, costPesewas: null, reorderLevel: '5', sellable: true, allowsFractions: false });
  await sell('17', [tender('cash', 8500)]);
  expect((await getDashboard(db, owner, t0)).lowStock).toMatchObject([{ variantId: p.variantId, onHand: '3.000', reorderLevel: '5.000' }]);
  await sell('4', [tender('cash', 2000)]);
  const d = await getDashboard(db, owner, t0);
  expect(d.lowStock).toEqual([]);
  expect(d.negativeStock).toMatchObject([{ variantId: p.variantId, onHand: '-1.000', branchName: 'Main' }]);
});

it('needs view_dashboard', async () => {
  await expectAccess(getDashboard(db, cashier, t0), 'forbidden');
});

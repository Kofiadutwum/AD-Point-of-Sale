import { afterEach, beforeEach, expect, it } from 'vitest';
import type { Db } from '@/db/client';
import type { Ctx } from '@/server/context';
import { pharmacyReport, type PharmacyReport } from '@/server/pharmacy-reports';
import { completeSale } from '@/server/sales';
import { ctxFor, productFor, saleInput, type SeededShop, seedShop, stockFor, tillCtxFor } from '../helpers/fixtures';
import { createTestDb } from '../helpers/test-db';

const t0 = new Date('2026-11-26T10:00:00Z');
const earlier = new Date('2026-06-01T10:00:00Z');
const range = { from: '2026-11-01', to: '2026-11-30' };
let db: Db;
let close: () => Promise<void>;
let shop: SeededShop;
let owner: Ctx;
beforeEach(async () => {
  ({ db, close } = await createTestDb());
  shop = await seedShop(db, { shopType: 'pharmacy', users: [
    { key: 'owner', email: 'o@ph.test', password: 'correct-horse-1', rolePreset: 'owner' },
    { key: 'pharmacist', phone: '0200000009', pin: '4321', rolePreset: 'manager' },
  ] });
  owner = await ctxFor(db, shop, 'owner', t0);
});
afterEach(async () => { await close(); });

const report = async (ctx: Ctx) => ((await pharmacyReport(db, ctx, range, t0)) as { ok: true; report: PharmacyReport }).report;

it('near-expiry and expired stock with values', async () => {
  const med = await productFor(db, owner, { name: 'Paracetamol', tracking: 'batch' });
  const line = { variantId: med.variantId, unitId: med.baseUnitId };
  await stockFor(db, owner, shop.branchId, { ...line, quantity: '4', totalCostPesewas: 400, batchNumber: 'OLD', expiryDate: '2026-11-20' }, earlier); // expired by t0
  await stockFor(db, owner, shop.branchId, { ...line, quantity: '3', totalCostPesewas: 300, batchNumber: 'SOON', expiryDate: '2026-12-26' }, t0); // 30 days
  await stockFor(db, owner, shop.branchId, { ...line, quantity: '5', totalCostPesewas: 500, batchNumber: 'LATER', expiryDate: '2027-09-01' }, t0);
  const rep = await report(owner);
  expect(rep.warningDays).toBe(90);
  expect(rep.nearExpiry.map((b) => [b.batchNumber, b.onHand, b.valuePesewas])).toEqual([['SOON', '3.000', 300]]);
  expect(rep.expired.map((b) => [b.batchNumber, b.onHand, b.valuePesewas])).toEqual([['OLD', '4.000', 400]]);
  expect([rep.nearExpiryValuePesewas, rep.expiredValuePesewas]).toEqual([300, 400]);
});

it('the prescription log needs the dispensing permission', async () => {
  const rx = await productFor(db, owner, { name: 'Amoxicillin', pharmacy: { prescriptionOnly: true } });
  await stockFor(db, owner, shop.branchId, { variantId: rx.variantId, unitId: rx.baseUnitId, quantity: '5', totalCostPesewas: 500 }, t0);
  const pharmacist = await tillCtxFor(db, shop, 'pharmacist', t0);
  const prescription = { patientName: 'Ama Mensah', prescriberName: 'Dr Owusu', facility: 'Ridge Hospital', prescriptionDate: '2026-11-20' };
  const lines = [{ variantId: rx.variantId, unitId: rx.baseUnitId, quantity: '1', unitPricePesewas: 500, discountPesewas: 0, prescription }];
  expect(await completeSale(db, pharmacist, saleInput({ lines, deviceCreatedAt: t0.toISOString() }), t0)).toMatchObject({ ok: true });
  expect((await report(owner)).prescriptions).toMatchObject([{ medicine: 'Amoxicillin', quantity: '1.000', ...prescription, approvedBy: null }]);
  const noDispense = { ...owner, permissions: owner.permissions.filter((p) => p !== 'dispense_prescription') };
  expect((await report(noDispense)).prescriptions).toBeNull();
});

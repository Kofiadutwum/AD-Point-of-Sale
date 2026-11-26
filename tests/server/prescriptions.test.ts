import { eq } from 'drizzle-orm';
import { afterEach, beforeEach, expect, it } from 'vitest';
import type { Db } from '@/db/client';
import { prescriptions, sales, tenants } from '@/db/schema';
import { asPlatform } from '@/db/tenant';
import { requestApproval } from '@/server/approvals';
import type { Ctx } from '@/server/context';
import { completeSale, type SaleInput } from '@/server/sales';
import { ctxFor, productFor, saleInput, type SeededShop, seedShop, stockFor, tillCtxFor } from '../helpers/fixtures';
import { createTestDb } from '../helpers/test-db';

const t0 = new Date('2026-11-26T10:00:00Z');
let db: Db;
let close: () => Promise<void>;
let shop: SeededShop;
let pharmacist: Ctx;
let cashier: Ctx;
let rx: { variantId: string; baseUnitId: string };
beforeEach(async () => {
  ({ db, close } = await createTestDb());
  shop = await seedShop(db, { shopType: 'pharmacy', users: [
    { key: 'owner', email: 'o@rx.test', password: 'correct-horse-1', rolePreset: 'owner' },
    { key: 'pharmacist', phone: '0200000009', pin: '4321', rolePreset: 'manager' },
    { key: 'cashier', phone: '0200000001', pin: '1234', rolePreset: 'cashier' },
    { key: 'cashier2', phone: '0200000002', pin: '2222', rolePreset: 'cashier' },
  ] });
  const owner = await ctxFor(db, shop, 'owner', t0);
  pharmacist = await tillCtxFor(db, shop, 'pharmacist', t0);
  cashier = await tillCtxFor(db, shop, 'cashier', t0);
  rx = await productFor(db, owner, { name: 'Amoxicillin 500mg', pharmacy: { genericName: 'amoxicillin', prescriptionOnly: true } });
  await stockFor(db, owner, shop.branchId, { variantId: rx.variantId, unitId: rx.baseUnitId, quantity: '10', totalCostPesewas: 4000 }, t0);
});
afterEach(async () => { await close(); });

const script = { patientName: 'Ama Mensah', prescriberName: 'Dr Owusu', facility: 'Ridge Hospital', prescriptionDate: '2026-11-20' };
const sale = (extra: Partial<SaleInput['lines'][number]> = {}, more: Partial<SaleInput> = {}) =>
  saleInput({ lines: [{ variantId: rx.variantId, unitId: rx.baseUnitId, quantity: '1', unitPricePesewas: 500, discountPesewas: 0, ...extra }], ...more });

it('a prescription-only line needs a record', async () => {
  expect(await completeSale(db, pharmacist, sale(), t0)).toEqual({ ok: false, error: 'prescription_required' });
  expect(await completeSale(db, pharmacist, sale({ prescription: { ...script, prescriptionDate: '2025-11-01' } }), t0)).toEqual({ ok: false, error: 'prescription_required' }); // over a year old
  expect(await completeSale(db, pharmacist, sale({ prescription: script }), t0)).toMatchObject({ ok: true });
  expect(await asPlatform(db, (tx) => tx.select().from(prescriptions))).toMatchObject([{ ...script, recordedBy: shop.users.pharmacist.id, approvedBy: null }]);
});

it("a cashier needs a pharmacist's PIN", async () => {
  expect(await completeSale(db, cashier, sale({ prescription: script }), t0)).toEqual({ ok: false, error: 'prescription_not_allowed' });
  const input = sale({ prescription: script });
  const ask = (approver: string, pin: string) =>
    requestApproval(db, cashier, { action: 'dispense_prescription', contextKey: input.saleId, approverId: shop.users[approver].id, pin }, t0);
  expect(await ask('cashier2', '2222')).toEqual({ ok: false, error: 'not_authorised' }); // cannot dispense
  const a = await ask('pharmacist', '4321');
  expect(await completeSale(db, cashier, { ...input, prescriptionApprovalToken: (a as { token: string }).token }, t0)).toMatchObject({ ok: true });
  expect(await asPlatform(db, (tx) => tx.select().from(prescriptions))).toMatchObject([{ recordedBy: shop.users.cashier.id, approvedBy: shop.users.pharmacist.id }]);
});

it('OTC-only shops refuse prescription-only medicine', async () => {
  await asPlatform(db, (tx) => tx.update(tenants).set({ otcOnly: true }).where(eq(tenants.id, shop.tenantId)));
  expect(await completeSale(db, pharmacist, sale({ prescription: script }), t0)).toEqual({ ok: false, error: 'otc_only' });
});

it('an offline sale missing a record is kept for review', async () => {
  const r = await completeSale(db, cashier, sale({}, { fromOfflineOutbox: true }), t0);
  expect(r).toMatchObject({ ok: true });
  const [row] = await asPlatform(db, (tx) => tx.select().from(sales));
  expect(row.needsReview).toBe(true);
  expect(row.reviewReasons).toEqual(expect.arrayContaining(['prescription_missing', 'prescription_unapproved']));
});

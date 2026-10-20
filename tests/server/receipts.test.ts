import { eq } from 'drizzle-orm';
import { afterEach, beforeEach, expect, it } from 'vitest';
import type { Db } from '@/db/client';
import { auditLog, sales } from '@/db/schema';
import { asPlatform } from '@/db/tenant';
import type { Ctx } from '@/server/context';
import { addCustomer } from '@/server/customers';
import { getPublicReceipt, getReceipt } from '@/server/receipts';
import { completeSale } from '@/server/sales';
import { ctxFor, productFor, saleInput, type SeededShop, seedShop, tillCtxFor } from '../helpers/fixtures';
import { createTestDb } from '../helpers/test-db';

const t0 = new Date('2026-10-20T10:00:00Z');
let db: Db;
let close: () => Promise<void>;
let shop: SeededShop;
let owner: Ctx;
let saleId: string;
let shareCode: string;
beforeEach(async () => {
  ({ db, close } = await createTestDb());
  shop = await seedShop(db, { users: [
    { key: 'owner', email: 'o@a.test', password: 'correct-horse-1', rolePreset: 'owner' },
    { key: 'cashier', name: 'Kofi', phone: '0200000001', pin: '1234', rolePreset: 'cashier' },
  ] });
  owner = await ctxFor(db, shop, 'owner', t0);
  const cashier = await tillCtxFor(db, shop, 'cashier', t0);
  const p = await productFor(db, owner, { name: 'Soap' });
  const { customerId } = await addCustomer(db, cashier, { name: 'Esi', phone: '0241234567' }) as { customerId: string };
  const input = saleInput({ customerId, lines: [{ variantId: p.variantId, unitId: p.baseUnitId, quantity: '2', unitPricePesewas: 500, discountPesewas: 0 }],
    tenders: [{ id: crypto.randomUUID(), method: 'momo_manual', amountPesewas: 600, reference: 'MP123' }, { id: crypto.randomUUID(), method: 'cash', amountPesewas: 500 }] });
  await completeSale(db, cashier, input, t0);
  saleId = input.saleId;
  shareCode = (await asPlatform(db, (tx) => tx.select().from(sales)))[0].shareCode;
});
afterEach(async () => { await close(); });

it('shows a receipt with lines, tax, payments, and change', async () => {
  const r = await getReceipt(db, owner, saleId, { reprint: false });
  expect(r).toMatchObject({
    shopName: shop.slug, branchName: 'Main', cashierName: 'Kofi', customerName: 'Esi', status: 'completed', totalPesewas: 1000, changeDuePesewas: 100,
    lines: [{ name: 'Soap', unitName: 'piece', quantity: '2.000', unitPricePesewas: 500, totalPesewas: 1000 }],
    payments: [{ method: 'momo_manual', amountPesewas: 600, reference: 'MP123' }, { method: 'cash', amountPesewas: 500, reference: null }],
  });
});

it('logs a reprint', async () => {
  await getReceipt(db, owner, saleId, { reprint: false });
  await getReceipt(db, owner, saleId, { reprint: true });
  expect(await asPlatform(db, (tx) => tx.select().from(auditLog).where(eq(auditLog.action, 'receipt_reprinted')))).toHaveLength(1);
});

it('shares a receipt by code without references or customer details', async () => {
  const r = await getPublicReceipt(db, shop.slug, shareCode);
  expect(r).toMatchObject({ receiptNumber: expect.stringMatching(/^B1-T1-/), customerName: null, customerPhone: null, totalPesewas: 1000 });
  expect(r!.payments.every((p) => p.reference === null)).toBe(true);
  await seedShop(db, { slug: 'shop-b' });
  expect(await getPublicReceipt(db, 'shop-b', shareCode)).toBeNull();
  expect(await getPublicReceipt(db, shop.slug, 'x'.repeat(22))).toBeNull();
});

it("does not show another shop's receipt", async () => {
  const b = await seedShop(db, { slug: 'shop-b' });
  expect(await getReceipt(db, await ctxFor(db, b, 'owner', t0), saleId, { reprint: false })).toBeNull();
});

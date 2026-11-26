import { randomUUID } from 'node:crypto';
import { afterEach, beforeEach, expect, it } from 'vitest';
import type { Db } from '@/db/client';
import { auditLog } from '@/db/schema';
import { asPlatform } from '@/db/tenant';
import type { Ctx } from '@/server/context';
import { addCustomer } from '@/server/customers';
import { exportData } from '@/server/data-export';
import { recordExpense } from '@/server/expenses';
import { completeSale } from '@/server/sales';
import { ctxFor, expectAccess, productFor, saleInput, type SeededShop, seedShop, stockFor, tillCtxFor } from '../helpers/fixtures';
import { createTestDb } from '../helpers/test-db';

const t0 = new Date('2026-11-26T09:00:00Z');
let db: Db;
let close: () => Promise<void>;
let shop: SeededShop;
let owner: Ctx;
let cashier: Ctx;
beforeEach(async () => {
  ({ db, close } = await createTestDb());
  shop = await seedShop(db, { users: [
    { key: 'owner', email: 'o@x.test', password: 'correct-horse-1', rolePreset: 'owner' },
    { key: 'cashier', phone: '0200000001', pin: '1234', rolePreset: 'cashier' },
  ] });
  owner = await ctxFor(db, shop, 'owner', t0);
  cashier = await tillCtxFor(db, shop, 'cashier', t0);
  const p = await productFor(db, owner); // GHS 5.00
  await stockFor(db, owner, shop.branchId, { variantId: p.variantId, unitId: p.baseUnitId, quantity: '10', totalCostPesewas: 2000 }, t0);
  await addCustomer(db, owner, { name: '=HYPERLINK("x")', phone: '0244000001' });
  const line = { variantId: p.variantId, unitId: p.baseUnitId, quantity: '2', unitPricePesewas: 500, discountPesewas: 0 };
  expect(await completeSale(db, cashier, saleInput({ lines: [line], tenders: [{ id: randomUUID(), method: 'cash', amountPesewas: 1000 }], deviceCreatedAt: t0.toISOString() }), t0)).toMatchObject({ ok: true });
  expect(await recordExpense(db, owner, { category: 'Transport', amountPesewas: 300, method: 'cash' }, t0)).toMatchObject({ ok: true });
});
afterEach(async () => { await close(); });

const rows = (csv: string) => csv.trim().split('\r\n');

it('exports each dataset as CSV in cedis and audits it', async () => {
  const sales = await exportData(db, owner, 'sales', { from: '2026-11-01', to: '2026-11-30' });
  expect(sales).toMatchObject({ ok: true, filename: 'sales-2026-11-01-to-2026-11-30.csv' });
  expect(rows((sales as { csv: string }).csv)).toHaveLength(2);
  expect((sales as { csv: string }).csv).toContain(',2.000,5.00,0.00,');
  const acc = (await exportData(db, owner, 'accounting', { from: '2026-11-26', to: '2026-11-26' })) as { csv: string };
  expect(rows(acc.csv)[1]).toMatch(/^2026-11-26,10\.00,0\.00,[\d.]+,10\.00(,0\.00){12},3\.00$/);
  const stock = (await exportData(db, owner, 'stock', {})) as { csv: string };
  expect(rows(stock.csv)[1]).toContain(',8.000,16.00');
  const customers = (await exportData(db, owner, 'customers', {})) as { csv: string };
  expect(customers.csv).toContain(`"'=HYPERLINK(""x"")"`); // formula neutralised
  for (const d of ['products', 'payments', 'ledger', 'expenses']) expect(await exportData(db, owner, d, { from: '2026-11-01', to: '2026-11-30' })).toMatchObject({ ok: true });
  const audits = await asPlatform(db, (tx) => tx.select().from(auditLog));
  expect(audits.filter((a) => a.action === 'data_exported')).toHaveLength(8);
});

it('checks the dataset, dates, and permission', async () => {
  expect(await exportData(db, owner, 'prescriptions', {})).toEqual({ ok: false, error: 'invalid_input' });
  expect(await exportData(db, owner, 'sales', {})).toEqual({ ok: false, error: 'invalid_input' });
  expect(await exportData(db, owner, 'sales', { from: '2025-01-01', to: '2026-11-30' })).toEqual({ ok: false, error: 'range_too_long' });
  await expectAccess(exportData(db, cashier, 'products', {}), 'forbidden');
});

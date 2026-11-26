import { afterEach, beforeEach, expect, it } from 'vitest';
import type { Db } from '@/db/client';
import { customers, products } from '@/db/schema';
import { asPlatform, withTenant } from '@/db/tenant';
import type { Ctx } from '@/server/context';
import { checkImport, runImport } from '@/server/csv-import';
import { stockOnHand } from '@/server/stock';
import { ctxFor, productFor, type SeededShop, seedShop } from '../helpers/fixtures';
import { createTestDb } from '../helpers/test-db';

const t0 = new Date('2026-11-26T10:00:00Z');
let db: Db;
let close: () => Promise<void>;
let shop: SeededShop;
let owner: Ctx;
beforeEach(async () => {
  ({ db, close } = await createTestDb());
  shop = await seedShop(db, { users: [{ key: 'owner', email: 'o@i.test', password: 'correct-horse-1', rolePreset: 'owner' }] });
  owner = await ctxFor(db, shop, 'owner', t0);
});
afterEach(async () => { await close(); });

const productsHeader = 'name,sku,barcode,price,cost,unit,allows_fractions,tracking,generic_name,prescription_only';
const count = async () => (await asPlatform(db, (tx) => tx.select().from(products))).length;

it('checks every row, then imports all or nothing unless failing rows are skipped', async () => {
  const csv = [productsHeader, 'Milo 400g,MILO400,6001234567890,45.00,38.00,tin,no,none,,', '"Rice, perfumed",RICE,,12.5,10,kg,yes,none,,', 'Bad price,BAD,,twelve,,,,,,'].join('\n');
  const check = await checkImport(db, owner, { kind: 'products', text: csv });
  expect(check).toEqual({ ok: true, rows: 3, errors: [{ row: 4, message: 'price "twelve" must be in cedis, like 12.50' }], preview: expect.any(Array) });
  expect(await count()).toBe(0); // the check saved nothing
  expect(await runImport(db, owner, { kind: 'products', text: csv, skipFailing: false }, t0)).toEqual({ ok: false, error: 'has_errors' });
  expect(await count()).toBe(0);
  expect(await runImport(db, owner, { kind: 'products', text: csv, skipFailing: true }, t0)).toEqual({ ok: true, imported: 2, skipped: 1 });
  expect((await asPlatform(db, (tx) => tx.select({ name: products.name }).from(products))).map((p) => p.name).sort()).toEqual(['Milo 400g', 'Rice, perfumed']);
});

it('finds SKUs already in the shop or repeated in the file', async () => {
  await productFor(db, owner, { name: 'Existing', variants: [{ sku: 'MILO400', basePricePesewas: 100, costPesewas: 50 }] });
  const csv = [productsHeader, 'Milo,MILO400,,45,,,,,,', 'Sugar,SUG,,10,,,,,,', 'Sugar again,sug,,10,,,,,,'].join('\n');
  const check = await checkImport(db, owner, { kind: 'products', text: csv });
  expect(check).toMatchObject({ ok: true, errors: [{ row: 2, message: 'that SKU is already used (MILO400)' }, { row: 4, message: 'same SKU or barcode as line 3' }] });
});

it('imports customers by Ghana phone', async () => {
  const csv = ['name,phone', 'Ama Mensah,024 400 0001', 'Kofi,12345', 'Ama again,0244000001'].join('\n');
  expect(await checkImport(db, owner, { kind: 'customers', text: csv })).toMatchObject({
    errors: [{ row: 3, message: '"12345" is not a Ghana phone number' }, { row: 4, message: 'same phone as line 2' }],
  });
  expect(await runImport(db, owner, { kind: 'customers', text: csv, skipFailing: true }, t0)).toEqual({ ok: true, imported: 1, skipped: 2 });
  expect(await asPlatform(db, (tx) => tx.select({ phone: customers.phone }).from(customers))).toEqual([{ phone: '233244000001' }]);
});

it('imports opening stock as one receipt', async () => {
  const rice = await productFor(db, owner, { name: 'Rice', baseUnit: 'kg', allowsFractions: true, variants: [{ sku: 'RICE', basePricePesewas: 1200, costPesewas: 1000 }] });
  const para = await productFor(db, owner, { name: 'Paracetamol', tracking: 'batch', variants: [{ sku: 'PARA', basePricePesewas: 500, costPesewas: 300 }] });
  const csv = ['code,quantity,total_cost,batch_number,expiry_date', 'RICE,25.5,255,,', 'PARA,100,300,L1,2027-06-30', 'PARA,10,30,L2,', 'NOPE,1,1,,'].join('\n');
  expect(await checkImport(db, owner, { kind: 'opening_stock', text: csv })).toMatchObject({
    errors: [{ row: 4, message: 'batch number and expiry date (YYYY-MM-DD) are needed' }, { row: 5, message: 'no item has the barcode or SKU "NOPE"' }],
  });
  expect(await runImport(db, owner, { kind: 'opening_stock', text: csv, branchId: shop.branchId, skipFailing: true }, t0)).toEqual({ ok: true, imported: 2, skipped: 2 });
  const onHand = (v: string) => withTenant(db, shop.tenantId, (tx) => stockOnHand(tx, shop.branchId, v));
  expect([await onHand(rice.variantId), await onHand(para.variantId)]).toEqual(['25.500', '100.000']);
});

it('refuses a file with the wrong headers', async () => {
  expect(await checkImport(db, owner, { kind: 'customers', text: 'full name,mobile\nAma,0244000001' })).toEqual({ ok: false, error: 'wrong_headers', detail: 'name,phone' });
});

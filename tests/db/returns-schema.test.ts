import { randomUUID } from 'node:crypto';
import { afterEach, beforeEach, expect, it } from 'vitest';
import type { Db } from '@/db/client';
import { approvals, returnLines, returns, sales } from '@/db/schema';
import { asPlatform } from '@/db/tenant';
import { ctxFor, productFor, type SeededShop, seedShop } from '../helpers/fixtures';
import { createTestDb, dbError } from '../helpers/test-db';

const t0 = new Date('2026-11-26T10:00:00Z');
let db: Db;
let close: () => Promise<void>;
let shop: SeededShop;
let item: { variantId: string; baseUnitId: string };
let saleId: string;
beforeEach(async () => {
  ({ db, close } = await createTestDb());
  shop = await seedShop(db, {});
  item = await productFor(db, await ctxFor(db, shop, 'owner', t0));
  saleId = randomUUID();
  await asPlatform(db, (tx) => tx.insert(sales).values({
    id: saleId, tenantId: shop.tenantId, branchId: shop.branchId, registerId: shop.registerId, cashierId: shop.users.owner.id,
    receiptNumber: 'B1-T1-000001', status: 'completed', taxMode: 'inclusive', subtotalPesewas: 500, discountPesewas: 0, taxPesewas: 0, totalPesewas: 500,
    paidPesewas: 500, changeDuePesewas: 0, deviceCreatedAt: t0, receivedAt: t0, businessDate: '2026-11-26', shareCode: randomUUID(),
  }));
});
afterEach(async () => { await close(); });

it('a return line quantity must be positive', async () => {
  const [ret] = await asPlatform(db, (tx) => tx.insert(returns).values({
    tenantId: shop.tenantId, branchId: shop.branchId, saleId, kind: 'receipt', reason: 'Wrong size', refundMethod: 'cash', refundPesewas: 0, requestedBy: shop.users.owner.id,
  }).returning());
  const line = { tenantId: shop.tenantId, returnId: ret.id, variantId: item.variantId, unitId: item.baseUnitId, baseQuantity: '0', condition: 'saleable' as const, refundPesewas: 0 };
  expect(await dbError(asPlatform(db, (tx) => tx.insert(returnLines).values({ ...line, quantity: '0' })))).toMatch(/return_lines_quantity/);
  await expect(asPlatform(db, (tx) => tx.insert(returnLines).values({ ...line, quantity: '1', baseQuantity: '1' }))).resolves.toBeDefined();
});

it('an approval token is unique', async () => {
  const row = { tenantId: shop.tenantId, action: 'refund', contextKey: 'x', tokenHash: 'h', requestedBy: shop.users.owner.id, approvedBy: shop.users.owner.id, expiresAt: t0 };
  await asPlatform(db, (tx) => tx.insert(approvals).values(row));
  expect(await dbError(asPlatform(db, (tx) => tx.insert(approvals).values(row)))).toMatch(/approvals_token|duplicate key/);
});

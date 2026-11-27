import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { afterEach, beforeEach, expect, it } from 'vitest';
import type { Db } from '@/db/client';
import { auditLog, payments, sales, stockBalances, tenants, users } from '@/db/schema';
import { asPlatform } from '@/db/tenant';
import { logRequestError } from '@/instrumentation';
import { restoreBackup, takeBackup } from '@/server/backup';
import { checkEnv } from '@/server/env';
import { health } from '@/server/health';
import { completeSale } from '@/server/sales';
import { saveShopPaystackKey } from '@/server/shop-paystack';
import { ctxFor, productFor, saleInput, type SeededShop, seedShop, stockFor, tillCtxFor } from '../helpers/fixtures';
import { createTestDb } from '../helpers/test-db';

const t0 = new Date('2026-11-27T09:00:00Z');
let db: Db;
let close: () => Promise<void>;
let shop: SeededShop;
const extra: Array<() => Promise<void>> = [];

beforeEach(async () => {
  ({ db, close } = await createTestDb());
  shop = await seedShop(db, { users: [
    { key: 'owner', email: 'o@bk.test', password: 'correct-horse-1', rolePreset: 'owner' },
    { key: 'manager', phone: '0200000009', pin: '4321', rolePreset: 'manager' },
  ] });
});
afterEach(async () => { await close(); for (const c of extra.splice(0)) await c(); });

it('a backup restores into a fresh database with every row, and the shop works afterwards', async () => {
  const owner = await ctxFor(db, shop, 'owner', t0);
  const p = await productFor(db, owner);
  await stockFor(db, owner, shop.branchId, { variantId: p.variantId, unitId: p.baseUnitId, quantity: '9', totalCostPesewas: 2700 }, t0);
  await saveShopPaystackKey(db, owner, `sk_test_${'b2'.repeat(20)}`);
  const till = await tillCtxFor(db, shop, 'manager', t0);
  await completeSale(db, till, saleInput({ lines: [{ variantId: p.variantId, unitId: p.baseUnitId, quantity: '2', unitPricePesewas: 500, discountPesewas: 0 }],
    tenders: [{ id: randomUUID(), method: 'cash', amountPesewas: 1000 }], deviceCreatedAt: t0.toISOString() }), t0);

  const backup = JSON.parse(JSON.stringify(await takeBackup(db, t0))); // as written to and read from a file
  expect(backup.tables.sales).toHaveLength(1);

  const fresh = await createTestDb();
  extra.push(fresh.close);
  expect((await restoreBackup(fresh.db, backup)).rows).toBeGreaterThan(20);
  const again = await takeBackup(fresh.db, t0);
  for (const [table, rows] of Object.entries(backup.tables as Record<string, unknown[]>)) {
    if (table === 'device_cache_versions') continue; // triggers rewrite these during the restore
    expect(again.tables[table], table).toEqual(rows);
  }
  const [sale] = await asPlatform(fresh.db, (tx) => tx.select().from(sales));
  expect(sale).toMatchObject({ totalPesewas: 1000, status: 'completed' });
  const [bal] = await asPlatform(fresh.db, (tx) => tx.select().from(stockBalances).where(eq(stockBalances.variantId, p.variantId)));
  expect(bal.onHand).toBe('7.000');
  expect(await asPlatform(fresh.db, (tx) => tx.select({ m: payments.method }).from(payments))).toEqual([{ m: 'cash' }]);
  const [t] = await asPlatform(fresh.db, (tx) => tx.select().from(tenants));
  expect(t.paystackSecretSealed).toBeTruthy(); // sealed secrets come back as they were

  // the restored shop keeps working: new audit rows get fresh ids after the restored ones
  const before = await asPlatform(fresh.db, (tx) => tx.select({ id: auditLog.id }).from(auditLog));
  const freshTill = await tillCtxFor(fresh.db, shop, 'manager', t0);
  expect(await completeSale(fresh.db, freshTill, saleInput({ lines: [{ variantId: p.variantId, unitId: p.baseUnitId, quantity: '1', unitPricePesewas: 500, discountPesewas: 0 }],
    tenders: [{ id: randomUUID(), method: 'cash', amountPesewas: 500 }], deviceCreatedAt: t0.toISOString() }), t0)).toMatchObject({ ok: true });
  const after = await asPlatform(fresh.db, (tx) => tx.select({ id: auditLog.id }).from(auditLog));
  expect(after.length).toBeGreaterThan(before.length);
});

it('refuses to restore over a database that already holds shops, or a file that is not a backup', async () => {
  const backup = await takeBackup(db, t0);
  await expect(restoreBackup(db, backup)).rejects.toThrow(/already holds shops/);
  await expect(restoreBackup(db, { tables: {} } as never)).rejects.toThrow(/not a backup/);
  expect((await asPlatform(db, (tx) => tx.select().from(users))).length).toBe(2); // nothing changed
});

it('health: database up and fully migrated', async () => {
  expect(await health(db, t0)).toMatchObject({ ok: true, database: 'ok' });
});

it('production refuses to start without its required settings; development only warns', () => {
  const good = {
    NODE_ENV: 'production', DATABASE_URL: 'postgres://x', APP_URL: 'https://pos.example.com', MFA_SECRET_KEY: Buffer.alloc(32, 1).toString('base64'),
    CRON_SECRET: 'c'.repeat(40), RESEND_API_KEY: 're_x', R2_ACCOUNT_ID: 'a', R2_ACCESS_KEY_ID: 'b', R2_SECRET_ACCESS_KEY: 'c', R2_BUCKET: 'd',
    SMS_API_KEY: 's', PAYSTACK_SECRET_KEY: 'sk_live_x', REPORT_EMAIL: 'r@example.com',
  } as unknown as NodeJS.ProcessEnv;
  expect(checkEnv(good)).toEqual({ errors: [], warnings: [] });
  const bad = checkEnv({ ...good, DATABASE_URL: '', APP_URL: 'http://pos.example.com', MFA_SECRET_KEY: 'short', R2_BUCKET: '' });
  expect(bad.errors).toHaveLength(4);
  expect(checkEnv({ NODE_ENV: 'development' } as unknown as NodeJS.ProcessEnv).errors).toEqual([]);
  expect(JSON.stringify(bad)).not.toContain('postgres://'); // values are never echoed
});

it('server errors are logged as one JSON line without the query string', () => {
  const line = JSON.parse(logRequestError(new Error('boom'), { path: '/shop/app/sales?phone=0244000001', method: 'GET', headers: { cookie: 'pos_session=secret' } },
    { routerKind: 'App Router', routePath: '/[slug]/app/sales', routeType: 'render' }));
  expect(line).toMatchObject({ level: 'error', message: 'boom', path: '/shop/app/sales', route: '/[slug]/app/sales' });
  expect(JSON.stringify(line)).not.toMatch(/0244000001|secret/);
});

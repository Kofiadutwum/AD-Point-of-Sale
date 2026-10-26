import { and, eq } from 'drizzle-orm';
import { afterEach, beforeEach, expect, it } from 'vitest';
import type { Db } from '@/db/client';
import { auditLog, customers, storeCreditEntries } from '@/db/schema';
import { asPlatform, withTenant } from '@/db/tenant';
import type { Ctx } from '@/server/context';
import { addCustomer, issueStoreCredit, listCustomers, redeemStoreCredit } from '@/server/customers';
import { ctxFor, expectAccess, type SeededShop, seedShop, tillCtxFor } from '../helpers/fixtures';
import { createTestDb } from '../helpers/test-db';

const t0 = new Date('2026-10-20T10:00:00Z');
let db: Db;
let close: () => Promise<void>;
let shop: SeededShop;
let owner: Ctx;
let cashier: Ctx;
beforeEach(async () => {
  ({ db, close } = await createTestDb());
  shop = await seedShop(db, { users: [
    { key: 'owner', email: 'o@a.test', password: 'correct-horse-1', rolePreset: 'owner' },
    { key: 'cashier', phone: '0200000001', pin: '1234', rolePreset: 'cashier' },
  ] });
  owner = await ctxFor(db, shop, 'owner', t0);
  cashier = await tillCtxFor(db, shop, 'cashier', t0);
});
afterEach(async () => { await close(); });

const newCustomer = async () => ((await addCustomer(db, cashier, { name: 'Esi', phone: '024 123 4567' })) as { customerId: string }).customerId;

it('adds a customer with a normalised phone, once per phone', async () => {
  expect(await addCustomer(db, cashier, { name: 'Esi', phone: '024 123 4567' })).toMatchObject({ ok: true });
  expect(await addCustomer(db, cashier, { name: 'Esi B', phone: '+233241234567' })).toEqual({ ok: false, error: 'duplicate_phone' });
  expect(await addCustomer(db, cashier, { name: '', phone: '0241234568' })).toEqual({ ok: false, error: 'invalid_input' });
  expect(await addCustomer(db, cashier, { name: 'X', phone: '12' })).toEqual({ ok: false, error: 'invalid_input' });
  expect((await listCustomers(db, cashier, { query: '0241234567' }))[0]).toMatchObject({ name: 'Esi', phone: '233241234567', storeCreditPesewas: 0 });
  expect(await listCustomers(db, cashier, { query: 'es' })).toHaveLength(1);
});

it('only a manager can issue goodwill credit, with a reason, and it is audited', async () => {
  const customerId = await newCustomer();
  await expectAccess(issueStoreCredit(db, cashier, { customerId, amountPesewas: 500, source: 'goodwill', reason: 'late order' }, t0), 'forbidden');
  expect(await issueStoreCredit(db, owner, { customerId, amountPesewas: 500, source: 'goodwill', reason: '' }, t0)).toEqual({ ok: false, error: 'invalid_input' });
  expect(await issueStoreCredit(db, owner, { customerId, amountPesewas: 500, source: 'goodwill', reason: 'late order' }, t0)).toEqual({ ok: true, balancePesewas: 500 });
  const entries = await asPlatform(db, (tx) => tx.select().from(storeCreditEntries));
  expect(entries).toMatchObject([{ type: 'issued', source: 'goodwill', amountPesewas: 500, reason: 'late order' }]);
  expect(await asPlatform(db, (tx) => tx.select().from(auditLog).where(eq(auditLog.action, 'store_credit_issued')))).toHaveLength(1);
});

it("refuses another shop's customer", async () => {
  const customerId = await newCustomer();
  const b = await seedShop(db, { slug: 'shop-b' });
  const ownerB = await ctxFor(db, b, 'owner', t0);
  expect(await issueStoreCredit(db, ownerB, { customerId, amountPesewas: 1, source: 'refund', reason: 'x' }, t0)).toEqual({ ok: false, error: 'not_found' });
});

it('two redemptions at once never overdraw store credit', async () => {
  const customerId = await newCustomer();
  await issueStoreCredit(db, owner, { customerId, amountPesewas: 1000, source: 'goodwill', reason: 'x' }, t0);
  const redeem = (saleId: string) => withTenant(db, shop.tenantId, (tx) =>
    redeemStoreCredit(tx, { tenantId: shop.tenantId, customerId, amountPesewas: 600, saleId, userId: shop.users.cashier.id }));
  const results = await Promise.all([redeem(crypto.randomUUID()), redeem(crypto.randomUUID())]);
  expect(results.sort()).toEqual([false, true]);
  const [c] = await asPlatform(db, (tx) => tx.select().from(customers));
  expect(c.storeCreditPesewas).toBe(400);
  expect(await asPlatform(db, (tx) => tx.select().from(storeCreditEntries).where(and(eq(storeCreditEntries.type, 'redeemed'), eq(storeCreditEntries.amountPesewas, -600))))).toHaveLength(1);
});

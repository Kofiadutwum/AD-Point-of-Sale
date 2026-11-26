import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { afterEach, beforeEach, expect, it } from 'vitest';
import type { Db } from '@/db/client';
import { sales, variants } from '@/db/schema';
import { asPlatform } from '@/db/tenant';
import { requestApproval } from '@/server/approvals';
import type { Ctx } from '@/server/context';
import { recordDebtPayment, saveCreditTerms } from '@/server/customer-accounts';
import { addCustomer } from '@/server/customers';
import { convertQuoteToSale, createInvoice, createQuote, getSharedDoc, listInvoices } from '@/server/quotes';
import { ctxFor, productFor, type SeededShop, seedShop, stockFor, tillCtxFor } from '../helpers/fixtures';
import { createTestDb } from '../helpers/test-db';

const t0 = new Date('2026-11-26T09:00:00Z');
const day = 86_400_000;
let db: Db;
let close: () => Promise<void>;
let shop: SeededShop;
let owner: Ctx;
let manager: Ctx;
let cashier: Ctx;
let p: { variantId: string; baseUnitId: string };
let firm: string;
beforeEach(async () => {
  ({ db, close } = await createTestDb());
  shop = await seedShop(db, { users: [
    { key: 'owner', email: 'o@q.test', password: 'correct-horse-1', rolePreset: 'owner' },
    { key: 'manager', phone: '0200000009', pin: '4321', rolePreset: 'manager' },
    { key: 'cashier', phone: '0200000001', pin: '1234', rolePreset: 'cashier' },
  ] });
  owner = await ctxFor(db, shop, 'owner', t0);
  manager = await tillCtxFor(db, shop, 'manager', t0);
  cashier = await tillCtxFor(db, shop, 'cashier', t0);
  p = await productFor(db, owner); // GHS 5.00
  await stockFor(db, owner, shop.branchId, { variantId: p.variantId, unitId: p.baseUnitId, quantity: '50', totalCostPesewas: 20000 }, t0);
  firm = ((await addCustomer(db, owner, { name: 'Mensah Ventures', phone: '0244000005' })) as { customerId: string }).customerId;
  await saveCreditTerms(db, owner, { customerId: firm, creditLimitPesewas: 100000, reminderConsent: false });
});
afterEach(async () => { await close(); });

const items = (quantity: string) => [{ variantId: p.variantId, unitId: p.baseUnitId, quantity, discountPesewas: 0 }];
const cash = (amountPesewas: number) => [{ id: randomUUID(), method: 'cash' as const, amountPesewas }];

it('quotes are priced by the server and numbered', async () => {
  expect(await createQuote(db, cashier, { lines: items('3'), validDays: 7, customerId: firm }, t0)).toEqual({ ok: true, quoteId: expect.any(String), number: 'Q-0001', shareCode: expect.any(String), totalPesewas: 1500 });
  expect(await createQuote(db, cashier, { lines: items('1'), validDays: 7 }, t0)).toMatchObject({ number: 'Q-0002' });
  expect(await createQuote(db, cashier, { lines: [{ ...items('1')[0], discountPesewas: 100 }], validDays: 7 }, t0)).toEqual({ ok: false, error: 'discount_not_allowed' });
});

it('a quote sells at its prices even after a price change, once', async () => {
  const q = await createQuote(db, cashier, { lines: items('3'), validDays: 7 }, t0) as { quoteId: string };
  await asPlatform(db, (tx) => tx.update(variants).set({ basePricePesewas: 700 }).where(eq(variants.id, p.variantId)));
  expect(await convertQuoteToSale(db, cashier, { quoteId: q.quoteId, tenders: cash(1500) }, t0)).toMatchObject({ ok: true, changeDuePesewas: 0 });
  expect((await asPlatform(db, (tx) => tx.select().from(sales)))[0].totalPesewas).toBe(1500);
  expect(await convertQuoteToSale(db, cashier, { quoteId: q.quoteId, tenders: cash(1500) }, t0)).toEqual({ ok: false, error: 'not_open' });
});

it('an expired quote needs a manager', async () => {
  const q = await createQuote(db, cashier, { lines: items('1'), validDays: 1 }, t0) as { quoteId: string };
  const later = new Date(t0.getTime() + 3 * day);
  expect(await convertQuoteToSale(db, cashier, { quoteId: q.quoteId, tenders: cash(500) }, later)).toEqual({ ok: false, error: 'approval_required' });
  const a = await requestApproval(db, cashier, { action: 'honour_expired_quote', contextKey: q.quoteId, approverId: shop.users.manager.id, pin: '4321' }, later);
  expect(await convertQuoteToSale(db, cashier, { quoteId: q.quoteId, tenders: cash(500), approvalToken: (a as { token: string }).token }, later)).toMatchObject({ ok: true });
});

it('invoices go on the customer account; paid when payments cover them, overdue after the due date', async () => {
  const q = await createQuote(db, manager, { lines: items('4'), validDays: 14, customerId: firm }, t0) as { quoteId: string };
  const inv = await createInvoice(db, manager, { customerId: firm, quoteId: q.quoteId, dueDate: '2026-12-10' }, t0);
  expect(inv).toEqual({ ok: true, invoiceId: expect.any(String), number: 'INV-0001', saleId: expect.any(String), shareCode: expect.any(String) });
  expect(await createInvoice(db, manager, { customerId: firm, lines: items('2'), dueDate: '2026-11-20' }, new Date(t0.getTime() + 1000))).toMatchObject({ number: 'INV-0002' });
  expect(await createInvoice(db, cashier, { customerId: firm, lines: items('1'), dueDate: '2026-12-10' }, t0).catch(() => 'refused')).toBe('refused'); // no issue_invoices
  let list = await listInvoices(db, owner, t0);
  expect(list.map((i) => [i.number, i.owedPesewas, i.status]).sort()).toEqual([['INV-0001', 2000, 'due'], ['INV-0002', 1000, 'overdue']]);
  await recordDebtPayment(db, cashier, { customerId: firm, amountPesewas: 2000, method: 'cash' }, new Date(t0.getTime() + 2000)); // settles the oldest invoice
  list = await listInvoices(db, owner, t0);
  expect(list.map((i) => [i.number, i.owedPesewas, i.status]).sort()).toEqual([['INV-0001', 0, 'paid'], ['INV-0002', 1000, 'overdue']]);
});

it('customers open quotes and invoices from a link', async () => {
  const q = await createQuote(db, cashier, { lines: items('2'), validDays: 7, customerId: firm, note: 'Delivery included' }, t0) as { shareCode: string };
  expect(await getSharedDoc(db, shop.slug, q.shareCode)).toMatchObject({ kind: 'quote', number: 'Q-0001', totalPesewas: 1000, note: 'Delivery included', customer: { name: 'Mensah Ventures' } });
  const inv = await createInvoice(db, manager, { customerId: firm, lines: items('1'), dueDate: '2026-12-10' }, t0) as { shareCode: string };
  expect(await getSharedDoc(db, shop.slug, inv.shareCode)).toMatchObject({ kind: 'invoice', number: 'INV-0001', totalPesewas: 500, owedPesewas: 500 });
  expect(await getSharedDoc(db, shop.slug, 'not-a-real-code-123')).toBeNull();
});

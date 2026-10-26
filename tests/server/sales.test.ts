import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { afterEach, beforeEach, expect, it } from 'vitest';
import type { Db } from '@/db/client';
import { auditLog, customers, payments, registers, sales, saleLines, serials, tenants, users } from '@/db/schema';
import { asPlatform, withTenant } from '@/db/tenant';
import type { Ctx } from '@/server/context';
import { addCustomer, issueStoreCredit } from '@/server/customers';
import { createPriceList, setPriceListItem } from '@/server/price-lists';
import { setProductStatus } from '@/server/products';
import { completeSale, finaliseSale, type SaleInput } from '@/server/sales';
import { saveSellingSettings } from '@/server/shop-settings';
import { stockOnHand } from '@/server/stock';
import { saveTaxRule } from '@/server/tax-rules';
import { expectAccess, ctxFor, productFor, saleInput, type SeededShop, seedShop, stockFor, tillCtxFor } from '../helpers/fixtures';
import { createTestDb } from '../helpers/test-db';

const t0 = new Date('2026-10-20T10:00:00Z');
let db: Db;
let close: () => Promise<void>;
let shop: SeededShop;
let owner: Ctx;
let cashier: Ctx;
let p: { productId: string; variantId: string; baseUnitId: string };
beforeEach(async () => {
  ({ db, close } = await createTestDb());
  shop = await seedShop(db, { users: [
    { key: 'owner', email: 'o@a.test', password: 'correct-horse-1', rolePreset: 'owner' },
    { key: 'cashier', phone: '0200000001', pin: '1234', rolePreset: 'cashier' },
    { key: 'cashier2', phone: '0200000002', pin: '1234', rolePreset: 'cashier' },
  ] });
  owner = await ctxFor(db, shop, 'owner', t0);
  cashier = await tillCtxFor(db, shop, 'cashier', t0);
  await saveTaxRule(db, owner, { name: 'VAT', rateBp: 1500, levies: [], vatOnLevies: false, isDefault: true, active: true });
  await saveSellingSettings(db, owner, { taxEnabled: true, scaleLayout: null, modules: [] });
  p = await productFor(db, owner); // GHS 5.00 a piece
  await stockFor(db, owner, shop.branchId, { variantId: p.variantId, unitId: p.baseUnitId, quantity: '10', totalCostPesewas: 4000 }, t0);
});
afterEach(async () => { await close(); });

type Item = { variantId: string; baseUnitId: string };
const line = (item: Item, quantity: string, unitPricePesewas: number, extra: Partial<SaleInput['lines'][number]> = {}) =>
  ({ variantId: item.variantId, unitId: item.baseUnitId, quantity, unitPricePesewas, discountPesewas: 0, ...extra });
const cash = (amountPesewas: number) => ({ id: randomUUID(), method: 'cash' as const, amountPesewas });
const momo = (amountPesewas: number, reference?: string) => ({ id: randomUUID(), method: 'momo_manual' as const, amountPesewas, reference });
const onHand = (variantId = p.variantId) => withTenant(db, shop.tenantId, (tx) => stockOnHand(tx, shop.branchId, variantId));
const allSales = () => asPlatform(db, (tx) => tx.select().from(sales));
const fail = (error: string) => ({ ok: false, error });

it('completes a cash sale with change and reduces stock once', async () => {
  const r = await completeSale(db, cashier, saleInput({ lines: [line(p, '2', 500)], tenders: [cash(2000)] }), t0);
  expect(r).toEqual({ ok: true, saleId: expect.any(String), status: 'completed', changeDuePesewas: 1000, alreadyExisted: false });
  expect(await onHand()).toBe('8.000');
  const [s] = await allSales();
  expect(s).toMatchObject({ totalPesewas: 1000, taxPesewas: 130, businessDate: '2026-10-20', status: 'completed', cashierId: shop.users.cashier.id });
  expect(await asPlatform(db, (tx) => tx.select().from(auditLog).where(eq(auditLog.action, 'sale_completed')))).toHaveLength(1);
});

it('a sale sent twice with the same id makes one sale, one receipt, one deduction', async () => {
  const input = saleInput({ lines: [line(p, '1', 500)] });
  await completeSale(db, cashier, input, t0);
  expect(await completeSale(db, cashier, input, t0)).toMatchObject({ ok: true, alreadyExisted: true, status: 'completed', changeDuePesewas: 99500 });
  expect(await onHand()).toBe('9.000');
  expect(await allSales()).toHaveLength(1);
  expect(await asPlatform(db, (tx) => tx.select().from(payments))).toHaveLength(1);
});

it('two identical requests at once make one sale and deduct once', async () => {
  const input = saleInput({ lines: [line(p, '1', 500)] });
  const [x, y] = await Promise.all([completeSale(db, cashier, input, t0), completeSale(db, cashier, input, t0)]);
  expect([x, y].filter((r) => r.ok && r.alreadyExisted)).toHaveLength(1);
  expect([x, y].every((r) => r.ok)).toBe(true);
  expect(await onHand()).toBe('9.000');
});

it('takes split tenders; only cash may go over the total', async () => {
  expect(await completeSale(db, cashier, saleInput({ lines: [line(p, '2', 500)], tenders: [momo(600, 'MP123'), cash(500)] }), t0))
    .toMatchObject({ ok: true, changeDuePesewas: 100 });
  expect(await completeSale(db, cashier, saleInput({ lines: [line(p, '2', 500)], tenders: [momo(1200, 'MP124')] }), t0)).toEqual(fail('reduce_non_cash_amount'));
  expect(await completeSale(db, cashier, saleInput({ lines: [line(p, '2', 500)], tenders: [momo(1000)] }), t0)).toEqual(fail('reference_required'));
  expect(await completeSale(db, cashier, saleInput({ lines: [line(p, '2', 500)], tenders: [cash(900)] }), t0)).toEqual(fail('payment_incomplete'));
  expect(await allSales()).toHaveLength(1);
});

it('spends store credit as a tender and never below zero', async () => {
  const { customerId } = await addCustomer(db, cashier, { name: 'Esi', phone: '0241234567' }) as { customerId: string };
  await issueStoreCredit(db, owner, { customerId, amountPesewas: 300, source: 'goodwill', reason: 'x' }, t0);
  const credit = (amountPesewas: number) => ({ id: randomUUID(), method: 'store_credit' as const, amountPesewas });
  expect(await completeSale(db, cashier, saleInput({ lines: [line(p, '2', 500)], tenders: [credit(300), cash(700)] }), t0)).toEqual(fail('store_credit_needs_customer'));
  expect(await completeSale(db, cashier, saleInput({ customerId, lines: [line(p, '2', 500)], tenders: [credit(300), cash(700)] }), t0)).toMatchObject({ ok: true });
  expect((await asPlatform(db, (tx) => tx.select().from(customers)))[0].storeCreditPesewas).toBe(0);
  expect(await completeSale(db, cashier, saleInput({ customerId, lines: [line(p, '1', 500)], tenders: [credit(1), cash(499)] }), t0)).toEqual(fail('insufficient_store_credit'));
  expect(await allSales()).toHaveLength(1);
  expect(await onHand()).toBe('8.000');
});

it('refuses a changed price online but keeps the paid price from the outbox and flags it', async () => {
  expect(await completeSale(db, cashier, saleInput({ lines: [line(p, '1', 450)] }), t0)).toEqual(fail('price_changed'));
  expect(await completeSale(db, cashier, saleInput({ lines: [line(p, '1', 450)], fromOfflineOutbox: true }), t0)).toMatchObject({ ok: true, status: 'completed' });
  const [s] = await allSales();
  expect(s).toMatchObject({ needsReview: true, reviewReasons: ['price_changed'], fromOffline: true, totalPesewas: 450 });
  expect((await asPlatform(db, (tx) => tx.select().from(saleLines)))[0]).toMatchObject({ unitPricePesewas: 450, currentPricePesewas: 500 });
});

it('applies the customer price list and quantity breaks', async () => {
  const { priceListId } = await createPriceList(db, owner, { name: 'Wholesale', kind: 'wholesale', branchId: null, startsOn: null, endsOn: null }) as { priceListId: string };
  await setPriceListItem(db, owner, { priceListId, unitId: p.baseUnitId, minQuantity: '1', pricePesewas: 400 });
  await setPriceListItem(db, owner, { priceListId, unitId: p.baseUnitId, minQuantity: '5', pricePesewas: 350 });
  const { customerId } = await addCustomer(db, cashier, { name: 'Trader', phone: '0241234568', priceListId }) as { customerId: string };
  expect(await completeSale(db, cashier, saleInput({ customerId, lines: [line(p, '1', 500)] }), t0)).toEqual(fail('price_changed'));
  expect(await completeSale(db, cashier, saleInput({ customerId, lines: [line(p, '1', 400)] }), t0)).toMatchObject({ ok: true });
  expect(await completeSale(db, cashier, saleInput({ customerId, lines: [line(p, '5', 350)] }), t0)).toMatchObject({ ok: true });
});

it('checks the receipt number belongs to this till and is not reused', async () => {
  expect(await completeSale(db, cashier, saleInput({ receiptNumber: 'B2-T1-000001', lines: [line(p, '1', 500)] }), t0)).toEqual(fail('wrong_receipt_prefix'));
  expect(await completeSale(db, cashier, saleInput({ receiptNumber: 'B1-T1-1', lines: [line(p, '1', 500)] }), t0)).toEqual(fail('invalid_input'));
  expect(await completeSale(db, cashier, saleInput({ receiptNumber: 'B1-T1-000041', lines: [line(p, '1', 500)] }), t0)).toMatchObject({ ok: true });
  expect(await completeSale(db, cashier, saleInput({ receiptNumber: 'B1-T1-000041', lines: [line(p, '1', 500)] }), t0)).toEqual(fail('duplicate_receipt_number'));
  expect(await completeSale(db, cashier, saleInput({ receiptNumber: 'B1-T1-000007', lines: [line(p, '1', 500)] }), t0)).toMatchObject({ ok: true });
  expect((await asPlatform(db, (tx) => tx.select().from(registers)))[0].receiptCounter).toBe(41);
});

it('needs give_discount for a discount, never above the line amount', async () => {
  expect(await completeSale(db, cashier, saleInput({ lines: [line(p, '1', 500, { discountPesewas: 50 })] }), t0)).toEqual(fail('discount_not_allowed'));
  const manager = await tillCtxFor(db, shop, 'owner', t0);
  expect(await completeSale(db, manager, saleInput({ lines: [line(p, '1', 500, { discountPesewas: 501 })] }), t0)).toEqual(fail('discount_too_large'));
  expect(await completeSale(db, manager, saleInput({ lines: [line(p, '1', 500, { discountPesewas: 50 })], tenders: [cash(450)] }), t0))
    .toMatchObject({ ok: true, changeDuePesewas: 0 });
});

it('blocks negative stock when the shop says so, but not from the outbox', async () => {
  await asPlatform(db, (tx) => tx.update(tenants).set({ allowNegativeStock: false }));
  expect(await completeSale(db, cashier, saleInput({ lines: [line(p, '11', 500)] }), t0)).toEqual(fail('not_enough_stock'));
  expect(await allSales()).toHaveLength(0);
  expect(await onHand()).toBe('10.000');
  expect(await completeSale(db, cashier, saleInput({ lines: [line(p, '11', 500)], fromOfflineOutbox: true }), t0)).toMatchObject({ ok: true });
  expect((await allSales())[0]).toMatchObject({ needsReview: true, reviewReasons: ['negative_stock'] });
});

it('allows negative stock by default and records the alert', async () => {
  expect(await completeSale(db, cashier, saleInput({ lines: [line(p, '11', 500)] }), t0)).toMatchObject({ ok: true });
  expect(await onHand()).toBe('-1.000');
  expect((await allSales())[0].needsReview).toBe(false);
});

it('refuses an empty bundle and an archived item online', async () => {
  const bundle = await productFor(db, owner, { kind: 'bundle' });
  expect(await completeSale(db, cashier, saleInput({ lines: [line(bundle, '1', 500)] }), t0)).toEqual(fail('empty_bundle'));
  await setProductStatus(db, owner, p.productId, 'archived');
  expect(await completeSale(db, cashier, saleInput({ lines: [line(p, '1', 500)] }), t0)).toEqual(fail('item_unavailable'));
  expect(await completeSale(db, cashier, saleInput({ lines: [line(p, '1', 500)], fromOfflineOutbox: true }), t0)).toMatchObject({ ok: true });
  expect((await allSales())[0].reviewReasons).toEqual(['item_archived']);
});

it('sells serial items only with their serials', async () => {
  const phone = await productFor(db, owner, { tracking: 'serial', variants: [{ basePricePesewas: 100000, costPesewas: 80000 }] });
  await stockFor(db, owner, shop.branchId, { variantId: phone.variantId, unitId: phone.baseUnitId, quantity: '1', totalCostPesewas: 80000, serials: ['IMEI1'] }, t0);
  const sell = (serialList?: string[]) => completeSale(db, cashier, saleInput({ lines: [line(phone, '1', 100000, { serials: serialList })], tenders: [cash(100000)] }), t0);
  expect(await sell()).toEqual(fail('serials_required'));
  expect(await sell(['NOPE'])).toEqual(fail('unknown_serial'));
  expect(await sell(['IMEI1'])).toMatchObject({ ok: true });
  expect((await asPlatform(db, (tx) => tx.select().from(serials)))[0].status).toBe('sold');
  expect(await sell(['IMEI1'])).toEqual(fail('unknown_serial'));
});

it('records the offline cashier after checking them', async () => {
  const other = shop.users.cashier2.id;
  expect(await completeSale(db, cashier, saleInput({ cashierId: other, lines: [line(p, '1', 500)] }), t0)).toEqual(fail('cashier_not_allowed'));
  expect(await completeSale(db, cashier, saleInput({ cashierId: other, lines: [line(p, '1', 500)], fromOfflineOutbox: true }), t0)).toMatchObject({ ok: true });
  expect((await allSales())[0].cashierId).toBe(other);
  await asPlatform(db, (tx) => tx.update(users).set({ status: 'inactive' }).where(eq(users.id, other)));
  expect(await completeSale(db, cashier, saleInput({ cashierId: other, lines: [line(p, '1', 500)], fromOfflineOutbox: true }), t0)).toEqual(fail('cashier_not_allowed'));
});

it('an outbox sale made before midnight counts for that day; a future device time counts as now', async () => {
  await completeSale(db, cashier, saleInput({ deviceCreatedAt: '2026-10-19T23:50:00Z', lines: [line(p, '1', 500)], fromOfflineOutbox: true }), t0);
  await completeSale(db, cashier, saleInput({ deviceCreatedAt: '2026-10-21T10:00:00Z', lines: [line(p, '1', 500)], fromOfflineOutbox: true }), t0);
  expect((await allSales()).map((s) => s.businessDate).sort()).toEqual(['2026-10-19', '2026-10-20']);
});

it('an underpaid outbox sale stays pending, does not reduce stock, and is flagged', async () => {
  expect(await completeSale(db, cashier, saleInput({ lines: [line(p, '2', 500)], tenders: [cash(400)], fromOfflineOutbox: true }), t0))
    .toMatchObject({ ok: true, status: 'pending', changeDuePesewas: 0 });
  expect(await onHand()).toBe('10.000');
  expect((await allSales())[0]).toMatchObject({ status: 'pending', reviewReasons: ['underpaid'], needsReview: true });
});

it("refuses another shop's items, customer, and sale id", async () => {
  const b = await seedShop(db, { slug: 'shop-b', users: [
    { key: 'owner', email: 'o@b.test', password: 'correct-horse-1', rolePreset: 'owner' },
    { key: 'cashier', phone: '0200000009', pin: '1234', rolePreset: 'cashier' },
  ] });
  const ownerB = await ctxFor(db, b, 'owner', t0);
  const cashierB = await tillCtxFor(db, b, 'cashier', t0);
  const pb = await productFor(db, ownerB);
  const { customerId } = await addCustomer(db, cashierB, { name: 'B', phone: '0241234569' }) as { customerId: string };
  expect(await completeSale(db, cashier, saleInput({ lines: [line(pb, '1', 500)] }), t0)).toEqual(fail('unknown_item'));
  expect(await completeSale(db, cashier, saleInput({ customerId, lines: [line(p, '1', 500)] }), t0)).toEqual(fail('unknown_customer'));
  const theirs = saleInput({ lines: [line(pb, '1', 500)] });
  expect(await completeSale(db, cashierB, theirs, t0)).toMatchObject({ ok: true });
  expect(await completeSale(db, cashier, { ...saleInput({ lines: [line(p, '1', 500)] }), saleId: theirs.saleId }, t0)).toEqual(fail('sale_id_taken'));
  expect(await onHand()).toBe('10.000');
});

it('finalising twice deducts once', async () => {
  const r = await completeSale(db, cashier, saleInput({ lines: [line(p, '1', 500)] }), t0);
  expect(await finaliseSale(db, cashier, (r as { saleId: string }).saleId, t0)).toEqual({ ok: true, status: 'completed' });
  expect(await onHand()).toBe('9.000');
});

it('needs a till and a shop that may sell', async () => {
  expect(await completeSale(db, owner, saleInput({ lines: [line(p, '1', 500)] }), t0)).toEqual(fail('no_register'));
  await asPlatform(db, (tx) => tx.update(users).set({ branchIds: [] }).where(eq(users.id, shop.users.cashier.id)));
  expect(await completeSale(db, cashier, saleInput({ lines: [line(p, '1', 500)] }), t0)).toEqual(fail('not_assigned'));
  const ro = await seedShop(db, { slug: 'shop-ro', subscription: { status: 'active', endDate: '2026-01-01' } });
  const roCtx = await ctxFor(db, ro, 'owner', t0);
  await expectAccess(completeSale(db, roCtx, saleInput({ lines: [line(p, '1', 500)] }), t0), 'read_only');
});

it("a cashier cannot borrow another user's discount permission through the outbox, and a cashier override is flagged", async () => {
  const manager = shop.users.owner.id;
  expect(await completeSale(db, cashier, saleInput({ cashierId: manager, fromOfflineOutbox: true, lines: [line(p, '1', 500, { discountPesewas: 50 })], tenders: [cash(450)] }), t0))
    .toEqual(fail('discount_not_allowed'));
  expect(await completeSale(db, cashier, saleInput({ cashierId: shop.users.cashier2.id, fromOfflineOutbox: true, lines: [line(p, '1', 500)] }), t0)).toMatchObject({ ok: true });
  expect((await allSales())[0]).toMatchObject({ needsReview: true, reviewReasons: ['cashier_override'] });
});

it("a tender id used by another shop is a 409-style refusal, not a crash", async () => {
  const b = await seedShop(db, { slug: 'shop-b', users: [
    { key: 'owner', email: 'o@b.test', password: 'correct-horse-1', rolePreset: 'owner' },
    { key: 'cashier', phone: '0200000009', pin: '1234', rolePreset: 'cashier' },
  ] });
  const ownerB = await ctxFor(db, b, 'owner', t0);
  const pb = await productFor(db, ownerB);
  const tender = cash(500);
  expect(await completeSale(db, await tillCtxFor(db, b, 'cashier', t0), saleInput({ lines: [line(pb, '1', 500)], tenders: [tender] }), t0)).toMatchObject({ ok: true });
  expect(await completeSale(db, cashier, saleInput({ lines: [line(p, '1', 500)], tenders: [tender] }), t0)).toEqual(fail('duplicate_tender_id'));
  expect(await onHand()).toBe('10.000');
});

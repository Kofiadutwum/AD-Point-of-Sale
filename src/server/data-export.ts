import 'server-only';
import { and, asc, between, eq, gte, lt, sql } from 'drizzle-orm';
import type { Db, Tx } from '@/db/client';
import { branches, customerLedger, customers, expenses, payments, products, returns, saleLines, sales, stockBalances, users, variants } from '@/db/schema';
import { withTenant } from '@/db/tenant';
import { toCsv } from '@/lib/csv';
import { writeAudit } from './audit';
import { assertPermission, type Ctx } from './context';
import { type Fail, fail, itemLabel } from './products';

export const DATASETS = ['products', 'customers', 'stock', 'sales', 'payments', 'ledger', 'expenses', 'accounting'] as const;
export type Dataset = (typeof DATASETS)[number];
export const DATASET_LABELS: Record<Dataset, string> = {
  products: 'Products and prices', customers: 'Customers and balances', stock: 'Stock on hand by branch', sales: 'Sales, one row per item sold',
  payments: 'Payments taken', ledger: 'Customer account entries', expenses: 'Expenses', accounting: 'Accounting summary by day',
};
const DATED: readonly Dataset[] = ['sales', 'payments', 'ledger', 'expenses', 'accounting'];
export const isDated = (d: Dataset) => DATED.includes(d);

const MAX_DAYS = 366;
const DAY = /^\d{4}-\d{2}-\d{2}$/;
type Row = Array<string | number | null>;
type Range = { from: string; to: string };
const cedis = (p: number | null) => (p === null ? null : (p / 100).toFixed(2)); // accounting software wants cedis, not pesewas

// shortcut: dates of entries without a business date are taken in UTC, which is Ghana time; use the shop timezone when shops outside GMT sign up.
const createdIn = (col: Parameters<typeof gte>[0], r: Range) => and(gte(col, new Date(`${r.from}T00:00:00Z`)), lt(col, new Date(Date.parse(`${r.to}T00:00:00Z`) + 86_400_000)));

const BUILDERS: Record<Dataset, (tx: Tx, r: Range) => Promise<Row[]>> = {
  products: async (tx) => [
    ['Product', 'Variant', 'SKU', 'Price (GHS)', 'Average cost per base unit (GHS)', 'Reorder level', 'Status'],
    ...(await tx.select({ p: products.name, v: variants.name, sku: variants.sku, price: variants.basePricePesewas, cost: variants.averageCost, reorder: variants.reorderLevel, status: variants.status })
      .from(variants).innerJoin(products, eq(products.id, variants.productId)).orderBy(asc(products.name), asc(variants.name)))
      .map((x) => [x.p, x.v, x.sku, cedis(x.price), (Number(x.cost) / 100).toFixed(4), x.reorder, x.status]),
  ],
  customers: async (tx) => [
    ['Name', 'Phone', 'Address', 'TIN', 'Owes (GHS)', 'Credit limit (GHS)', 'Store credit (GHS)', 'Agreed to SMS reminders', 'Added'],
    ...(await tx.select().from(customers).orderBy(asc(customers.name)))
      .map((c) => [c.name, c.phone, c.address, c.tin, cedis(c.balancePesewas), cedis(c.creditLimitPesewas), cedis(c.storeCreditPesewas), c.reminderConsent ? 'yes' : 'no', c.createdAt.toISOString().slice(0, 10)]),
  ],
  stock: async (tx) => [
    ['Branch', 'Item', 'SKU', 'On hand (base units)', 'Value at average cost (GHS)'],
    ...(await tx.select({ b: branches.name, p: products.name, v: variants.name, sku: variants.sku, onHand: stockBalances.onHand, cost: variants.averageCost })
      .from(stockBalances).innerJoin(branches, eq(branches.id, stockBalances.branchId)).innerJoin(variants, eq(variants.id, stockBalances.variantId))
      .innerJoin(products, eq(products.id, variants.productId)).orderBy(asc(branches.name), asc(products.name)))
      .map((x) => [x.b, itemLabel(x.p, x.v), x.sku, x.onHand, (Number(x.onHand) * Number(x.cost) / 100).toFixed(2)]),
  ],
  sales: async (tx, r) => [
    ['Business date', 'Receipt', 'Branch', 'Cashier', 'Item', 'Unit', 'Quantity', 'Unit price (GHS)', 'Discount (GHS)', 'Tax rate (%)', 'Tax (GHS)', 'Line total (GHS)'],
    ...(await tx.select({ d: sales.businessDate, rn: sales.receiptNumber, b: branches.name, c: users.name, l: saleLines })
      .from(saleLines).innerJoin(sales, eq(sales.id, saleLines.saleId)).innerJoin(branches, eq(branches.id, sales.branchId)).innerJoin(users, eq(users.id, sales.cashierId))
      .where(and(eq(sales.status, 'completed'), between(sales.businessDate, r.from, r.to))).orderBy(asc(sales.businessDate), asc(sales.receiptNumber), asc(saleLines.lineNo)))
      .map((x) => [x.d, x.rn, x.b, x.c, x.l.name, x.l.unitName, x.l.quantity, cedis(x.l.unitPricePesewas), cedis(x.l.discountPesewas), x.l.taxRateBp / 100, cedis(x.l.taxPesewas), cedis(x.l.totalPesewas)]),
  ],
  payments: async (tx, r) => [
    ['Business date', 'Receipt', 'Method', 'Amount (GHS)', 'Reference', 'Status'],
    ...(await tx.select({ d: sales.businessDate, rn: sales.receiptNumber, p: payments }).from(payments).innerJoin(sales, eq(sales.id, payments.saleId))
      .where(and(eq(sales.status, 'completed'), between(sales.businessDate, r.from, r.to))).orderBy(asc(sales.businessDate), asc(sales.receiptNumber)))
      .map((x) => [x.d, x.rn, x.p.method, cedis(x.p.amountPesewas), x.p.reference, x.p.status]),
  ],
  ledger: async (tx, r) => [
    ['Date', 'Customer', 'Phone', 'Type', 'Amount (GHS)', 'Balance after (GHS)', 'Method', 'Reference', 'Reason', 'By'],
    ...(await tx.select({ e: customerLedger, n: customers.name, ph: customers.phone, by: users.name }).from(customerLedger)
      .innerJoin(customers, eq(customers.id, customerLedger.customerId)).innerJoin(users, eq(users.id, customerLedger.userId))
      .where(createdIn(customerLedger.createdAt, r)).orderBy(asc(customerLedger.createdAt), asc(customerLedger.id)))
      .map((x) => [x.e.createdAt.toISOString(), x.n, x.ph, x.e.type, cedis(x.e.amountPesewas), cedis(x.e.balanceAfterPesewas), x.e.method, x.e.reference, x.e.reason, x.by]),
  ],
  expenses: async (tx, r) => [
    ['Date', 'Branch', 'Category', 'Amount (GHS)', 'Method', 'Reference', 'Note', 'Recorded by'],
    ...(await tx.select({ e: expenses, b: branches.name, by: users.name }).from(expenses).innerJoin(branches, eq(branches.id, expenses.branchId))
      .innerJoin(users, eq(users.id, expenses.recordedBy)).where(createdIn(expenses.createdAt, r)).orderBy(asc(expenses.createdAt)))
      .map((x) => [x.e.createdAt.toISOString(), x.b, x.e.category, cedis(x.e.amountPesewas), x.e.method, x.e.reference, x.e.note, x.by]),
  ],
  accounting: async (tx, r) => {
    const days = new Map<string, { sales: number; discount: number; tax: number; byMethod: Record<string, number>; refunds: number; expenses: number }>();
    const at = (d: string) => days.get(d) ?? days.set(d, { sales: 0, discount: 0, tax: 0, byMethod: {}, refunds: 0, expenses: 0 }).get(d)!;
    const inRange = and(eq(sales.status, 'completed'), between(sales.businessDate, r.from, r.to));
    for (const s of await tx.select({ d: sales.businessDate, total: sql<number>`sum(${sales.totalPesewas})::int`, discount: sql<number>`sum(${sales.discountPesewas})::int`, tax: sql<number>`sum(${sales.taxPesewas})::int` })
      .from(sales).where(inRange).groupBy(sales.businessDate)) Object.assign(at(s.d), { sales: s.total, discount: s.discount, tax: s.tax });
    for (const p of await tx.select({ d: sales.businessDate, m: payments.method, amount: sql<number>`sum(${payments.amountPesewas})::int` })
      .from(payments).innerJoin(sales, eq(sales.id, payments.saleId)).where(inRange).groupBy(sales.businessDate, payments.method)) at(p.d).byMethod[p.m] = p.amount;
    const utcDay = (col: typeof returns.createdAt | typeof expenses.createdAt) => sql<string>`to_char(${col} at time zone 'UTC', 'YYYY-MM-DD')`;
    for (const x of await tx.select({ d: utcDay(returns.createdAt), amount: sql<number>`sum(${returns.refundPesewas})::int` }).from(returns).where(createdIn(returns.createdAt, r)).groupBy(utcDay(returns.createdAt))) at(x.d).refunds = x.amount;
    for (const x of await tx.select({ d: utcDay(expenses.createdAt), amount: sql<number>`sum(${expenses.amountPesewas})::int` }).from(expenses).where(createdIn(expenses.createdAt, r)).groupBy(utcDay(expenses.createdAt))) at(x.d).expenses = x.amount;
    const methods = ['cash', 'momo_manual', 'card_terminal', 'bank_transfer', 'credit', 'store_credit', 'exchange_credit', 'channel_settlement'];
    return [
      ['Date', 'Sales (GHS)', 'Discounts (GHS)', 'Tax (GHS)', ...methods.map((m) => `${m} (GHS)`), 'Refunds (GHS)', 'Expenses (GHS)'],
      ...[...days.entries()].sort(([a], [b]) => a.localeCompare(b))
        .map(([d, v]) => [d, cedis(v.sales), cedis(v.discount), cedis(v.tax), ...methods.map((m) => cedis(v.byMethod[m] ?? 0)), cedis(v.refunds), cedis(v.expenses)]),
    ];
  },
};

/** Spec 4.29, 6.46: one dataset as CSV, allowed during read-only expiry; every export is audited. Prescriptions are never exported here. */
export async function exportData(db: Db, ctx: Ctx, dataset: string, range: Partial<Range>): Promise<{ ok: true; csv: string; filename: string } | Fail<'invalid_input' | 'range_too_long'>> {
  assertPermission(ctx, 'export_data', { allowReadOnly: true });
  if (!(DATASETS as readonly string[]).includes(dataset)) return fail('invalid_input');
  const d = dataset as Dataset;
  let r: Range = { from: '', to: '' };
  if (isDated(d)) {
    if (!range.from || !range.to || !DAY.test(range.from) || !DAY.test(range.to) || Number.isNaN(Date.parse(range.from)) || Number.isNaN(Date.parse(range.to)) || range.from > range.to) return fail('invalid_input');
    if ((Date.parse(range.to) - Date.parse(range.from)) / 86_400_000 >= MAX_DAYS) return fail('range_too_long');
    r = { from: range.from, to: range.to };
  }
  return withTenant(db, ctx.tenantId, async (tx) => {
    const rows = await BUILDERS[d](tx, r);
    await writeAudit(tx, { tenantId: ctx.tenantId, actorType: 'user', actorId: ctx.userId, action: 'data_exported', recordType: 'tenant', recordId: ctx.tenantId, changes: { dataset: d, ...(isDated(d) ? r : {}) } });
    return { ok: true as const, csv: toCsv(rows), filename: isDated(d) ? `${d}-${r.from}-to-${r.to}.csv` : `${d}.csv` };
  });
}

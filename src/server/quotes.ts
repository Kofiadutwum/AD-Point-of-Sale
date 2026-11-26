import 'server-only';
import { randomBytes, randomUUID } from 'node:crypto';
import { and, asc, desc, eq, inArray } from 'drizzle-orm';
import { z } from 'zod';
import type { Db, Tx } from '@/db/client';
import {
  branches, customerLedger, customers, invoices, products, type QuoteLine, quotes, registers, saleLines, sales, taxRules, tenants, users, variants, variantUnits,
} from '@/db/schema';
import { asPlatform, withTenant } from '@/db/tenant';
import { formatReceiptNumber } from '@/device/sale';
import { calculateCartTotals } from '@/lib/cart-totals';
import { todayIn } from '@/lib/dates';
import { parseQuantity, toMilli } from '@/lib/decimal';
import { choosePriceList, resolvePrice } from '@/lib/pricing';
import { chooseTaxRule, effectiveRateBp } from '@/lib/tax';
import { consumeApproval } from './approvals';
import { writeAudit } from './audit';
import { assertPermission, type Ctx } from './context';
import { loadPriceRules } from './price-lists';
import { type Fail, fail, isUuid, itemLabel } from './products';
import { completeSaleTx, type SaleError, type SaleInput, saleFailure, throwSaleFailure } from './sales';

const lineSchema = z.object({ variantId: z.uuid(), unitId: z.uuid(), quantity: z.string(), discountPesewas: z.number().int().min(0).max(100_000_000).default(0) });
const myBranches = async (tx: Tx, ctx: Ctx) => (await tx.select({ branchIds: users.branchIds }).from(users).where(eq(users.id, ctx.userId)))[0]?.branchIds ?? [];
const newCode = () => randomBytes(16).toString('base64url');

async function hereBranch(tx: Tx, ctx: Ctx): Promise<string | null> {
  if (ctx.registerId) return (await tx.select({ branchId: registers.branchId }).from(registers).where(eq(registers.id, ctx.registerId)))[0]?.branchId ?? null;
  const mine = await myBranches(tx, ctx);
  return mine.length === 1 ? mine[0] : null;
}

type PriceInput = z.infer<typeof lineSchema>;
/** Spec 6.35: today's prices for the branch and customer (price lists, tax), as a sale would charge them. */
async function priceCart(tx: Tx, ctx: Ctx, branchId: string, customerId: string | null, input: PriceInput[], now: Date) {
  const [shop] = await tx.select({ taxMode: tenants.taxMode, taxEnabled: tenants.taxEnabled, timezone: tenants.timezone }).from(tenants).where(eq(tenants.id, ctx.tenantId));
  const [customer] = customerId ? await tx.select({ priceListId: customers.priceListId }).from(customers).where(eq(customers.id, customerId)) : [];
  const list = choosePriceList(await loadPriceRules(tx), { cartListId: null, customerListId: customer?.priceListId ?? null, branchId, today: todayIn(shop.timezone, now) });
  const rules = await tx.select().from(taxRules).where(eq(taxRules.active, true));
  const priced = [];
  for (const l of input) {
    const quantity = parseQuantity(l.quantity);
    if (!quantity || toMilli(quantity) <= 0n) return null;
    const [item] = await tx.select({
      unitPrice: variantUnits.pricePesewas, factor: variantUnits.factor, unitName: variantUnits.name, sellable: variantUnits.sellable, basePrice: variants.basePricePesewas,
      kind: variants.kind, taxRuleId: products.taxRuleId, productName: products.name, variantName: variants.name, byAmount: variants.sellByAmount,
    }).from(variantUnits).innerJoin(variants, eq(variants.id, variantUnits.variantId)).innerJoin(products, eq(products.id, variants.productId))
      .where(and(eq(variantUnits.id, l.unitId), eq(variantUnits.variantId, l.variantId)));
    if (!item || !item.sellable || item.kind === 'combo' || item.byAmount) return null; // shortcut: combos and sell-by-amount items are not quoted
    const rule = chooseTaxRule(shop.taxEnabled, item.taxRuleId, rules);
    priced.push({
      variantId: l.variantId, unitId: l.unitId, name: itemLabel(item.productName, item.variantName), unitName: item.unitName, quantity,
      unitPricePesewas: resolvePrice(list, { unitId: l.unitId, quantity, unitPricePesewas: item.unitPrice, unitFactor: item.factor, basePricePesewas: item.basePrice }),
      discountPesewas: l.discountPesewas, labelPricePesewas: null, taxRateBp: rule ? effectiveRateBp(rule) : 0,
    });
  }
  const totals = calculateCartTotals(priced, { taxMode: shop.taxMode });
  const lines: QuoteLine[] = priced.map((p, i) => ({
    variantId: p.variantId, unitId: p.unitId, name: p.name, unitName: p.unitName, quantity: p.quantity, unitPricePesewas: p.unitPricePesewas,
    discountPesewas: totals.lines[i].discountPesewas, taxRateBp: p.taxRateBp, totalPesewas: totals.lines[i].totalPesewas,
  }));
  return { lines, subtotalPesewas: totals.subtotalPesewas, discountPesewas: totals.discountPesewas, taxPesewas: totals.taxPesewas, totalPesewas: totals.totalPesewas };
}

/** The next number in a per-shop series (Q-0001, INV-0001); the tenant row is locked so two never share one. */
async function nextNumber(tx: Tx, ctx: Ctx, prefix: 'Q' | 'INV') {
  await tx.select({ id: tenants.id }).from(tenants).where(eq(tenants.id, ctx.tenantId)).for('update');
  const rows = prefix === 'Q' ? await tx.select({ n: quotes.number }).from(quotes) : await tx.select({ n: invoices.number }).from(invoices);
  const max = rows.reduce((m, r) => Math.max(m, Number(r.n.split('-')[1]) || 0), 0);
  return `${prefix}-${String(max + 1).padStart(4, '0')}`;
}

type QuoteError = 'invalid_input' | 'no_branch' | 'unknown_customer' | 'unknown_item' | 'discount_not_allowed';

/** Spec 6.35: saves an itemised quote at today's prices, valid for some days, with a link to share. */
export async function createQuote(db: Db, ctx: Ctx, input: { customerId?: string; lines: PriceInput[]; validDays: number; note?: string }, now: Date): Promise<
  { ok: true; quoteId: string; number: string; shareCode: string; totalPesewas: number } | Fail<QuoteError>
> {
  assertPermission(ctx, 'make_sale');
  const parsed = z.array(lineSchema).min(1).max(100).safeParse(input.lines);
  const days = input.validDays;
  const note = typeof input.note === 'string' && input.note.trim() ? input.note.trim().slice(0, 300) : null;
  if (!parsed.success || !Number.isInteger(days) || days < 1 || days > 90 || (input.customerId && !isUuid(input.customerId))) return fail('invalid_input');
  if (parsed.data.some((l) => l.discountPesewas > 0) && !ctx.permissions.includes('give_discount')) return fail('discount_not_allowed');
  return withTenant(db, ctx.tenantId, async (tx) => {
    const branchId = await hereBranch(tx, ctx);
    if (!branchId) return fail('no_branch');
    if (input.customerId && !(await tx.select({ id: customers.id }).from(customers).where(eq(customers.id, input.customerId))).length) return fail('unknown_customer');
    const priced = await priceCart(tx, ctx, branchId, input.customerId ?? null, parsed.data, now);
    if (!priced) return fail('unknown_item');
    const [shop] = await tx.select({ timezone: tenants.timezone }).from(tenants).where(eq(tenants.id, ctx.tenantId));
    const validUntil = new Date(Date.parse(`${todayIn(shop.timezone, now)}T00:00:00Z`) + days * 86_400_000).toISOString().slice(0, 10);
    const number = await nextNumber(tx, ctx, 'Q');
    const shareCode = newCode();
    const [q] = await tx.insert(quotes).values({
      tenantId: ctx.tenantId, branchId, number, customerId: input.customerId ?? null, ...priced, validUntil, note, shareCode, createdBy: ctx.userId, createdAt: now,
    }).returning({ id: quotes.id });
    await writeAudit(tx, { tenantId: ctx.tenantId, actorType: 'user', actorId: ctx.userId, action: 'quote_created', recordType: 'quote', recordId: q.id, changes: { number, totalPesewas: priced.totalPesewas } });
    return { ok: true as const, quoteId: q.id, number, shareCode, totalPesewas: priced.totalPesewas };
  });
}

export type QuoteRow = typeof quotes.$inferSelect & { customerName: string | null };

export async function listQuotes(db: Db, ctx: Ctx): Promise<QuoteRow[]> {
  assertPermission(ctx, 'make_sale');
  return withTenant(db, ctx.tenantId, async (tx) => (await tx.select({ q: quotes, customerName: customers.name }).from(quotes)
    .leftJoin(customers, eq(customers.id, quotes.customerId)).orderBy(desc(quotes.createdAt)).limit(200)).map((r) => ({ ...r.q, customerName: r.customerName })));
}

export async function getQuote(db: Db, ctx: Ctx, quoteId: string): Promise<QuoteRow | null> {
  assertPermission(ctx, 'make_sale');
  if (!isUuid(quoteId)) return null;
  return withTenant(db, ctx.tenantId, async (tx) => {
    const [r] = await tx.select({ q: quotes, customerName: customers.name }).from(quotes).leftJoin(customers, eq(customers.id, quotes.customerId)).where(eq(quotes.id, quoteId));
    return r ? { ...r.q, customerName: r.customerName } : null;
  });
}

export async function cancelQuote(db: Db, ctx: Ctx, quoteId: string): Promise<{ ok: true } | Fail<'not_open'>> {
  assertPermission(ctx, 'make_sale');
  if (!isUuid(quoteId)) return fail('not_open');
  return withTenant(db, ctx.tenantId, async (tx) => {
    const [q] = await tx.update(quotes).set({ status: 'cancelled' }).where(and(eq(quotes.id, quoteId), eq(quotes.status, 'open'))).returning({ id: quotes.id });
    if (!q) return fail('not_open');
    await writeAudit(tx, { tenantId: ctx.tenantId, actorType: 'user', actorId: ctx.userId, action: 'quote_cancelled', recordType: 'quote', recordId: q.id });
    return { ok: true as const };
  });
}

type ConvertError = SaleError | 'not_open' | 'approval_required' | 'invoice_needs_customer' | 'invalid_due_date' | 'unknown_item';
class Refused extends Error {
  constructor(readonly code: ConvertError) { super(code); }
}

type TillResult = { saleId: string; changeDuePesewas: number; extra?: Record<string, string> };
/** Runs a server-numbered sale at a till (retrying once if another sale took the receipt number). */
async function tillSale(db: Db, ctx: Ctx, body: (tx: Tx, saleId: string, receiptNumber: string) => Promise<TillResult>): Promise<({ ok: true } & TillResult) | Fail<ConvertError>> {
  if (!ctx.registerId) return fail('no_register');
  const registerId = ctx.registerId;
  const saleId = randomUUID();
  for (let attempt = 0; ; attempt++) {
    try {
      const done = await withTenant(db, ctx.tenantId, async (tx) => {
        const [reg] = await tx.select({ counter: registers.receiptCounter, registerCode: registers.registerCode, branchCode: branches.branchCode })
          .from(registers).innerJoin(branches, eq(branches.id, registers.branchId)).where(eq(registers.id, registerId));
        if (!reg) throw new Refused('no_register');
        return body(tx, saleId, formatReceiptNumber(reg.branchCode, reg.registerCode, Number(reg.counter) + 1 + attempt));
      });
      return { ok: true, ...done };
    } catch (e) {
      if (e instanceof Refused) return fail(e.code);
      const f = saleFailure(e);
      if (f.error !== 'duplicate_receipt_number' || attempt === 1) return f;
    }
  }
}

async function openQuote(tx: Tx, ctx: Ctx, quoteId: string, approvalToken: string | undefined, now: Date) {
  const [q] = await tx.select().from(quotes).where(eq(quotes.id, quoteId)).for('update');
  if (!q || q.status !== 'open') throw new Refused('not_open');
  const [shop] = await tx.select({ timezone: tenants.timezone }).from(tenants).where(eq(tenants.id, ctx.tenantId));
  if (q.validUntil < todayIn(shop.timezone, now)) { // spec 6.35: honouring an expired quote's prices needs a manager
    const ok = ctx.permissions.includes('approve_actions')
      || await consumeApproval(tx, ctx, { token: approvalToken ?? '', action: 'honour_expired_quote', contextKey: quoteId }, now);
    if (!ok) throw new Refused('approval_required');
  }
  return q;
}

const asSaleLines = (lines: QuoteLine[]): SaleInput['lines'] =>
  lines.map((l) => ({ variantId: l.variantId, unitId: l.unitId, quantity: l.quantity, unitPricePesewas: l.unitPricePesewas, discountPesewas: l.discountPesewas }));

/** Spec 6.35: sells the quote at its prices (at a till); the quote counts as the price approval. */
export async function convertQuoteToSale(db: Db, ctx: Ctx, input: { quoteId: string; tenders: SaleInput['tenders']; approvalToken?: string }, now: Date): Promise<
  { ok: true; saleId: string; changeDuePesewas: number } | Fail<ConvertError>
> {
  assertPermission(ctx, 'make_sale');
  if (!isUuid(input.quoteId) || !Array.isArray(input.tenders)) return fail('invalid_input');
  const r = await tillSale(db, ctx, async (tx, saleId, receiptNumber) => {
    const q = await openQuote(tx, ctx, input.quoteId, input.approvalToken, now);
    const sold = await completeSaleTx(tx, ctx, {
      saleId, receiptNumber, deviceCreatedAt: now.toISOString(), tenders: input.tenders, customerId: q.customerId ?? undefined, lines: asSaleLines(q.lines),
    }, now, { quotedPrices: true });
    if (!sold.ok) throwSaleFailure(sold);
    await tx.update(quotes).set({ status: 'converted', convertedSaleId: saleId }).where(eq(quotes.id, q.id));
    return { saleId, changeDuePesewas: sold.changeDuePesewas };
  });
  return r.ok ? { ok: true, saleId: r.saleId, changeDuePesewas: r.changeDuePesewas } : r;
}

/** Spec 6.35: an invoice is a credit sale to a named business customer, due by a date, from a quote or from items priced today. */
export async function createInvoice(db: Db, ctx: Ctx, input: {
  customerId: string; dueDate: string; quoteId?: string; lines?: PriceInput[]; approvalToken?: string; creditApprovalToken?: string;
}, now: Date): Promise<{ ok: true; invoiceId: string; number: string; saleId: string; shareCode: string } | Fail<ConvertError>> {
  assertPermission(ctx, 'issue_invoices');
  if (!isUuid(input.customerId)) return fail('invoice_needs_customer');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(input.dueDate)) return fail('invalid_due_date');
  const parsedLines = input.quoteId ? null : z.array(lineSchema).min(1).max(100).safeParse(input.lines);
  if (!input.quoteId && !parsedLines?.success) return fail('invalid_input');
  const r = await tillSale(db, ctx, async (tx, saleId, receiptNumber) => {
    const [customer] = await tx.select({ id: customers.id }).from(customers).where(eq(customers.id, input.customerId));
    if (!customer) throw new Refused('invoice_needs_customer');
    const q = input.quoteId ? await openQuote(tx, ctx, input.quoteId, input.approvalToken, now) : null;
    const branchId = (await tx.select({ branchId: registers.branchId }).from(registers).where(eq(registers.id, ctx.registerId!)))[0].branchId;
    const priced = q ? { lines: q.lines, totalPesewas: q.totalPesewas } : await priceCart(tx, ctx, branchId, customer.id, parsedLines!.data!, now);
    if (!priced) throw new Refused('unknown_item');
    const sold = await completeSaleTx(tx, ctx, {
      saleId, receiptNumber, deviceCreatedAt: now.toISOString(), customerId: customer.id, lines: asSaleLines(priced.lines), creditApprovalToken: input.creditApprovalToken,
      tenders: [{ id: randomUUID(), method: 'credit', amountPesewas: priced.totalPesewas }],
    }, now, { quotedPrices: true });
    if (!sold.ok) throwSaleFailure(sold);
    if (q) await tx.update(quotes).set({ status: 'converted', convertedSaleId: saleId }).where(eq(quotes.id, q.id));
    const number = await nextNumber(tx, ctx, 'INV');
    const shareCode = newCode();
    const [inv] = await tx.insert(invoices).values({
      tenantId: ctx.tenantId, number, saleId, customerId: customer.id, quoteId: q?.id ?? null, dueDate: input.dueDate, shareCode, createdBy: ctx.userId, createdAt: now,
    }).returning({ id: invoices.id });
    await writeAudit(tx, { tenantId: ctx.tenantId, actorType: 'user', actorId: ctx.userId, action: 'invoice_issued', recordType: 'invoice', recordId: inv.id, changes: { number, saleId, totalPesewas: priced.totalPesewas } });
    return { saleId, changeDuePesewas: 0, extra: { invoiceId: inv.id, number, shareCode } };
  });
  if (!r.ok) return r;
  return { ok: true, invoiceId: r.extra!.invoiceId, number: r.extra!.number, saleId: r.saleId, shareCode: r.extra!.shareCode };
}

export type InvoiceRow = {
  invoiceId: string; number: string; saleId: string; customerId: string; customerName: string; dueDate: string; totalPesewas: number; owedPesewas: number;
  status: 'paid' | 'due' | 'overdue'; shareCode: string; createdAt: Date;
};

/** What is still owed on each credit sale of these customers: payments, returns, and reductions settle the oldest first. */
async function owedBySale(tx: Tx, customerIds: string[]): Promise<Map<string, number>> {
  const owed = new Map<string, number>();
  if (!customerIds.length) return owed;
  const entries = await tx.select({ customerId: customerLedger.customerId, saleId: customerLedger.saleId, amount: customerLedger.amountPesewas }).from(customerLedger)
    .where(inArray(customerLedger.customerId, customerIds)).orderBy(asc(customerLedger.createdAt), asc(customerLedger.id));
  for (const id of customerIds) {
    const mine = entries.filter((e) => e.customerId === id);
    let credits = mine.filter((e) => e.amount < 0).reduce((s, e) => s - e.amount, 0);
    for (const e of mine.filter((x) => x.amount > 0)) {
      const covered = Math.min(credits, e.amount);
      credits -= covered;
      if (e.saleId) owed.set(e.saleId, (owed.get(e.saleId) ?? 0) + e.amount - covered);
    }
  }
  return owed;
}

/** Spec 4.22: invoices, newest first, with what is still owed and whether they are overdue. */
export async function listInvoices(db: Db, ctx: Ctx, now: Date): Promise<InvoiceRow[]> {
  assertPermission(ctx, 'issue_invoices');
  return withTenant(db, ctx.tenantId, async (tx) => {
    const rows = await tx.select({ i: invoices, customerName: customers.name, total: sales.totalPesewas }).from(invoices)
      .innerJoin(customers, eq(customers.id, invoices.customerId)).innerJoin(sales, eq(sales.id, invoices.saleId)).orderBy(desc(invoices.createdAt)).limit(300);
    const owed = await owedBySale(tx, [...new Set(rows.map((r) => r.i.customerId))]);
    const [shop] = await tx.select({ timezone: tenants.timezone }).from(tenants).where(eq(tenants.id, ctx.tenantId));
    const today = todayIn(shop.timezone, now);
    return rows.map((r) => {
      const left = owed.get(r.i.saleId) ?? 0;
      return {
        invoiceId: r.i.id, number: r.i.number, saleId: r.i.saleId, customerId: r.i.customerId, customerName: r.customerName, dueDate: r.i.dueDate, totalPesewas: r.total,
        owedPesewas: left, status: left <= 0 ? 'paid' as const : r.i.dueDate < today ? 'overdue' as const : 'due' as const, shareCode: r.i.shareCode, createdAt: r.i.createdAt,
      };
    });
  });
}

export type ShareDoc = {
  kind: 'quote' | 'invoice'; number: string; shopName: string; shopPhone: string | null; date: string; validUntil: string | null; dueDate: string | null;
  customer: { name: string; phone: string; address: string | null; tin: string | null } | null; taxNumber: string | null;
  lines: Array<{ name: string; unitName: string; quantity: string; unitPricePesewas: number; discountPesewas: number; totalPesewas: number }>;
  subtotalPesewas: number; discountPesewas: number; taxPesewas: number; totalPesewas: number; owedPesewas: number | null; note: string | null; status: string;
};

/** The quote or invoice a customer opens from a shared link (no sign-in). */
export async function getSharedDoc(db: Db, slug: string, code: string): Promise<ShareDoc | null> {
  if (typeof code !== 'string' || code.length < 10 || code.length > 40) return null;
  const [shop] = await asPlatform(db, (tx) => tx.select({ id: tenants.id, status: tenants.status }).from(tenants).where(eq(tenants.slug, slug)));
  if (!shop || shop.status !== 'active') return null;
  return withTenant(db, shop.id, async (tx) => {
    const [t] = await tx.select({ name: tenants.name, phone: tenants.phone, taxNumber: tenants.taxNumber }).from(tenants).where(eq(tenants.id, shop.id));
    const who = async (id: string | null) => (id ? (await tx.select({ name: customers.name, phone: customers.phone, address: customers.address, tin: customers.tin })
      .from(customers).where(eq(customers.id, id)))[0] ?? null : null);
    const [q] = await tx.select().from(quotes).where(eq(quotes.shareCode, code));
    if (q) {
      return {
        kind: 'quote' as const, number: q.number, shopName: t.name, shopPhone: t.phone, taxNumber: t.taxNumber, date: q.createdAt.toISOString().slice(0, 10), validUntil: q.validUntil,
        dueDate: null, customer: await who(q.customerId), lines: q.lines, subtotalPesewas: q.subtotalPesewas, discountPesewas: q.discountPesewas, taxPesewas: q.taxPesewas,
        totalPesewas: q.totalPesewas, owedPesewas: null, note: q.note, status: q.status,
      };
    }
    const [inv] = await tx.select({ i: invoices, s: sales }).from(invoices).innerJoin(sales, eq(sales.id, invoices.saleId)).where(eq(invoices.shareCode, code));
    if (!inv) return null;
    const lines = await tx.select({
      name: saleLines.name, unitName: saleLines.unitName, quantity: saleLines.quantity, unitPricePesewas: saleLines.unitPricePesewas,
      discountPesewas: saleLines.discountPesewas, totalPesewas: saleLines.totalPesewas,
    }).from(saleLines).where(eq(saleLines.saleId, inv.s.id)).orderBy(asc(saleLines.lineNo));
    const owed = (await owedBySale(tx, [inv.i.customerId])).get(inv.s.id) ?? 0;
    return {
      kind: 'invoice' as const, number: inv.i.number, shopName: t.name, shopPhone: t.phone, taxNumber: t.taxNumber, date: inv.i.createdAt.toISOString().slice(0, 10), validUntil: null,
      dueDate: inv.i.dueDate, customer: await who(inv.i.customerId), lines, subtotalPesewas: inv.s.subtotalPesewas, discountPesewas: inv.s.discountPesewas, taxPesewas: inv.s.taxPesewas,
      totalPesewas: inv.s.totalPesewas, owedPesewas: owed, note: null, status: owed <= 0 ? 'paid' : 'due',
    };
  });
}

/** Spec 4.22: a business customer's address and TIN for invoices. */
export async function saveBusinessDetails(db: Db, ctx: Ctx, input: { customerId: string; address: string; tin: string }): Promise<{ ok: true } | Fail<'invalid_input' | 'not_found'>> {
  assertPermission(ctx, 'issue_invoices');
  const address = typeof input.address === 'string' && input.address.trim() ? input.address.trim() : null;
  const tin = typeof input.tin === 'string' && input.tin.trim() ? input.tin.trim().toUpperCase() : null;
  if (!isUuid(input.customerId) || (address?.length ?? 0) > 200 || (tin?.length ?? 0) > 30) return fail('invalid_input');
  return withTenant(db, ctx.tenantId, async (tx) => {
    const [c] = await tx.update(customers).set({ address, tin }).where(eq(customers.id, input.customerId)).returning({ id: customers.id });
    return c ? { ok: true as const } : fail('not_found');
  });
}

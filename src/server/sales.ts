import 'server-only';
import { randomBytes } from 'node:crypto';
import { and, asc, count, desc, eq, inArray, sql } from 'drizzle-orm';
import { z } from 'zod';
import type { Db, Tx } from '@/db/client';
import {
  branches, components, customers, payments, products, registers, sales, saleLines, taxRules, TENDER_METHODS, type TenderMethod, tenants, users,
  variants, variantUnits,
} from '@/db/schema';
import { withTenant } from '@/db/tenant';
import { calculateCartTotals } from '@/lib/cart-totals';
import { businessDate, todayIn } from '@/lib/dates';
import { multiplyQty, parseQuantity, toMilli, validSaleQuantity } from '@/lib/decimal';
import { pesewasTimesQty } from '@/lib/money';
import type { Permission } from '@/lib/permissions';
import { choosePriceList, resolvePrice } from '@/lib/pricing';
import { parseReceiptNumber } from '@/lib/receipt';
import { chooseTaxRule, effectiveRateBp } from '@/lib/tax';
import { writeAudit } from './audit';
import { assertPermission, type Ctx } from './context';
import { redeemStoreCredit } from './customers';
import { loadPriceRules } from './price-lists';
import { type Fail, fail, isUuid, itemLabel } from './products';
import { type DeductProblems, deductStockForLine } from './stock';

export type { TenderMethod };
export type SaleInput = {
  saleId: string; receiptNumber: string;
  lines: Array<{ variantId: string; unitId: string; quantity: string; unitPricePesewas: number; discountPesewas: number; serials?: string[] }>;
  tenders: Array<{ id: string; method: TenderMethod; amountPesewas: number; reference?: string }>;
  customerId?: string; cashierId?: string; deviceCreatedAt: string; fromOfflineOutbox?: boolean;
};
export type SaleError = 'invalid_input' | 'no_register' | 'not_assigned' | 'cashier_not_allowed' | 'wrong_receipt_prefix' | 'duplicate_receipt_number'
  | 'sale_id_taken' | 'duplicate_tender_id' | 'unknown_item' | 'item_unavailable' | 'not_sellable' | 'invalid_quantity' | 'empty_bundle'
  | 'price_changed' | 'discount_not_allowed' | 'discount_too_large' | 'serials_required' | 'unknown_serial' | 'not_enough_stock'
  | 'only_expired_stock' | 'reference_required' | 'reduce_non_cash_amount' | 'payment_incomplete' | 'unknown_customer'
  | 'store_credit_needs_customer' | 'insufficient_store_credit';
export type SaleResult = { ok: true; saleId: string; status: 'completed' | 'pending'; changeDuePesewas: number; alreadyExisted: boolean } | { ok: false; error: SaleError };

const pesewas = z.number().int().min(0).max(2_000_000_000);
const inputSchema = z.object({
  saleId: z.uuid(),
  receiptNumber: z.string(),
  lines: z.array(z.object({
    variantId: z.uuid(), unitId: z.uuid(), quantity: z.string(), unitPricePesewas: pesewas, discountPesewas: pesewas,
    serials: z.array(z.string().trim().min(1).max(64)).max(1000).optional(),
  })).min(1).max(200),
  tenders: z.array(z.object({
    id: z.uuid(), method: z.enum(TENDER_METHODS as [TenderMethod, ...TenderMethod[]]), amountPesewas: pesewas.min(1),
    reference: z.string().trim().max(100).optional(),
  })).max(10),
  customerId: z.uuid().optional(),
  cashierId: z.uuid().optional(),
  deviceCreatedAt: z.iso.datetime({ offset: true }),
  fromOfflineOutbox: z.boolean().optional(),
});

const NEEDS_REFERENCE: readonly TenderMethod[] = ['momo_manual', 'card_terminal', 'bank_transfer'];

/** A refusal found after the first write: thrown so the whole transaction rolls back. */
class SaleRefused extends Error {
  constructor(readonly code: SaleError) {
    super(code);
  }
}
const refuse = (code: SaleError): never => { throw new SaleRefused(code); };

/** Spec 6.8, 6.9, and the server side of 6.10. Idempotent by saleId; stock goes down exactly once. */
export async function completeSale(db: Db, ctx: Ctx, input: SaleInput, now: Date): Promise<SaleResult> {
  assertPermission(ctx, 'make_sale');
  const parsed = inputSchema.safeParse(input);
  if (!parsed.success) return { ok: false, error: 'invalid_input' };
  const s = parsed.data;
  const quantities = s.lines.map((l) => parseQuantity(l.quantity));
  const receipt = parseReceiptNumber(s.receiptNumber);
  if (quantities.some((q) => q === null) || !receipt || new Set(s.tenders.map((t) => t.id)).size !== s.tenders.length) {
    return { ok: false, error: 'invalid_input' };
  }
  if (!ctx.registerId) return { ok: false, error: 'no_register' };
  const registerId = ctx.registerId;
  const outbox = s.fromOfflineOutbox === true;

  try {
    return await withTenant(db, ctx.tenantId, async (tx): Promise<SaleResult> => {
      // one till's sales run one at a time, so its receipt numbers and repeats are checked without races
      const [reg] = await tx.select({ id: registers.id, status: registers.status, branchId: registers.branchId, registerCode: registers.registerCode, branchCode: branches.branchCode })
        .from(registers).innerJoin(branches, eq(branches.id, registers.branchId)).where(eq(registers.id, registerId)).for('update', { of: registers });
      if (!reg || reg.status !== 'active') return refuse('no_register');

      const existing = await findSale(tx, s.saleId);
      if (existing) return repeat(tx, ctx.tenantId, existing, now);
      if (receipt.branchCode !== reg.branchCode || receipt.registerCode !== reg.registerCode) return refuse('wrong_receipt_prefix');

      const people = await tx.select({ id: users.id, status: users.status, permissions: users.permissions, branchIds: users.branchIds }).from(users)
        .where(inArray(users.id, [ctx.userId, ...(s.cashierId ? [s.cashierId] : [])]));
      const me = people.find((u) => u.id === ctx.userId);
      if (!me || !me.branchIds.includes(reg.branchId)) return refuse('not_assigned');
      const reasons = new Set<string>();
      let cashierId = ctx.userId;
      let cashierPermissions: readonly string[] = ctx.permissions;
      if (s.cashierId && s.cashierId !== ctx.userId) {
        // an outbox may sync one cashier's sale under a later session (6.10); the recorded cashier must still be allowed to sell here
        const c = people.find((u) => u.id === s.cashierId);
        if (!outbox || !c || c.status !== 'active' || !c.permissions.includes('make_sale') || !c.branchIds.includes(reg.branchId)) return refuse('cashier_not_allowed');
        cashierId = c.id;
        reasons.add('cashier_override'); // the sale is recorded under someone other than the signed-in user
        cashierPermissions = c.permissions as Permission[];
      }

      const [taken] = await tx.select({ id: sales.id }).from(sales).where(eq(sales.receiptNumber, s.receiptNumber));
      if (taken) return refuse('duplicate_receipt_number');
      if (s.tenders.length) {
        const [used] = await tx.select({ id: payments.id }).from(payments).where(inArray(payments.id, s.tenders.map((t) => t.id))).limit(1);
        if (used) return refuse('duplicate_tender_id');
      }
      const [customer] = s.customerId ? await tx.select({ id: customers.id, priceListId: customers.priceListId }).from(customers).where(eq(customers.id, s.customerId)) : [];
      if (s.customerId && !customer) return refuse('unknown_customer');

      const [shop] = await tx.select({
        taxMode: tenants.taxMode, taxEnabled: tenants.taxEnabled, allowNegativeStock: tenants.allowNegativeStock, timezone: tenants.timezone, cutoff: tenants.businessDayCutoff,
      }).from(tenants).where(eq(tenants.id, ctx.tenantId));
      const today = todayIn(shop.timezone, now);
      const rules = await tx.select().from(taxRules).where(eq(taxRules.active, true));
      const list = choosePriceList(await loadPriceRules(tx), { cartListId: null, customerListId: customer?.priceListId ?? null, branchId: reg.branchId, today });
      const lenient = (code: SaleError, reason: string) => (outbox ? reasons.add(reason) : refuse(code));

      const priced = [];
      for (const [i, l] of s.lines.entries()) {
        const quantity = quantities[i]!;
        const [item] = await tx.select({
          unitName: variantUnits.name, factor: variantUnits.factor, isBase: variantUnits.isBase, unitSellable: variantUnits.sellable, unitPrice: variantUnits.pricePesewas,
          kind: variants.kind, variantName: variants.name, allowsFractions: variants.allowsFractions, basePrice: variants.basePricePesewas,
          sellable: variants.sellable, variantStatus: variants.status, productName: products.name, productStatus: products.status,
          taxRuleId: products.taxRuleId, tracking: products.tracking,
        }).from(variantUnits)
          .innerJoin(variants, eq(variants.id, variantUnits.variantId))
          .innerJoin(products, eq(products.id, variants.productId))
          .where(and(eq(variantUnits.id, l.unitId), eq(variantUnits.variantId, l.variantId)));
        if (!item) return refuse('unknown_item');
        if (item.productStatus === 'archived' || item.variantStatus === 'archived') lenient('item_unavailable', 'item_archived');
        if (!item.sellable || !item.unitSellable) return refuse('not_sellable');
        if (!validSaleQuantity(quantity, item.isBase && item.allowsFractions)) return refuse('invalid_quantity');
        if (item.kind !== 'standard') {
          const [{ n }] = await tx.select({ n: count() }).from(components).where(eq(components.parentVariantId, l.variantId));
          if (n === 0) return refuse('empty_bundle');
        }
        const currentPrice = resolvePrice(list, { unitId: l.unitId, quantity, unitPricePesewas: item.unitPrice, unitFactor: item.factor, basePricePesewas: item.basePrice });
        if (currentPrice !== l.unitPricePesewas) lenient('price_changed', 'price_changed'); // an outbox sale keeps the price the customer paid
        const gross = pesewasTimesQty(l.unitPricePesewas, quantity);
        // both the signed-in user and the recorded cashier must hold it: a client-supplied cashier never lends a permission
        if (l.discountPesewas > 0 && !(ctx.permissions.includes('give_discount') && cashierPermissions.includes('give_discount'))) return refuse('discount_not_allowed');
        if (l.discountPesewas > gross) return refuse('discount_too_large');
        const baseQty = multiplyQty(quantity, item.factor);
        const lineSerials = l.serials ?? [];
        if (item.tracking === 'serial' && toMilli(baseQty) !== BigInt(lineSerials.length) * 1000n) lenient('serials_required', 'serials_missing');
        const rule = chooseTaxRule(shop.taxEnabled, item.taxRuleId, rules);
        priced.push({ ...l, quantity, baseQty, serials: lineSerials, currentPrice, name: itemLabel(item.productName, item.variantName), unitName: item.unitName, taxRateBp: rule ? effectiveRateBp(rule) : 0 });
      }

      const totals = calculateCartTotals(priced, { taxMode: shop.taxMode });
      if (s.tenders.some((t) => NEEDS_REFERENCE.includes(t.method) && !t.reference)) return refuse('reference_required');
      const nonCash = s.tenders.filter((t) => t.method !== 'cash').reduce((a, t) => a + t.amountPesewas, 0);
      if (nonCash > totals.totalPesewas) return refuse('reduce_non_cash_amount'); // only cash can produce change
      if (s.tenders.some((t) => t.method === 'store_credit') && !customer) return refuse('store_credit_needs_customer');
      const paid = s.tenders.reduce((a, t) => a + t.amountPesewas, 0);
      if (paid < totals.totalPesewas) lenient('payment_incomplete', 'underpaid');
      const changeDue = Math.max(0, paid - totals.totalPesewas);
      const deviceAt = new Date(s.deviceCreatedAt);
      const happenedAt = deviceAt.getTime() > now.getTime() ? now : deviceAt; // a device clock ahead of ours never moves a sale into the future

      const [saved] = await tx.insert(sales).values({
        id: s.saleId, tenantId: ctx.tenantId, branchId: reg.branchId, registerId: reg.id, cashierId, customerId: customer?.id ?? null,
        receiptNumber: s.receiptNumber, status: 'pending', taxMode: shop.taxMode, subtotalPesewas: totals.subtotalPesewas,
        discountPesewas: totals.discountPesewas, taxPesewas: totals.taxPesewas, totalPesewas: totals.totalPesewas, paidPesewas: paid,
        changeDuePesewas: changeDue, fromOffline: outbox, deviceCreatedAt: deviceAt, receivedAt: now,
        businessDate: businessDate(shop.timezone, shop.cutoff, happenedAt), shareCode: randomBytes(16).toString('base64url'),
      }).onConflictDoNothing({ target: sales.id }).returning({ id: sales.id });
      if (!saved) {
        const again = await findSale(tx, s.saleId); // row-level security hides another shop's sale with this id
        return again ? repeat(tx, ctx.tenantId, again, now) : refuse('sale_id_taken');
      }
      await tx.insert(saleLines).values(priced.map((l, i) => ({
        tenantId: ctx.tenantId, saleId: s.saleId, lineNo: i + 1, variantId: l.variantId, unitId: l.unitId, name: l.name, unitName: l.unitName,
        quantity: l.quantity, baseQuantity: l.baseQty, unitPricePesewas: l.unitPricePesewas, currentPricePesewas: l.currentPrice,
        discountPesewas: totals.lines[i].discountPesewas, grossPesewas: totals.lines[i].grossPesewas, taxRateBp: l.taxRateBp,
        taxPesewas: totals.lines[i].taxPesewas, totalPesewas: totals.lines[i].totalPesewas, serials: l.serials,
      })));
      for (const t of s.tenders) {
        if (t.method === 'store_credit' && !(await redeemStoreCredit(tx, { tenantId: ctx.tenantId, customerId: customer!.id, amountPesewas: t.amountPesewas, saleId: s.saleId, userId: ctx.userId }))) {
          refuse('insufficient_store_credit');
        }
        const [paidRow] = await tx.insert(payments).values({
          id: t.id, tenantId: ctx.tenantId, saleId: s.saleId, method: t.method, amountPesewas: t.amountPesewas, reference: t.reference || null,
          status: 'confirmed', confirmedBy: t.method === 'cash' ? null : ctx.userId, // manual payments: the cashier confirms the money arrived (4.3)
        }).onConflictDoNothing({ target: payments.id }).returning({ id: payments.id });
        if (!paidRow) refuse('duplicate_tender_id'); // tender ids are global; another shop's (hidden by row-level security) or a racing request
      }
      await tx.update(registers).set({ receiptCounter: sql`greatest(${registers.receiptCounter}, ${receipt.counter})` }).where(eq(registers.id, reg.id));

      const done = await finaliseSaleTx(tx, ctx.tenantId, s.saleId, now);
      if (done.problems.onlyExpired) lenient('only_expired_stock', 'only_expired_stock');
      if (done.problems.serialsMissing) lenient('unknown_serial', 'serials_missing');
      if (done.problems.negative) {
        if (outbox) reasons.add('negative_stock');
        else if (!shop.allowNegativeStock) refuse('not_enough_stock');
      }
      if (reasons.size) await tx.update(sales).set({ needsReview: true, reviewReasons: [...reasons] }).where(eq(sales.id, s.saleId));
      return { ok: true, saleId: s.saleId, status: done.status, changeDuePesewas: changeDue, alreadyExisted: false };
    });
  } catch (e) {
    if (e instanceof SaleRefused) return { ok: false, error: e.code };
    throw e;
  }
}

type StoredSale = { id: string; status: 'pending' | 'completed'; changeDuePesewas: number };

async function findSale(tx: Tx, saleId: string): Promise<StoredSale | undefined> {
  const [row] = await tx.select({ id: sales.id, status: sales.status, changeDuePesewas: sales.changeDuePesewas }).from(sales).where(eq(sales.id, saleId));
  return row;
}

/** A repeated request changes nothing; a sale left pending is finalised again so a retry can heal it. */
async function repeat(tx: Tx, tenantId: string, sale: StoredSale, now: Date): Promise<SaleResult> {
  const status = sale.status === 'pending' ? (await finaliseSaleTx(tx, tenantId, sale.id, now)).status : sale.status;
  return { ok: true, saleId: sale.id, status, changeDuePesewas: sale.changeDuePesewas, alreadyExisted: true };
}

/** Spec 6.9: safe to call many times; only a fully paid pending sale is completed, and its stock goes down once. */
export async function finaliseSaleTx(tx: Tx, tenantId: string, saleId: string, now: Date): Promise<{ status: 'completed' | 'pending'; problems: DeductProblems }> {
  const problems: DeductProblems = { negative: false, onlyExpired: false, serialsMissing: false };
  const [sale] = await tx.select().from(sales).where(eq(sales.id, saleId)).for('update');
  if (!sale) throw new Error(`unknown sale ${saleId}`);
  if (sale.status === 'completed') return { status: 'completed', problems };
  const [{ paid }] = await tx.select({ paid: sql<number>`coalesce(sum(${payments.amountPesewas}), 0)::int` }).from(payments)
    .where(and(eq(payments.saleId, saleId), eq(payments.status, 'confirmed')));
  if (paid < sale.totalPesewas) return { status: 'pending', problems }; // pending sales never count and never reduce stock
  const [shop] = await tx.select({ timezone: tenants.timezone }).from(tenants).where(eq(tenants.id, tenantId));
  const today = todayIn(shop.timezone, now);
  const lines = await tx.select().from(saleLines).where(eq(saleLines.saleId, saleId)).orderBy(asc(saleLines.lineNo));
  for (const l of lines) {
    const p = await deductStockForLine(tx, { tenantId, branchId: sale.branchId, saleId, saleLineId: l.id, userId: sale.cashierId, today },
      { variantId: l.variantId, baseQty: l.baseQuantity, serials: l.serials });
    problems.negative ||= p.negative;
    problems.onlyExpired ||= p.onlyExpired;
    problems.serialsMissing ||= p.serialsMissing;
  }
  await tx.update(sales).set({ status: 'completed', completedAt: now }).where(eq(sales.id, saleId));
  await writeAudit(tx, {
    tenantId, actorType: 'user', actorId: sale.cashierId, action: 'sale_completed', recordType: 'sale', recordId: saleId,
    changes: { receiptNumber: sale.receiptNumber, totalPesewas: sale.totalPesewas },
  });
  return { status: 'completed', problems };
}

/** For a payment confirmed later (Phase 6 webhooks): completes a pending sale once it is fully paid. */
export async function finaliseSale(db: Db, ctx: Ctx, saleId: string, now: Date): Promise<{ ok: true; status: 'completed' | 'pending' } | Fail<'not_found'>> {
  assertPermission(ctx, 'make_sale');
  if (!isUuid(saleId)) return fail('not_found');
  return withTenant(db, ctx.tenantId, async (tx) => {
    if (!(await findSale(tx, saleId))) return fail('not_found');
    return { ok: true, status: (await finaliseSaleTx(tx, ctx.tenantId, saleId, now)).status } as const;
  });
}

export async function listRecentSales(db: Db, ctx: Ctx, opts: { limit?: number }): Promise<Array<{
  id: string; receiptNumber: string; totalPesewas: number; status: string; needsReview: boolean; createdAt: Date; cashierName: string;
}>> {
  assertPermission(ctx, 'view_dashboard');
  const limit = Math.min(Math.max(Math.trunc(opts.limit ?? 50), 1), 200);
  return withTenant(db, ctx.tenantId, (tx) => tx.select({
    id: sales.id, receiptNumber: sales.receiptNumber, totalPesewas: sales.totalPesewas, status: sales.status, needsReview: sales.needsReview,
    createdAt: sales.deviceCreatedAt, cashierName: users.name,
  }).from(sales).innerJoin(users, eq(users.id, sales.cashierId)).orderBy(desc(sales.receivedAt), desc(sales.id)).limit(limit));
}

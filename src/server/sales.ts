import 'server-only';
import { randomBytes } from 'node:crypto';
import { and, asc, count, desc, eq, inArray, sql } from 'drizzle-orm';
import { z } from 'zod';
import type { Db, Tx } from '@/db/client';
import {
  addOnGroups, addOnOptions, branches, branchOrderCounters, channelReceivables, comboChoices, comboSlots, components, customers, foodSettings, kitchenOrders, payments, products, registers, sales, saleLines,
  salesChannels, taxRules, variantAddOnGroups,
  TENDER_METHODS, type TenderMethod, tenants, users, variants, variantUnits,
} from '@/db/schema';
import { withTenant } from '@/db/tenant';
import { calculateCartTotals } from '@/lib/cart-totals';
import { businessDate, todayIn } from '@/lib/dates';
import { multiplyQty, parseQuantity, toMilli, validSaleQuantity } from '@/lib/decimal';
import {
  addOnTotal, checkAddOns, checkComboChoices, type ComboSlotDef, comboUpgradeTotal, commissionPesewas, DINING_OPTIONS, type DiningOption, formatOrderNumber, needsPacking, ORDER_NUMBER, packCount, phoneCustomer,
} from '@/lib/food';
import { pesewasTimesQty } from '@/lib/money';
import type { Permission } from '@/lib/permissions';
import { choosePriceList, resolvePrice } from '@/lib/pricing';
import { parseReceiptNumber } from '@/lib/receipt';
import { chooseTaxRule, effectiveRateBp } from '@/lib/tax';
import { writeAudit } from './audit';
import { assertPermission, type Ctx } from './context';
import { redeemStoreCredit } from './customers';
import { foodEnabled } from './food-settings';
import { loadPriceRules } from './price-lists';
import { type Fail, fail, isUuid, itemLabel } from './products';
import type { PendingLine, SaleLineAddOn, SaleLineChoice } from '@/db/schema';
import { isSoldOut } from './sold-out';
import { type DeductProblems, deductStockForLine } from './stock';

export type { TenderMethod };
export type SaleInput = {
  saleId: string; receiptNumber: string;
  lines: Array<{
    variantId: string; unitId: string; quantity: string; unitPricePesewas: number; discountPesewas: number; serials?: string[];
    byAmount?: boolean; choices?: Array<{ slotId: string; variantId: string }>;
    addOns?: Array<{ groupId: string; optionId: string }>; note?: string; // spec 4.24
  }>;
  tenders: Array<{ id: string; method: TenderMethod; amountPesewas: number; reference?: string }>;
  customerId?: string; cashierId?: string; deviceCreatedAt: string; fromOfflineOutbox?: boolean;
  food?: {
    serviceMode: 'counter' | 'quick'; diningOption: DiningOption; orderNumber?: string;
    channelId?: string; externalOrderId?: string; customer?: { name: string; phone: string }; pickupAt?: string; deliveryAddress?: string;
    kitchenOrderId?: string;
  };
};
export type SaleError = 'invalid_input' | 'no_register' | 'not_assigned' | 'cashier_not_allowed' | 'wrong_receipt_prefix' | 'duplicate_receipt_number'
  | 'sale_id_taken' | 'duplicate_tender_id' | 'unknown_item' | 'item_unavailable' | 'not_sellable' | 'invalid_quantity' | 'empty_bundle'
  | 'price_changed' | 'discount_not_allowed' | 'discount_too_large' | 'serials_required' | 'unknown_serial' | 'not_enough_stock'
  | 'only_expired_stock' | 'reference_required' | 'reduce_non_cash_amount' | 'payment_incomplete' | 'unknown_customer'
  | 'store_credit_needs_customer' | 'insufficient_store_credit' | 'sold_out' | 'pack_fee_mismatch' | 'service_mode_not_allowed' | 'invalid_order_number'
  | 'invalid_choices' | 'amount_required' | 'not_sold_by_amount' | 'below_minimum_amount'
  | 'unknown_channel' | 'channel_not_allowed' | 'external_order_id_required' | 'channel_order_exists' | 'channel_settlement_required'
  | 'invalid_tender' | 'customer_details_required' | 'dining_option_not_allowed' | 'order_changed' | 'order_not_open' | 'invalid_add_ons';
export type SaleResult = {
  ok: true; saleId: string; status: 'completed' | 'pending'; changeDuePesewas: number; alreadyExisted: boolean; orderNumber: string | null;
} | { ok: false; error: SaleError };

const pesewas = z.number().int().min(0).max(2_000_000_000);
const inputSchema = z.object({
  saleId: z.uuid(),
  receiptNumber: z.string(),
  lines: z.array(z.object({
    variantId: z.uuid(), unitId: z.uuid(), quantity: z.string(), unitPricePesewas: pesewas, discountPesewas: pesewas,
    serials: z.array(z.string().trim().min(1).max(64)).max(1000).optional(),
    byAmount: z.boolean().optional(),
    choices: z.array(z.object({ slotId: z.uuid(), variantId: z.uuid() })).max(20).optional(),
    addOns: z.array(z.object({ groupId: z.uuid(), optionId: z.uuid() })).max(30).optional(),
    note: z.string().trim().max(140).optional(),
  })).min(1).max(200),
  tenders: z.array(z.object({
    id: z.uuid(), method: z.enum(TENDER_METHODS as [TenderMethod, ...TenderMethod[]]), amountPesewas: pesewas.min(1),
    reference: z.string().trim().max(100).optional(),
  })).max(10),
  customerId: z.uuid().optional(),
  cashierId: z.uuid().optional(),
  deviceCreatedAt: z.iso.datetime({ offset: true }),
  fromOfflineOutbox: z.boolean().optional(),
  food: z.object({
    serviceMode: z.enum(['counter', 'quick']), diningOption: z.enum(DINING_OPTIONS), orderNumber: z.string().max(10).optional(),
    channelId: z.uuid().optional(), externalOrderId: z.string().max(100).optional(),
    customer: z.object({ name: z.string().max(100), phone: z.string().max(30) }).optional(),
    pickupAt: z.iso.datetime({ offset: true }).optional(), deliveryAddress: z.string().max(300).optional(), kitchenOrderId: z.uuid().optional(),
  }).optional(),
});

const NEEDS_REFERENCE: readonly TenderMethod[] = ['momo_manual', 'card_terminal', 'bank_transfer', 'channel_settlement'];

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
      const [reg] = await tx.select({
        id: registers.id, status: registers.status, branchId: registers.branchId, registerCode: registers.registerCode, branchCode: branches.branchCode,
        serviceModes: branches.serviceModes,
      }).from(registers).innerJoin(branches, eq(branches.id, registers.branchId)).where(eq(registers.id, registerId)).for('update', { of: registers });
      if (!reg || reg.status !== 'active') return refuse('no_register');
      // only this till's own offline numbers ('T1-047'); unprefixed numbers come from the server alone
      const deviceNumber = s.food?.orderNumber;
      const deviceNumberOk = deviceNumber === undefined || (ORDER_NUMBER.test(deviceNumber) && deviceNumber.startsWith(`${reg.registerCode}-`));

      const existing = await findSale(tx, s.saleId);
      if (existing) return repeat(tx, ctx, existing, deviceNumberOk ? deviceNumber : undefined, now);
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
      const deviceAt = new Date(s.deviceCreatedAt);
      const happenedAt = deviceAt.getTime() > now.getTime() ? now : deviceAt; // a device clock ahead of ours never moves a sale into the future
      const saleDay = businessDate(shop.timezone, shop.cutoff, happenedAt);
      // the kitchen works on the server clock: a till whose clock is behind must not file a paid order under yesterday
      const kitchenDay = outbox ? saleDay : businessDate(shop.timezone, shop.cutoff, now);
      const rules = await tx.select().from(taxRules).where(eq(taxRules.active, true));
      const lenient = (code: SaleError, reason: string) => (outbox ? reasons.add(reason) : refuse(code));
      // collecting a phone order: its channel, customer, and lines come from the order taken on the phone (spec 6.57)
      const collecting = s.food?.kitchenOrderId ? await openPhoneOrder(tx, s.food, reg.branchId) : null;
      if (collecting) await checkCollectedLines(tx, s.lines, collecting.pendingLines!);
      const channelFood = collecting ? {
        ...s.food!, customer: { name: collecting.customerName!, phone: collecting.customerPhone! },
        pickupAt: collecting.pickupAt?.toISOString(), deliveryAddress: collecting.deliveryAddress ?? undefined,
      } : s.food;
      const order = channelFood?.channelId ? await checkChannel(tx, channelFood, { ctxPermissions: ctx.permissions, cashierPermissions, lenient }) : null;
      const channel = order?.channel ?? null;
      const list = choosePriceList(await loadPriceRules(tx), { cartListId: channel?.priceListId ?? null, customerListId: customer?.priceListId ?? null, branchId: reg.branchId, today });

      const priced = [];
      for (const [i, l] of s.lines.entries()) {
        const quantity = quantities[i]!;
        const [item] = await tx.select({
          unitName: variantUnits.name, factor: variantUnits.factor, isBase: variantUnits.isBase, unitSellable: variantUnits.sellable, unitPrice: variantUnits.pricePesewas,
          kind: variants.kind, variantName: variants.name, allowsFractions: variants.allowsFractions, basePrice: variants.basePricePesewas,
          sellable: variants.sellable, variantStatus: variants.status, productName: products.name, productStatus: products.status,
          taxRuleId: products.taxRuleId, tracking: products.tracking, sellByAmount: variants.sellByAmount, minAmount: variants.minAmountPesewas,
        }).from(variantUnits)
          .innerJoin(variants, eq(variants.id, variantUnits.variantId))
          .innerJoin(products, eq(products.id, variants.productId))
          .where(and(eq(variantUnits.id, l.unitId), eq(variantUnits.variantId, l.variantId)));
        if (!item) return refuse('unknown_item');
        if (item.productStatus === 'archived' || item.variantStatus === 'archived') lenient('item_unavailable', 'item_archived');
        if (!item.sellable || !item.unitSellable) return refuse('not_sellable');
        if (!validSaleQuantity(quantity, item.isBase && item.allowsFractions)) return refuse('invalid_quantity');
        // spec 6.53: rice or stew sold by cedi amount is one line at the amount typed; its stock moves with the pots
        if (item.sellByAmount && !l.byAmount) return refuse('amount_required');
        if (l.byAmount && !item.sellByAmount) return refuse('not_sold_by_amount');
        if (l.byAmount && quantity !== '1.000') return refuse('invalid_quantity');
        if (item.kind !== 'combo' && l.choices?.length) return refuse('invalid_choices');
        if (item.kind !== 'standard') {
          const [{ n }] = await tx.select({ n: count() }).from(components).where(eq(components.parentVariantId, l.variantId));
          const [{ slots }] = item.kind === 'combo' ? await tx.select({ slots: count() }).from(comboSlots).where(eq(comboSlots.comboVariantId, l.variantId)) : [{ slots: 0 }];
          if (n === 0 && slots === 0) return refuse('empty_bundle');
        }
        // a phone order being collected was cooked already: selling out since then must not stop its payment
        const combo = item.kind === 'combo' ? await priceCombo(tx, l.variantId, l.choices ?? [], reg.branchId, kitchenDay, collecting === null) : null;
        if (combo === 'invalid_choices') return refuse('invalid_choices'); // the device built a bad cart: never lenient
        if (combo === 'stale_choices') lenient('invalid_choices', 'combo_changed'); // a paid offline sale from before a combo edit is kept for review
        if (combo === 'sold_out') lenient('sold_out', 'sold_out');
        const comboPriced = typeof combo === 'object' ? combo : combo === 'stale_choices' ? await choicesAsSent(tx, l.choices ?? []) : null;
        const listPrice = resolvePrice(list, { unitId: l.unitId, quantity, unitPricePesewas: item.unitPrice, unitFactor: item.factor, basePricePesewas: item.basePrice });
        // spec 4.24: add-ons are checked against the item's groups and add their prices; a combo or a by-amount line has none
        if (l.addOns?.length && (l.byAmount || item.kind === 'combo')) return refuse('invalid_add_ons');
        const addOnGroupsOfItem = l.byAmount || item.kind === 'combo' ? [] : await loadAddOnGroups(tx, l.variantId);
        const addOnCheck = checkAddOns(addOnGroupsOfItem, l.addOns ?? []);
        if (addOnCheck === 'invalid_add_ons') return refuse('invalid_add_ons'); // the device built a bad cart: never lenient
        if (addOnCheck === 'stale_add_ons') lenient('invalid_add_ons', 'add_ons_changed'); // a paid offline sale from before an add-on edit is kept for review
        const addOns = await addOnsAsSold(tx, addOnGroupsOfItem, l.addOns ?? [], addOnCheck === 'ok');
        const currentPrice = l.byAmount ? l.unitPricePesewas : listPrice + (comboPriced?.upgrades ?? 0) + (addOnCheck === 'ok' ? addOnTotal(addOnGroupsOfItem, l.addOns ?? []) : 0);
        if (l.byAmount && l.unitPricePesewas < (item.minAmount ?? 0)) lenient('below_minimum_amount', 'below_minimum');
        if (currentPrice !== l.unitPricePesewas) lenient('price_changed', 'price_changed'); // an outbox sale keeps the price the customer paid
        const gross = pesewasTimesQty(l.unitPricePesewas, quantity);
        // both the signed-in user and the recorded cashier must hold it: a client-supplied cashier never lends a permission
        if (l.discountPesewas > 0 && !(ctx.permissions.includes('give_discount') && cashierPermissions.includes('give_discount'))) return refuse('discount_not_allowed');
        if (l.discountPesewas > gross) return refuse('discount_too_large');
        const baseQty = multiplyQty(quantity, item.factor);
        const lineSerials = l.serials ?? [];
        if (item.tracking === 'serial' && toMilli(baseQty) !== BigInt(lineSerials.length) * 1000n) lenient('serials_required', 'serials_missing');
        const rule = chooseTaxRule(shop.taxEnabled, item.taxRuleId, rules);
        priced.push({ ...l, quantity, baseQty, serials: lineSerials, currentPrice, byAmount: l.byAmount === true, choices: comboPriced?.choices ?? [], addOns, note: l.note || null, name: itemLabel(item.productName, item.variantName), unitName: item.unitName, taxRateBp: rule ? effectiveRateBp(rule) : 0 });
      }

      const totals = calculateCartTotals(priced, { taxMode: shop.taxMode });
      // spec 6.57: an app that collects the money pays the shop later, so its order has exactly one settlement for the total
      const settlements = s.tenders.filter((t) => t.method === 'channel_settlement');
      if (channel?.collectedBy === 'app') {
        if (s.tenders.length !== 1 || settlements.length !== 1 || settlements[0].amountPesewas !== totals.totalPesewas || !settlements[0].reference) refuse('channel_settlement_required');
      } else if (settlements.length) refuse('invalid_tender');
      if (s.tenders.some((t) => NEEDS_REFERENCE.includes(t.method) && !t.reference)) return refuse('reference_required');
      const nonCash = s.tenders.filter((t) => t.method !== 'cash').reduce((a, t) => a + t.amountPesewas, 0);
      if (nonCash > totals.totalPesewas) return refuse('reduce_non_cash_amount'); // only cash can produce change
      if (s.tenders.some((t) => t.method === 'store_credit') && !customer) return refuse('store_credit_needs_customer');
      const paid = s.tenders.reduce((a, t) => a + t.amountPesewas, 0);
      if (paid < totals.totalPesewas) lenient('payment_incomplete', 'underpaid');
      const changeDue = Math.max(0, paid - totals.totalPesewas);
      const dining = s.food && (s.food.serviceMode === 'quick' ? 'eat_in' : s.food.diningOption); // quick serve is always eat in
      if (s.food) await checkFood(tx, { food: s.food, dining: dining!, deviceNumberOk, serviceModes: reg.serviceModes, branchId: reg.branchId, saleDay: kitchenDay, lines: priced, lenient, collecting: collecting !== null });

      const commission = channel ? commissionPesewas(totals.totalPesewas, channel.commissionBp) : 0;
      const [saved] = await tx.insert(sales).values({
        id: s.saleId, tenantId: ctx.tenantId, branchId: reg.branchId, registerId: reg.id, cashierId, customerId: customer?.id ?? null,
        receiptNumber: s.receiptNumber, status: 'pending', taxMode: shop.taxMode, subtotalPesewas: totals.subtotalPesewas,
        discountPesewas: totals.discountPesewas, taxPesewas: totals.taxPesewas, totalPesewas: totals.totalPesewas, paidPesewas: paid,
        changeDuePesewas: changeDue, fromOffline: outbox, deviceCreatedAt: deviceAt, receivedAt: now,
        businessDate: saleDay, shareCode: randomBytes(16).toString('base64url'),
        serviceMode: s.food?.serviceMode ?? null, diningOption: dining ?? null,
        channelId: channel?.id ?? null, externalOrderId: order?.externalOrderId ?? null, commissionPesewas: commission,
      }).onConflictDoNothing({ target: sales.id }).returning({ id: sales.id });
      if (!saved) {
        const again = await findSale(tx, s.saleId); // row-level security hides another shop's sale with this id
        return again ? repeat(tx, ctx, again, deviceNumberOk ? deviceNumber : undefined, now) : refuse('sale_id_taken');
      }
      await tx.insert(saleLines).values(priced.map((l, i) => ({
        tenantId: ctx.tenantId, saleId: s.saleId, lineNo: i + 1, variantId: l.variantId, unitId: l.unitId, name: l.name, unitName: l.unitName,
        quantity: l.quantity, baseQuantity: l.baseQty, unitPricePesewas: l.unitPricePesewas, currentPricePesewas: l.currentPrice,
        discountPesewas: totals.lines[i].discountPesewas, grossPesewas: totals.lines[i].grossPesewas, taxRateBp: l.taxRateBp,
        taxPesewas: totals.lines[i].taxPesewas, totalPesewas: totals.lines[i].totalPesewas, serials: l.serials, byAmount: l.byAmount, choices: l.choices, addOns: l.addOns, note: l.note,
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
      if (channel?.collectedBy === 'app') {
        await tx.insert(channelReceivables).values({ tenantId: ctx.tenantId, saleId: s.saleId, channelId: channel.id, expectedPesewas: totals.totalPesewas - commission });
      }

      const done = await finaliseSaleTx(tx, ctx.tenantId, s.saleId, now);
      if (done.problems.onlyExpired) lenient('only_expired_stock', 'only_expired_stock');
      if (done.problems.serialsMissing) lenient('unknown_serial', 'serials_missing');
      if (done.problems.negative) {
        if (outbox) reasons.add('negative_stock');
        else if (!shop.allowNegativeStock) refuse('not_enough_stock');
      }
      let orderNumber: string | null = null;
      if (collecting) {
        orderNumber = collecting.orderNumber; // already in the kitchen under its number: it is paid, not sent again
        await tx.update(kitchenOrders).set({ saleId: s.saleId }).where(eq(kitchenOrders.id, collecting.id));
        await tx.update(sales).set({ orderNumber }).where(eq(sales.id, s.saleId));
      } else if (s.food?.serviceMode === 'counter') {
        orderNumber = deviceNumber ?? await nextOrderNumber(tx, ctx.tenantId, reg.branchId, kitchenDay);
        await tx.insert(kitchenOrders).values({
          tenantId: ctx.tenantId, branchId: reg.branchId, saleId: s.saleId, orderNumber, businessDate: kitchenDay, diningOption: dining!,
          needsPacking: needsPacking(dining!, channel !== null), sentAt: now,
          channelId: channel?.id ?? null, customerName: order?.customer?.name ?? null, customerPhone: order?.customer?.phone ?? null,
          pickupAt: order?.pickupAt ?? null, deliveryAddress: order?.deliveryAddress ?? null,
        });
        await tx.update(sales).set({ orderNumber }).where(eq(sales.id, s.saleId));
      }
      if (reasons.size) await tx.update(sales).set({ needsReview: true, reviewReasons: [...reasons] }).where(eq(sales.id, s.saleId));
      return { ok: true, saleId: s.saleId, status: done.status, changeDuePesewas: changeDue, alreadyExisted: false, orderNumber };
    });
  } catch (e) {
    if (e instanceof SaleRefused) return { ok: false, error: e.code };
    if (isUniqueViolation(e, 'sales_channel_order')) return { ok: false, error: 'channel_order_exists' }; // another till saved this platform order first
    throw e;
  }
}

type PricedLine = { variantId: string; quantity: string };

/** The item's add-on groups in order, with every option (active or not) and its name (spec 4.24). */
export async function loadAddOnGroups(tx: Tx, variantId: string) {
  const groups = await tx.select({ id: addOnGroups.id, name: addOnGroups.name, minChoices: addOnGroups.minChoices, maxChoices: addOnGroups.maxChoices })
    .from(variantAddOnGroups).innerJoin(addOnGroups, eq(addOnGroups.id, variantAddOnGroups.groupId))
    .where(eq(variantAddOnGroups.variantId, variantId)).orderBy(asc(variantAddOnGroups.sortOrder));
  const options = groups.length ? await tx.select({ id: addOnOptions.id, groupId: addOnOptions.groupId, name: addOnOptions.name, pricePesewas: addOnOptions.pricePesewas, active: addOnOptions.active })
    .from(addOnOptions).where(inArray(addOnOptions.groupId, groups.map((g) => g.id))).orderBy(asc(addOnOptions.sortOrder)) : [];
  return groups.map((g) => ({ ...g, options: options.filter((o) => o.groupId === g.id) }));
}

/** The add-ons as they go on the line: names and prices from the catalogue; a stale choice keeps its name at price 0. */
async function addOnsAsSold(tx: Tx, groups: Awaited<ReturnType<typeof loadAddOnGroups>>, chosen: Array<{ groupId: string; optionId: string }>, priced: boolean): Promise<SaleLineAddOn[]> {
  if (!chosen.length) return [];
  const named = await tx.select({ id: addOnOptions.id, name: addOnOptions.name }).from(addOnOptions).where(inArray(addOnOptions.id, chosen.map((c) => c.optionId)));
  return chosen.map((c) => {
    const option = groups.find((g) => g.id === c.groupId)?.options.find((o) => o.id === c.optionId);
    return { groupId: c.groupId, optionId: c.optionId, name: named.find((n) => n.id === c.optionId)?.name ?? 'Add-on', pricePesewas: priced && option ? option.pricePesewas : 0 };
  });
}

/** A Postgres unique violation of `constraint`, from postgres.js or PGlite, wrapped by Drizzle or not. */
function isUniqueViolation(e: unknown, constraint: string): boolean {
  for (let err = e as { code?: string; constraint?: string; constraint_name?: string; message?: string; cause?: unknown } | undefined; err; err = err.cause as typeof err) {
    if (err.code === '23505') return [err.constraint, err.constraint_name, err.message].some((v) => v?.includes(constraint));
  }
  return false;
}

type ChannelOrder = {
  channel: typeof salesChannels.$inferSelect; externalOrderId: string | null; customer: { name: string; phone: string } | null;
  pickupAt: Date | null; deliveryAddress: string | null;
};

/** Spec 6.57: who may enter a channel order, how it is served, and the order ID or customer it needs. */
async function checkChannel(tx: Tx, food: NonNullable<SaleInput['food']>, c: {
  ctxPermissions: readonly string[]; cashierPermissions: readonly string[]; lenient: (code: SaleError, reason: string) => unknown;
}): Promise<ChannelOrder> {
  if (!c.ctxPermissions.includes('enter_channel_orders') || !c.cashierPermissions.includes('enter_channel_orders')) refuse('channel_not_allowed');
  const [channel] = await tx.select().from(salesChannels).where(eq(salesChannels.id, food.channelId!));
  if (!channel) return refuse('unknown_channel');
  if (!channel.active) c.lenient('unknown_channel', 'channel_inactive');
  if (food.serviceMode !== 'counter' || (food.diningOption !== 'takeaway' && food.diningOption !== 'delivery')) refuse('dining_option_not_allowed');
  if (channel.kind === 'delivery_app') {
    const externalOrderId = food.externalOrderId?.trim() ?? '';
    if (externalOrderId.length < 1 || externalOrderId.length > 64) refuse('external_order_id_required');
    // a real duplicate is never lenient, not even from the outbox: the manager sees it in held sales
    const [dup] = await tx.select({ id: sales.id }).from(sales).where(and(eq(sales.channelId, channel.id), eq(sales.externalOrderId, externalOrderId)));
    if (dup) refuse('channel_order_exists');
    return { channel, externalOrderId, customer: null, pickupAt: null, deliveryAddress: null };
  }
  const who = phoneCustomer(food);
  if (!who) return refuse('customer_details_required');
  return { channel, externalOrderId: null, customer: { name: who.name, phone: who.phone }, pickupAt: who.pickupAt, deliveryAddress: who.deliveryAddress };
}

/** Spec 6.51: the next order number of a branch's business date; the upsert's row lock keeps two tills from sharing a number. */
export async function nextOrderNumber(tx: Tx, tenantId: string, branchId: string, day: string): Promise<string> {
  const [row] = await tx.insert(branchOrderCounters).values({ tenantId, branchId, businessDate: day, last: 1 })
    .onConflictDoUpdate({ target: [branchOrderCounters.tenantId, branchOrderCounters.branchId, branchOrderCounters.businessDate], set: { last: sql`${branchOrderCounters.last} + 1` } })
    .returning({ last: branchOrderCounters.last });
  return formatOrderNumber(row.last);
}

/** The unpaid phone order being collected, locked; anything else (paid, cancelled, another branch) is not open. */
async function openPhoneOrder(tx: Tx, food: NonNullable<SaleInput['food']>, branchId: string) {
  const [o] = await tx.select().from(kitchenOrders).where(eq(kitchenOrders.id, food.kitchenOrderId!)).for('update');
  if (!o || !o.payOnCollect || o.saleId || !['preparing', 'ready'].includes(o.status) || o.branchId !== branchId) return refuse('order_not_open');
  if (food.channelId !== o.channelId || food.diningOption !== o.diningOption || food.serviceMode !== 'counter') return refuse('order_changed');
  return o;
}

/** The order's lines first, in order, then only pack lines: the cashier cannot add or drop items, and packing ticks keep their line numbers. */
async function checkCollectedLines(tx: Tx, lines: SaleInput['lines'], pending: PendingLine[]): Promise<void> {
  const [settings] = await tx.select({ packId: foodSettings.packVariantId }).from(foodSettings);
  const choiceKey = (c: Array<{ slotId: string; variantId: string }> = []) => c.map((x) => `${x.slotId}:${x.variantId}`).sort().join(',');
  const same = (l: SaleInput['lines'][number], p: PendingLine) => l.variantId === p.variantId && l.unitId === p.unitId
    && toMilli(parseQuantity(l.quantity)!) === toMilli(p.quantity) && (l.byAmount === true) === (p.byAmount === true)
    && (!p.byAmount || l.unitPricePesewas === p.amountPesewas) && choiceKey(l.choices) === choiceKey(p.choices);
  const extra = lines.slice(pending.length);
  if (lines.length < pending.length || !pending.every((p, i) => same(lines[i], p)) || extra.some((l) => l.variantId !== settings?.packId)) refuse('order_changed');
}

/** Spec 6.52: the combo slots checked against the choices sent; upgrades add to the price; choices are stored as sold. */
/** The choices of a stale combo line as the till sent them, named from the catalogue, with no upgrade price. */
async function choicesAsSent(tx: Tx, chosen: Array<{ slotId: string; variantId: string }>): Promise<{ upgrades: number; choices: SaleLineChoice[] }> {
  const named = chosen.length ? await tx.select({ id: variants.id, productName: products.name, variantName: variants.name }).from(variants)
    .innerJoin(products, eq(products.id, variants.productId)).where(inArray(variants.id, chosen.map((c) => c.variantId))) : [];
  const known = chosen.filter((c) => named.some((n) => n.id === c.variantId));
  return { upgrades: 0, choices: known.map((c) => {
    const n = named.find((x) => x.id === c.variantId)!;
    return { slotId: c.slotId, variantId: c.variantId, name: itemLabel(n.productName, n.variantName), upgradePesewas: 0 };
  }) };
}

export async function priceCombo(
  tx: Tx, comboVariantId: string, chosen: Array<{ slotId: string; variantId: string }>, branchId: string, day: string, checkSoldOut = true,
): Promise<'invalid_choices' | 'stale_choices' | 'sold_out' | { upgrades: number; choices: SaleLineChoice[] }> {
  const slotRows = await tx.select().from(comboSlots).where(eq(comboSlots.comboVariantId, comboVariantId));
  const choiceRows = slotRows.length ? await tx.select({
    slotId: comboChoices.slotId, variantId: comboChoices.variantId, upgradePesewas: comboChoices.upgradePesewas, productName: products.name, variantName: variants.name,
  }).from(comboChoices).innerJoin(variants, eq(variants.id, comboChoices.variantId)).innerJoin(products, eq(products.id, variants.productId))
    .where(inArray(comboChoices.slotId, slotRows.map((s) => s.id))) : [];
  const slots: ComboSlotDef[] = slotRows.map((s) => ({ id: s.id, minChoices: s.minChoices, maxChoices: s.maxChoices, choices: choiceRows.filter((c) => c.slotId === s.id) }));
  // a slot id the combo no longer has means the owner edited the combo after the till built this cart
  if (chosen.some((c) => !slotRows.some((s) => s.id === c.slotId))) return 'stale_choices';
  const check = checkComboChoices(slots, chosen, checkSoldOut ? await isSoldOut(tx, branchId, chosen.map((c) => c.variantId), day) : new Set<string>());
  if (check !== 'ok') return check;
  const choices = chosen.map((c) => {
    const row = choiceRows.find((r) => r.slotId === c.slotId && r.variantId === c.variantId)!;
    return { slotId: c.slotId, variantId: c.variantId, name: itemLabel(row.productName, row.variantName), upgradePesewas: row.upgradePesewas };
  });
  return { upgrades: comboUpgradeTotal(slots, chosen), choices };
}
type FoodCheck = {
  food: NonNullable<SaleInput['food']>; dining: DiningOption; deviceNumberOk: boolean; serviceModes: string[]; branchId: string; saleDay: string;
  lines: PricedLine[]; lenient: (code: SaleError, reason: string) => unknown; collecting: boolean;
};

/** Spec 6.51, 6.55, 6.56: the food block's mode, sold-out items, and pack line, checked before the sale is saved. */
async function checkFood(tx: Tx, c: FoodCheck): Promise<void> {
  if (!(await foodEnabled(tx))) refuse('invalid_input');
  if (!c.serviceModes.includes(c.food.serviceMode)) c.lenient('service_mode_not_allowed', 'service_mode');
  if (!c.deviceNumberOk || (c.food.orderNumber !== undefined && c.food.serviceMode !== 'counter')) refuse('invalid_order_number');
  const ids = [...new Set(c.lines.map((l) => l.variantId))];
  if (!c.collecting && (await isSoldOut(tx, c.branchId, ids, c.saleDay)).size) c.lenient('sold_out', 'sold_out');
  const [settings] = await tx.select().from(foodSettings);
  const packId = settings?.packVariantId ?? null;
  const flags = await tx.select({ id: variants.id, needsPack: variants.needsPack }).from(variants).where(inArray(variants.id, ids));
  const expected = packCount(c.lines, {
    diningOption: c.dining, mode: settings?.packFeeMode ?? 'per_order', packVariantId: packId,
    needsPack: (id) => flags.find((f) => f.id === id)?.needsPack ?? false,
  });
  const packedMilli = c.lines.filter((l) => l.variantId === packId).reduce((sum, l) => sum + toMilli(l.quantity), 0n);
  if (packedMilli !== BigInt(expected) * 1000n) c.lenient('pack_fee_mismatch', 'pack_fee');
}

type StoredSale = { id: string; status: 'pending' | 'completed'; changeDuePesewas: number; orderNumber: string | null };

async function findSale(tx: Tx, saleId: string): Promise<StoredSale | undefined> {
  const [row] = await tx.select({ id: sales.id, status: sales.status, changeDuePesewas: sales.changeDuePesewas, orderNumber: sales.orderNumber })
    .from(sales).where(eq(sales.id, saleId));
  return row;
}

/**
 * A repeated request changes nothing; a sale left pending is finalised again so a retry can heal it.
 * The one exception: a device that printed its own order number after an unclear send keeps it, as the customer holds that number.
 */
async function repeat(tx: Tx, ctx: Ctx, sale: StoredSale, deviceNumber: string | undefined, now: Date): Promise<SaleResult> {
  const status = sale.status === 'pending' ? (await finaliseSaleTx(tx, ctx.tenantId, sale.id, now)).status : sale.status;
  let orderNumber = sale.orderNumber;
  if (deviceNumber && orderNumber && deviceNumber !== orderNumber) {
    await tx.update(sales).set({ orderNumber: deviceNumber }).where(eq(sales.id, sale.id));
    await tx.update(kitchenOrders).set({ orderNumber: deviceNumber }).where(eq(kitchenOrders.saleId, sale.id));
    await writeAudit(tx, {
      tenantId: ctx.tenantId, actorType: 'user', actorId: ctx.userId, action: 'order_number_changed', recordType: 'sale', recordId: sale.id,
      changes: { from: orderNumber, to: deviceNumber },
    });
    orderNumber = deviceNumber;
  }
  return { ok: true, saleId: sale.id, status, changeDuePesewas: sale.changeDuePesewas, alreadyExisted: true, orderNumber };
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
    if (l.byAmount) continue; // spec 6.54: by-amount stock moves when pots are recorded
    const p = await deductStockForLine(tx, { tenantId, branchId: sale.branchId, saleId, saleLineId: l.id, userId: sale.cashierId, today },
      { variantId: l.variantId, baseQty: l.baseQuantity, serials: l.serials, choices: l.choices.map((c) => c.variantId) });
    // spec 6.28: an add-on with an ingredient (extra chicken) deducts it once per plate
    const extras = l.addOns.length ? await tx.select({ variantId: addOnOptions.ingredientVariantId, quantity: addOnOptions.ingredientQuantity }).from(addOnOptions)
      .where(inArray(addOnOptions.id, l.addOns.map((a) => a.optionId))) : [];
    for (const e of extras) {
      if (!e.variantId || !e.quantity) continue;
      const x = await deductStockForLine(tx, { tenantId, branchId: sale.branchId, saleId, saleLineId: l.id, userId: sale.cashierId, today },
        { variantId: e.variantId, baseQty: multiplyQty(e.quantity, l.baseQuantity), serials: [] });
      p.negative ||= x.negative;
      p.onlyExpired ||= x.onlyExpired;
    }
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

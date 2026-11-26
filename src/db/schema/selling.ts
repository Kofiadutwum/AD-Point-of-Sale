import { sql } from 'drizzle-orm';
import { bigint, boolean, check, date, foreignKey, index, integer, jsonb, numeric, pgTable, primaryKey, text, unique, uniqueIndex, uuid } from 'drizzle-orm/pg-core';
import { createdAt, id, timestamptz } from './columns';
import { priceLists, variants, variantUnits } from './catalogue';
import { users } from './people';
import { branches, registers, tenants } from './tenancy';

export type TenderMethod = 'cash' | 'momo_manual' | 'card_terminal' | 'bank_transfer' | 'store_credit' | 'channel_settlement' | 'exchange_credit' | 'credit'; // exchange_credit: server only (spec 6.32)
export type SaleStatus = 'pending' | 'completed';
export type SaleLineChoice = { slotId: string; variantId: string; name: string; upgradePesewas: number };
export type SaleLineAddOn = { groupId: string; optionId: string; name: string; pricePesewas: number };
export const TENDER_METHODS: readonly TenderMethod[] = ['cash', 'momo_manual', 'card_terminal', 'bank_transfer', 'store_credit', 'channel_settlement', 'credit'];
export type ChannelKind = 'delivery_app' | 'phone' | 'whatsapp';

const tenantId = () => uuid('tenant_id').notNull().references(() => tenants.id);
const quantity = (name: string) => numeric(name, { precision: 14, scale: 3 });
const pesewas = (name: string) => integer(name).notNull();

export const customers = pgTable('customers', {
  id: id(),
  tenantId: tenantId(),
  name: text('name').notNull(),
  phone: text('phone').notNull(), // 233 + 9 digits
  priceListId: uuid('price_list_id'),
  storeCreditPesewas: integer('store_credit_pesewas').notNull().default(0),
  creditLimitPesewas: integer('credit_limit_pesewas').notNull().default(0), // 0 = no credit (spec 4.5)
  balancePesewas: integer('balance_pesewas').notNull().default(0), // owed on credit; always the ledger's sum
  reminderConsent: boolean('reminder_consent').notNull().default(false), // agreed to debt reminders by SMS
  address: text('address'), // business customers on invoices (spec 4.22)
  tin: text('tin'), // taxpayer identification number on invoices
  marketingConsent: boolean('marketing_consent').notNull().default(false), // agreed to promotional SMS (spec 4.25)
  createdAt: createdAt(),
}, (t) => [
  unique('customers_tenant_id').on(t.tenantId, t.id),
  unique('customers_phone').on(t.tenantId, t.phone),
  foreignKey({ name: 'customers_price_list_fk', columns: [t.tenantId, t.priceListId], foreignColumns: [priceLists.tenantId, priceLists.id] }),
  check('customers_store_credit', sql`${t.storeCreditPesewas} >= 0`),
  check('customers_credit', sql`${t.creditLimitPesewas} >= 0 and ${t.balancePesewas} >= 0`),
]);

/** Every change to a store credit balance (spec 6.31); never edited. */
export const storeCreditEntries = pgTable('store_credit_entries', {
  id: bigint('id', { mode: 'number' }).primaryKey().generatedAlwaysAsIdentity(),
  tenantId: tenantId(),
  customerId: uuid('customer_id').notNull(),
  type: text('type').$type<'issued' | 'redeemed'>().notNull(),
  source: text('source').$type<'refund' | 'goodwill' | 'sale'>().notNull(),
  amountPesewas: integer('amount_pesewas').notNull(), // + issued, − redeemed
  saleId: uuid('sale_id'),
  reason: text('reason'),
  userId: uuid('user_id').notNull(),
  createdAt: createdAt(),
}, (t) => [
  foreignKey({ name: 'store_credit_entries_customer_fk', columns: [t.tenantId, t.customerId], foreignColumns: [customers.tenantId, customers.id] }),
  check('store_credit_entries_type', sql`${t.type} in ('issued', 'redeemed')`),
  check('store_credit_entries_source', sql`${t.source} in ('refund', 'goodwill', 'sale')`),
  check('store_credit_entries_amount', sql`${t.amountPesewas} <> 0`),
]);

/** Where an order came from besides walk-in: a delivery app, phone, or WhatsApp, with its own prices and commission (spec 6.57). */
export const salesChannels = pgTable('sales_channels', {
  id: id(),
  tenantId: tenantId(),
  name: text('name').notNull(),
  kind: text('kind').$type<ChannelKind>().notNull(),
  priceListId: uuid('price_list_id'),
  commissionBp: integer('commission_bp').notNull().default(0),
  collectedBy: text('collected_by').$type<'app' | 'shop'>().notNull().default('shop'),
  active: boolean('active').notNull().default(true),
  createdAt: createdAt(),
}, (t) => [
  unique('sales_channels_tenant_id').on(t.tenantId, t.id),
  uniqueIndex('sales_channels_name').on(t.tenantId, sql`lower(${t.name})`),
  foreignKey({ name: 'sales_channels_price_list_fk', columns: [t.tenantId, t.priceListId], foreignColumns: [priceLists.tenantId, priceLists.id] }),
  check('sales_channels_kind', sql`${t.kind} in ('delivery_app', 'phone', 'whatsapp')`),
  check('sales_channels_commission', sql`${t.commissionBp} between 0 and 10000`),
  check('sales_channels_collected_by', sql`${t.collectedBy} in ('app', 'shop') and (${t.kind} = 'delivery_app' or ${t.collectedBy} = 'shop')`),
]);

/** The id is the UUID made on the device; it is also the idempotency key (spec 6.0, 6.8). */
export type ShiftStatus = 'open' | 'closed';

/** Spec 6.14: a till's cash from opening float to counted close. One open shift per register. */
export const shifts = pgTable('shifts', {
  id: id(),
  tenantId: tenantId(),
  branchId: uuid('branch_id').notNull(),
  registerId: uuid('register_id').notNull(),
  status: text('status').$type<ShiftStatus>().notNull().default('open'),
  openedBy: uuid('opened_by').notNull(),
  openedAt: timestamptz('opened_at').notNull(),
  openingCashPesewas: integer('opening_cash_pesewas').notNull(),
  closedBy: uuid('closed_by'),
  closedAt: timestamptz('closed_at'),
  expectedCashPesewas: integer('expected_cash_pesewas'),
  countedCashPesewas: integer('counted_cash_pesewas'),
  variancePesewas: integer('variance_pesewas'),
  varianceReason: text('variance_reason'),
  approvedBy: uuid('approved_by'),
}, (t) => [
  unique('shifts_tenant_id').on(t.tenantId, t.id),
  uniqueIndex('shifts_one_open').on(t.registerId).where(sql`${t.status} = 'open'`),
  check('shifts_status', sql`${t.status} in ('open', 'closed')`),
  check('shifts_opening', sql`${t.openingCashPesewas} >= 0`),
  foreignKey({ name: 'shifts_branch_fk', columns: [t.tenantId, t.branchId], foreignColumns: [branches.tenantId, branches.id] }),
  foreignKey({ name: 'shifts_register_fk', columns: [t.tenantId, t.registerId], foreignColumns: [registers.tenantId, registers.id] }),
  foreignKey({ name: 'shifts_opened_by_fk', columns: [t.tenantId, t.openedBy], foreignColumns: [users.tenantId, users.id] }),
  foreignKey({ name: 'shifts_closed_by_fk', columns: [t.tenantId, t.closedBy], foreignColumns: [users.tenantId, users.id] }),
  foreignKey({ name: 'shifts_approved_by_fk', columns: [t.tenantId, t.approvedBy], foreignColumns: [users.tenantId, users.id] }),
]);

export const sales = pgTable('sales', {
  id: uuid('id').primaryKey(),
  tenantId: tenantId(),
  branchId: uuid('branch_id').notNull(),
  registerId: uuid('register_id').notNull(),
  cashierId: uuid('cashier_id').notNull(),
  customerId: uuid('customer_id'),
  receiptNumber: text('receipt_number').notNull(),
  status: text('status').$type<SaleStatus>().notNull(),
  taxMode: text('tax_mode').$type<'inclusive' | 'exclusive'>().notNull(),
  subtotalPesewas: pesewas('subtotal_pesewas'),
  discountPesewas: pesewas('discount_pesewas'),
  taxPesewas: pesewas('tax_pesewas'),
  totalPesewas: pesewas('total_pesewas'),
  paidPesewas: pesewas('paid_pesewas'),
  changeDuePesewas: pesewas('change_due_pesewas'),
  fromOffline: boolean('from_offline').notNull().default(false),
  needsReview: boolean('needs_review').notNull().default(false),
  reviewReasons: text('review_reasons').array().notNull().default(sql`'{}'`),
  deviceCreatedAt: timestamptz('device_created_at').notNull(),
  receivedAt: timestamptz('received_at').notNull(),
  completedAt: timestamptz('completed_at'),
  businessDate: date('business_date', { mode: 'string' }).notNull(),
  shareCode: text('share_code').notNull().unique(),
  serviceMode: text('service_mode').$type<'counter' | 'quick' | 'table'>(), // food sales only
  diningOption: text('dining_option').$type<'eat_in' | 'takeaway' | 'delivery'>(),
  orderNumber: text('order_number'),
  channelId: uuid('channel_id'), // delivery app, phone, or WhatsApp; null for walk-in (spec 6.57)
  externalOrderId: text('external_order_id'), // the platform order ID
  commissionPesewas: integer('commission_pesewas').notNull().default(0),
  serviceChargePesewas: integer('service_charge_pesewas').notNull().default(0), // untaxed, added to the total (spec 6.6)
  roundingPesewas: integer('rounding_pesewas').notNull().default(0), // cash rounding added to the amount due, may be negative (spec 6.40)
  salespersonId: uuid('salesperson_id'), // who built the order at another counter (spec 6.39)
  shiftId: uuid('shift_id'), // the register's open shift when the sale was made (spec 6.14)
}, (t) => [
  unique('sales_tenant_id').on(t.tenantId, t.id),
  unique('sales_receipt_number').on(t.tenantId, t.receiptNumber),
  index('sales_business_date').on(t.tenantId, t.businessDate),
  check('sales_service_mode', sql`${t.serviceMode} in ('counter', 'quick', 'table')`),
  check('sales_dining_option', sql`${t.diningOption} in ('eat_in', 'takeaway', 'delivery')`),
  uniqueIndex('sales_channel_order').on(t.tenantId, t.channelId, t.externalOrderId).where(sql`${t.externalOrderId} is not null`),
  check('sales_external_order', sql`${t.externalOrderId} is null or ${t.channelId} is not null`),
  check('sales_commission', sql`${t.commissionPesewas} >= 0`),
  check('sales_service_charge', sql`${t.serviceChargePesewas} >= 0`),
  foreignKey({ name: 'sales_channel_fk', columns: [t.tenantId, t.channelId], foreignColumns: [salesChannels.tenantId, salesChannels.id] }),
  foreignKey({ name: 'sales_branch_fk', columns: [t.tenantId, t.branchId], foreignColumns: [branches.tenantId, branches.id] }),
  foreignKey({ name: 'sales_register_fk', columns: [t.tenantId, t.registerId], foreignColumns: [registers.tenantId, registers.id] }),
  foreignKey({ name: 'sales_cashier_fk', columns: [t.tenantId, t.cashierId], foreignColumns: [users.tenantId, users.id] }),
  foreignKey({ name: 'sales_salesperson_fk', columns: [t.tenantId, t.salespersonId], foreignColumns: [users.tenantId, users.id] }),
  foreignKey({ name: 'sales_shift_fk', columns: [t.tenantId, t.shiftId], foreignColumns: [shifts.tenantId, shifts.id] }),
  foreignKey({ name: 'sales_customer_fk', columns: [t.tenantId, t.customerId], foreignColumns: [customers.tenantId, customers.id] }),
  check('sales_status', sql`${t.status} in ('pending', 'completed')`),
  check('sales_tax_mode', sql`${t.taxMode} in ('inclusive', 'exclusive')`),
]);

/** Snapshots of what was sold: name, price, discount, and tax at the time of sale. */
export const saleLines = pgTable('sale_lines', {
  id: id(),
  tenantId: tenantId(),
  saleId: uuid('sale_id').notNull(),
  lineNo: integer('line_no').notNull(),
  variantId: uuid('variant_id').notNull(),
  unitId: uuid('unit_id').notNull(), // no foreign key: a unit can be removed later; unit_name and base_quantity keep the record
  name: text('name').notNull(),
  unitName: text('unit_name').notNull(),
  quantity: quantity('quantity').notNull(),
  baseQuantity: quantity('base_quantity').notNull(),
  unitPricePesewas: pesewas('unit_price_pesewas'), // what the customer paid per unit
  currentPricePesewas: pesewas('current_price_pesewas'), // the server's price when the sale arrived
  discountPesewas: pesewas('discount_pesewas'),
  grossPesewas: pesewas('gross_pesewas'),
  taxRateBp: integer('tax_rate_bp').notNull(),
  taxPesewas: pesewas('tax_pesewas'),
  totalPesewas: pesewas('total_pesewas'),
  serials: text('serials').array().notNull().default(sql`'{}'`),
  byAmount: boolean('by_amount').notNull().default(false), // sold by cedi amount; stock moves with pots, not here (spec 6.53)
  choices: jsonb('choices').$type<SaleLineChoice[]>().notNull().default(sql`'[]'::jsonb`), // combo choices as sold (spec 6.52)
  addOns: jsonb('add_ons').$type<SaleLineAddOn[]>().notNull().default(sql`'[]'::jsonb`), // add-ons as sold (spec 4.24)
  note: text('note'), // e.g. "no onions", for the kitchen
}, (t) => [
  check('sale_lines_note', sql`length(${t.note}) <= 140`),
  unique('sale_lines_tenant_id').on(t.tenantId, t.id),
  unique('sale_lines_line_no').on(t.saleId, t.lineNo),
  foreignKey({ name: 'sale_lines_sale_fk', columns: [t.tenantId, t.saleId], foreignColumns: [sales.tenantId, sales.id] }),
  foreignKey({ name: 'sale_lines_variant_fk', columns: [t.tenantId, t.variantId], foreignColumns: [variants.tenantId, variants.id] }),
]);

/** The id is the tender UUID made on the device. */
export const payments = pgTable('payments', {
  id: uuid('id').primaryKey(),
  tenantId: tenantId(),
  saleId: uuid('sale_id').notNull(),
  method: text('method').$type<TenderMethod>().notNull(),
  amountPesewas: pesewas('amount_pesewas'),
  reference: text('reference'),
  status: text('status').$type<'confirmed' | 'pending'>().notNull().default('confirmed'),
  confirmedBy: uuid('confirmed_by'),
  createdAt: createdAt(),
}, (t) => [
  foreignKey({ name: 'payments_sale_fk', columns: [t.tenantId, t.saleId], foreignColumns: [sales.tenantId, sales.id] }),
  check('payments_method', sql`${t.method} in ('cash', 'momo_manual', 'card_terminal', 'bank_transfer', 'store_credit', 'channel_settlement', 'exchange_credit', 'credit')`),
  check('payments_reference', sql`${t.method} in ('cash', 'store_credit', 'exchange_credit', 'credit') or ${t.reference} is not null`),
  check('payments_amount', sql`${t.amountPesewas} > 0`),
  check('payments_status', sql`${t.status} in ('confirmed', 'pending')`),
]);

export type ReturnCondition = 'saleable' | 'damaged' | 'expired';

/** Goods taken back, from a receipt or without one, and how they were refunded (spec 6.12, 6.33). */
export const returns = pgTable('returns', {
  id: id(),
  tenantId: tenantId(),
  branchId: uuid('branch_id').notNull(),
  saleId: uuid('sale_id'),
  customerId: uuid('customer_id'),
  kind: text('kind').$type<'receipt' | 'no_receipt'>().notNull(),
  reason: text('reason').notNull(),
  refundMethod: text('refund_method').notNull(),
  refundPesewas: integer('refund_pesewas').notNull(),
  reference: text('reference'),
  requestedBy: uuid('requested_by').notNull(),
  approvedBy: uuid('approved_by'),
  exchangeSaleId: uuid('exchange_sale_id'), // the sale the returned items paid towards (spec 6.32)
  exchangeCreditPesewas: integer('exchange_credit_pesewas').notNull().default(0),
  shiftId: uuid('shift_id'), // the till's open shift when the money was given back (spec 6.14)
  createdAt: createdAt(),
}, (t) => [
  unique('returns_tenant_id').on(t.tenantId, t.id),
  foreignKey({ name: 'returns_branch_fk', columns: [t.tenantId, t.branchId], foreignColumns: [branches.tenantId, branches.id] }),
  foreignKey({ name: 'returns_sale_fk', columns: [t.tenantId, t.saleId], foreignColumns: [sales.tenantId, sales.id] }),
  foreignKey({ name: 'returns_customer_fk', columns: [t.tenantId, t.customerId], foreignColumns: [customers.tenantId, customers.id] }),
  foreignKey({ name: 'returns_requested_by_fk', columns: [t.tenantId, t.requestedBy], foreignColumns: [users.tenantId, users.id] }),
  foreignKey({ name: 'returns_approved_by_fk', columns: [t.tenantId, t.approvedBy], foreignColumns: [users.tenantId, users.id] }),
  foreignKey({ name: 'returns_exchange_sale_fk', columns: [t.tenantId, t.exchangeSaleId], foreignColumns: [sales.tenantId, sales.id] }),
  foreignKey({ name: 'returns_shift_fk', columns: [t.tenantId, t.shiftId], foreignColumns: [shifts.tenantId, shifts.id] }),
  check('returns_exchange_credit', sql`${t.exchangeCreditPesewas} between 0 and ${t.refundPesewas}`),
  check('returns_kind', sql`${t.kind} in ('receipt', 'no_receipt') and (${t.kind} = 'no_receipt' or ${t.saleId} is not null)`),
  check('returns_refund', sql`${t.refundPesewas} >= 0`),
]);

export const returnLines = pgTable('return_lines', {
  id: id(),
  tenantId: tenantId(),
  returnId: uuid('return_id').notNull(),
  saleLineId: uuid('sale_line_id'),
  variantId: uuid('variant_id').notNull(),
  unitId: uuid('unit_id').notNull(),
  quantity: numeric('quantity', { precision: 14, scale: 3 }).notNull(),
  baseQuantity: numeric('base_quantity', { precision: 14, scale: 3 }).notNull(),
  condition: text('condition').$type<ReturnCondition>().notNull(),
  refundPesewas: integer('refund_pesewas').notNull(),
}, (t) => [
  foreignKey({ name: 'return_lines_return_fk', columns: [t.tenantId, t.returnId], foreignColumns: [returns.tenantId, returns.id] }),
  foreignKey({ name: 'return_lines_sale_line_fk', columns: [t.tenantId, t.saleLineId], foreignColumns: [saleLines.tenantId, saleLines.id] }),
  foreignKey({ name: 'return_lines_unit_fk', columns: [t.tenantId, t.variantId, t.unitId], foreignColumns: [variantUnits.tenantId, variantUnits.variantId, variantUnits.id] }),
  check('return_lines_quantity', sql`${t.quantity} > 0`),
  check('return_lines_condition', sql`${t.condition} in ('saleable', 'damaged', 'expired')`),
  check('return_lines_refund', sql`${t.refundPesewas} >= 0`),
]);

/** A manager's one-time approval of an action, bound to its context (spec 6.7). */
export const approvals = pgTable('approvals', {
  id: id(),
  tenantId: tenantId(),
  action: text('action').notNull(),
  contextKey: text('context_key').notNull(),
  tokenHash: text('token_hash').notNull(),
  requestedBy: uuid('requested_by').notNull(),
  approvedBy: uuid('approved_by').notNull(),
  expiresAt: timestamptz('expires_at').notNull(),
  usedAt: timestamptz('used_at'),
  createdAt: createdAt(),
}, (t) => [
  unique('approvals_token').on(t.tokenHash),
  foreignKey({ name: 'approvals_requested_by_fk', columns: [t.tenantId, t.requestedBy], foreignColumns: [users.tenantId, users.id] }),
  foreignKey({ name: 'approvals_approved_by_fk', columns: [t.tenantId, t.approvedBy], foreignColumns: [users.tenantId, users.id] }),
]);

export type CounterOrderLine = { variantId: string; unitId: string; quantity: string };
export type CounterOrderStatus = 'awaiting_payment' | 'paid' | 'cancelled';

/** Spec 6.39: an order built at one counter and paid at another; stock moves only when it is paid. */
export const counterOrders = pgTable('counter_orders', {
  id: id(),
  tenantId: tenantId(),
  branchId: uuid('branch_id').notNull(),
  orderNumber: text('order_number').notNull(), // 4 digits, per branch and business day
  businessDate: date('business_date', { mode: 'string' }).notNull(),
  lines: jsonb('lines').$type<CounterOrderLine[]>().notNull(),
  createdBy: uuid('created_by').notNull(),
  status: text('status').$type<CounterOrderStatus>().notNull().default('awaiting_payment'),
  saleId: uuid('sale_id'),
  expiresAt: timestamptz('expires_at').notNull(),
  createdAt: createdAt(),
}, (t) => [
  unique('counter_orders_tenant_id').on(t.tenantId, t.id),
  unique('counter_orders_number').on(t.tenantId, t.branchId, t.businessDate, t.orderNumber),
  check('counter_orders_status', sql`${t.status} in ('awaiting_payment', 'paid', 'cancelled')`),
  foreignKey({ name: 'counter_orders_branch_fk', columns: [t.tenantId, t.branchId], foreignColumns: [branches.tenantId, branches.id] }),
  foreignKey({ name: 'counter_orders_created_by_fk', columns: [t.tenantId, t.createdBy], foreignColumns: [users.tenantId, users.id] }),
  foreignKey({ name: 'counter_orders_sale_fk', columns: [t.tenantId, t.saleId], foreignColumns: [sales.tenantId, sales.id] }),
]);

/** Spec 6.36: the prescription behind a prescription-only sale line. Health data: only people who may dispense read it. */
export const prescriptions = pgTable('prescriptions', {
  id: id(),
  tenantId: tenantId(),
  saleId: uuid('sale_id').notNull(),
  saleLineId: uuid('sale_line_id').notNull(),
  patientName: text('patient_name').notNull(),
  prescriberName: text('prescriber_name').notNull(),
  facility: text('facility').notNull(),
  prescriptionDate: date('prescription_date', { mode: 'string' }).notNull(),
  recordedBy: uuid('recorded_by').notNull(),
  approvedBy: uuid('approved_by'), // the pharmacist whose PIN allowed it, when the seller could not dispense
  createdAt: createdAt(),
}, (t) => [
  unique('prescriptions_sale_line').on(t.tenantId, t.saleLineId),
  foreignKey({ name: 'prescriptions_sale_fk', columns: [t.tenantId, t.saleId], foreignColumns: [sales.tenantId, sales.id] }),
  foreignKey({ name: 'prescriptions_sale_line_fk', columns: [t.tenantId, t.saleLineId], foreignColumns: [saleLines.tenantId, saleLines.id] }),
  foreignKey({ name: 'prescriptions_recorded_by_fk', columns: [t.tenantId, t.recordedBy], foreignColumns: [users.tenantId, users.id] }),
  foreignKey({ name: 'prescriptions_approved_by_fk', columns: [t.tenantId, t.approvedBy], foreignColumns: [users.tenantId, users.id] }),
]);

export type CashMovementType = 'paid_in' | 'paid_out';

/** Cash put into or taken out of a till during a shift, with a reason (spec 6.14). */
export const cashMovements = pgTable('cash_movements', {
  id: id(),
  tenantId: tenantId(),
  shiftId: uuid('shift_id').notNull(),
  type: text('type').$type<CashMovementType>().notNull(),
  amountPesewas: integer('amount_pesewas').notNull(),
  reason: text('reason').notNull(),
  userId: uuid('user_id').notNull(),
  expenseId: uuid('expense_id'),
  createdAt: createdAt(),
}, (t) => [
  check('cash_movements_type', sql`${t.type} in ('paid_in', 'paid_out')`),
  check('cash_movements_amount', sql`${t.amountPesewas} > 0`),
  foreignKey({ name: 'cash_movements_shift_fk', columns: [t.tenantId, t.shiftId], foreignColumns: [shifts.tenantId, shifts.id] }),
  foreignKey({ name: 'cash_movements_user_fk', columns: [t.tenantId, t.userId], foreignColumns: [users.tenantId, users.id] }),
]);

export type ExpenseMethod = 'cash' | 'momo_manual' | 'card_terminal' | 'bank_transfer';

/** Spec 6.43: money the shop spent; a cash expense at a till with an open shift is also paid out of that shift. */
export const expenses = pgTable('expenses', {
  id: id(),
  tenantId: tenantId(),
  branchId: uuid('branch_id').notNull(),
  category: text('category').notNull(),
  amountPesewas: integer('amount_pesewas').notNull(),
  method: text('method').$type<ExpenseMethod>().notNull(),
  reference: text('reference'),
  note: text('note'),
  recordedBy: uuid('recorded_by').notNull(),
  approvedBy: uuid('approved_by'),
  shiftId: uuid('shift_id'),
  createdAt: createdAt(),
}, (t) => [
  unique('expenses_tenant_id').on(t.tenantId, t.id),
  check('expenses_amount', sql`${t.amountPesewas} > 0`),
  check('expenses_method', sql`${t.method} in ('cash', 'momo_manual', 'card_terminal', 'bank_transfer')`),
  check('expenses_reference', sql`${t.method} = 'cash' or ${t.reference} is not null`),
  foreignKey({ name: 'expenses_branch_fk', columns: [t.tenantId, t.branchId], foreignColumns: [branches.tenantId, branches.id] }),
  foreignKey({ name: 'expenses_recorded_by_fk', columns: [t.tenantId, t.recordedBy], foreignColumns: [users.tenantId, users.id] }),
  foreignKey({ name: 'expenses_approved_by_fk', columns: [t.tenantId, t.approvedBy], foreignColumns: [users.tenantId, users.id] }),
  foreignKey({ name: 'expenses_shift_fk', columns: [t.tenantId, t.shiftId], foreignColumns: [shifts.tenantId, shifts.id] }),
]);

export type LedgerType = 'sale' | 'payment' | 'return' | 'adjustment';

/** Spec 4.5, 6.13: what a customer owes on credit, entry by entry. Never edited; corrections are adjustments. */
export const customerLedger = pgTable('customer_ledger', {
  id: id(),
  tenantId: tenantId(),
  customerId: uuid('customer_id').notNull(),
  type: text('type').$type<LedgerType>().notNull(),
  amountPesewas: integer('amount_pesewas').notNull(), // + adds to what they owe, - reduces it
  balanceAfterPesewas: integer('balance_after_pesewas').notNull(),
  method: text('method'), // how a payment was made
  reference: text('reference'),
  saleId: uuid('sale_id'),
  returnId: uuid('return_id'),
  shiftId: uuid('shift_id'),
  reason: text('reason'),
  userId: uuid('user_id').notNull(),
  approvedBy: uuid('approved_by'),
  createdAt: createdAt(),
}, (t) => [
  index('customer_ledger_customer').on(t.tenantId, t.customerId, t.createdAt),
  check('customer_ledger_type', sql`${t.type} in ('sale', 'payment', 'return', 'adjustment')`),
  check('customer_ledger_amount', sql`${t.amountPesewas} <> 0 and ${t.balanceAfterPesewas} >= 0`),
  check('customer_ledger_method', sql`${t.method} is null or ${t.method} in ('cash', 'momo_manual', 'card_terminal', 'bank_transfer')`),
  foreignKey({ name: 'customer_ledger_customer_fk', columns: [t.tenantId, t.customerId], foreignColumns: [customers.tenantId, customers.id] }),
  foreignKey({ name: 'customer_ledger_sale_fk', columns: [t.tenantId, t.saleId], foreignColumns: [sales.tenantId, sales.id] }),
  foreignKey({ name: 'customer_ledger_return_fk', columns: [t.tenantId, t.returnId], foreignColumns: [returns.tenantId, returns.id] }),
  foreignKey({ name: 'customer_ledger_shift_fk', columns: [t.tenantId, t.shiftId], foreignColumns: [shifts.tenantId, shifts.id] }),
  foreignKey({ name: 'customer_ledger_user_fk', columns: [t.tenantId, t.userId], foreignColumns: [users.tenantId, users.id] }),
  foreignKey({ name: 'customer_ledger_approved_by_fk', columns: [t.tenantId, t.approvedBy], foreignColumns: [users.tenantId, users.id] }),
]);

export type QuoteLine = { variantId: string; unitId: string; name: string; unitName: string; quantity: string; unitPricePesewas: number; discountPesewas: number; taxRateBp: number; totalPesewas: number };
export type QuoteStatus = 'open' | 'converted' | 'cancelled';

/** Spec 4.22, 6.35: an itemised price offer valid until a date; converting it sells at these prices. */
export const quotes = pgTable('quotes', {
  id: id(),
  tenantId: tenantId(),
  branchId: uuid('branch_id').notNull(),
  number: text('number').notNull(), // Q-0001, per shop
  customerId: uuid('customer_id'),
  lines: jsonb('lines').$type<QuoteLine[]>().notNull(),
  subtotalPesewas: integer('subtotal_pesewas').notNull(),
  discountPesewas: integer('discount_pesewas').notNull(),
  taxPesewas: integer('tax_pesewas').notNull(),
  totalPesewas: integer('total_pesewas').notNull(),
  validUntil: date('valid_until', { mode: 'string' }).notNull(),
  status: text('status').$type<QuoteStatus>().notNull().default('open'),
  note: text('note'),
  shareCode: text('share_code').notNull().unique(),
  createdBy: uuid('created_by').notNull(),
  convertedSaleId: uuid('converted_sale_id'),
  createdAt: createdAt(),
}, (t) => [
  unique('quotes_tenant_id').on(t.tenantId, t.id),
  unique('quotes_number').on(t.tenantId, t.number),
  check('quotes_status', sql`${t.status} in ('open', 'converted', 'cancelled')`),
  foreignKey({ name: 'quotes_branch_fk', columns: [t.tenantId, t.branchId], foreignColumns: [branches.tenantId, branches.id] }),
  foreignKey({ name: 'quotes_customer_fk', columns: [t.tenantId, t.customerId], foreignColumns: [customers.tenantId, customers.id] }),
  foreignKey({ name: 'quotes_created_by_fk', columns: [t.tenantId, t.createdBy], foreignColumns: [users.tenantId, users.id] }),
  foreignKey({ name: 'quotes_sale_fk', columns: [t.tenantId, t.convertedSaleId], foreignColumns: [sales.tenantId, sales.id] }),
]);

/** Spec 4.22, 6.35: a credit sale to a business customer, due by a date; payments go through the customer's account. */
export const invoices = pgTable('invoices', {
  id: id(),
  tenantId: tenantId(),
  number: text('number').notNull(), // INV-0001, per shop
  saleId: uuid('sale_id').notNull(),
  customerId: uuid('customer_id').notNull(),
  quoteId: uuid('quote_id'),
  dueDate: date('due_date', { mode: 'string' }).notNull(),
  shareCode: text('share_code').notNull().unique(),
  createdBy: uuid('created_by').notNull(),
  createdAt: createdAt(),
}, (t) => [
  unique('invoices_number').on(t.tenantId, t.number),
  unique('invoices_sale').on(t.tenantId, t.saleId),
  foreignKey({ name: 'invoices_sale_fk', columns: [t.tenantId, t.saleId], foreignColumns: [sales.tenantId, sales.id] }),
  foreignKey({ name: 'invoices_customer_fk', columns: [t.tenantId, t.customerId], foreignColumns: [customers.tenantId, customers.id] }),
  foreignKey({ name: 'invoices_quote_fk', columns: [t.tenantId, t.quoteId], foreignColumns: [quotes.tenantId, quotes.id] }),
  foreignKey({ name: 'invoices_created_by_fk', columns: [t.tenantId, t.createdBy], foreignColumns: [users.tenantId, users.id] }),
]);

export type NotificationKind = 'report' | 'marketing';
export type NotificationStatus = 'queued' | 'sent' | 'failed' | 'blocked_quota';

/** Spec 4.8, 6.17: one SMS to one phone; the key makes a job that runs twice queue it once. */
export const notifications = pgTable('notifications', {
  id: id(),
  tenantId: tenantId(),
  key: text('key').notNull(),
  kind: text('kind').$type<NotificationKind>().notNull(),
  toPhone: text('to_phone').notNull(),
  body: text('body').notNull(),
  parts: integer('parts').notNull(),
  status: text('status').$type<NotificationStatus>().notNull().default('queued'),
  attempts: integer('attempts').notNull().default(0),
  error: text('error'),
  sendAfter: timestamptz('send_after').notNull(),
  sentAt: timestamptz('sent_at'),
  createdAt: createdAt(),
}, (t) => [
  unique('notifications_key').on(t.tenantId, t.key),
  index('notifications_queue').on(t.status, t.sendAfter),
  check('notifications_kind', sql`${t.kind} in ('report', 'marketing')`),
  check('notifications_status', sql`${t.status} in ('queued', 'sent', 'failed', 'blocked_quota')`),
]);

/** Spec 6.42: a phone that asked for no more promotional SMS from this shop. */
export const marketingOptOuts = pgTable('marketing_opt_outs', {
  tenantId: tenantId(),
  phone: text('phone').notNull(),
  createdAt: createdAt(),
}, (t) => [primaryKey({ name: 'marketing_opt_outs_pk', columns: [t.tenantId, t.phone] })]);

export type CampaignSegment = 'all' | 'recent' | 'lapsed';

/** Spec 4.25, 6.42: a promotional SMS sent to a segment of opted-in customers. */
export const smsCampaigns = pgTable('sms_campaigns', {
  id: id(),
  tenantId: tenantId(),
  segment: text('segment').$type<CampaignSegment>().notNull(),
  message: text('message').notNull(),
  recipients: integer('recipients').notNull(),
  parts: integer('parts').notNull(),
  sendAfter: timestamptz('send_after').notNull(),
  createdBy: uuid('created_by').notNull(),
  createdAt: createdAt(),
}, (t) => [
  check('sms_campaigns_segment', sql`${t.segment} in ('all', 'recent', 'lapsed')`),
  foreignKey({ name: 'sms_campaigns_created_by_fk', columns: [t.tenantId, t.createdBy], foreignColumns: [users.tenantId, users.id] }),
]);

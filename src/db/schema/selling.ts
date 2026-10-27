import { sql } from 'drizzle-orm';
import { bigint, boolean, check, date, foreignKey, index, integer, jsonb, numeric, pgTable, text, unique, uniqueIndex, uuid } from 'drizzle-orm/pg-core';
import { createdAt, id, timestamptz } from './columns';
import { priceLists, variants } from './catalogue';
import { users } from './people';
import { branches, registers, tenants } from './tenancy';

export type TenderMethod = 'cash' | 'momo_manual' | 'card_terminal' | 'bank_transfer' | 'store_credit' | 'channel_settlement';
export type SaleStatus = 'pending' | 'completed';
export type SaleLineChoice = { slotId: string; variantId: string; name: string; upgradePesewas: number };
export type SaleLineAddOn = { groupId: string; optionId: string; name: string; pricePesewas: number };
export const TENDER_METHODS: readonly TenderMethod[] = ['cash', 'momo_manual', 'card_terminal', 'bank_transfer', 'store_credit', 'channel_settlement'];
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
  createdAt: createdAt(),
}, (t) => [
  unique('customers_tenant_id').on(t.tenantId, t.id),
  unique('customers_phone').on(t.tenantId, t.phone),
  foreignKey({ name: 'customers_price_list_fk', columns: [t.tenantId, t.priceListId], foreignColumns: [priceLists.tenantId, priceLists.id] }),
  check('customers_store_credit', sql`${t.storeCreditPesewas} >= 0`),
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
  serviceMode: text('service_mode').$type<'counter' | 'quick'>(), // food sales only
  diningOption: text('dining_option').$type<'eat_in' | 'takeaway' | 'delivery'>(),
  orderNumber: text('order_number'),
  channelId: uuid('channel_id'), // delivery app, phone, or WhatsApp; null for walk-in (spec 6.57)
  externalOrderId: text('external_order_id'), // the platform order ID
  commissionPesewas: integer('commission_pesewas').notNull().default(0),
}, (t) => [
  unique('sales_tenant_id').on(t.tenantId, t.id),
  unique('sales_receipt_number').on(t.tenantId, t.receiptNumber),
  index('sales_business_date').on(t.tenantId, t.businessDate),
  check('sales_service_mode', sql`${t.serviceMode} in ('counter', 'quick')`),
  check('sales_dining_option', sql`${t.diningOption} in ('eat_in', 'takeaway', 'delivery')`),
  uniqueIndex('sales_channel_order').on(t.tenantId, t.channelId, t.externalOrderId).where(sql`${t.externalOrderId} is not null`),
  check('sales_external_order', sql`${t.externalOrderId} is null or ${t.channelId} is not null`),
  check('sales_commission', sql`${t.commissionPesewas} >= 0`),
  foreignKey({ name: 'sales_channel_fk', columns: [t.tenantId, t.channelId], foreignColumns: [salesChannels.tenantId, salesChannels.id] }),
  foreignKey({ name: 'sales_branch_fk', columns: [t.tenantId, t.branchId], foreignColumns: [branches.tenantId, branches.id] }),
  foreignKey({ name: 'sales_register_fk', columns: [t.tenantId, t.registerId], foreignColumns: [registers.tenantId, registers.id] }),
  foreignKey({ name: 'sales_cashier_fk', columns: [t.tenantId, t.cashierId], foreignColumns: [users.tenantId, users.id] }),
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
  check('payments_method', sql`${t.method} in ('cash', 'momo_manual', 'card_terminal', 'bank_transfer', 'store_credit', 'channel_settlement')`),
  check('payments_reference', sql`${t.method} in ('cash', 'store_credit') or ${t.reference} is not null`),
  check('payments_amount', sql`${t.amountPesewas} > 0`),
  check('payments_status', sql`${t.status} in ('confirmed', 'pending')`),
]);

import { sql } from 'drizzle-orm';
import { boolean, check, date, foreignKey, index, integer, jsonb, pgTable, primaryKey, text, unique, uniqueIndex, uuid } from 'drizzle-orm/pg-core';
import { createdAt, id, timestamptz } from './columns';
import { users } from './people';
import { customers, sales } from './selling';
import { branches, registers, tenants } from './tenancy';

// Spec 4.20, 4.21, 4.28, 6.29-6.34, 6.41, 6.50: promotions, loyalty, gift cards, layaway and special orders, commissions, the customer display.

const tenantId = () => uuid('tenant_id').notNull().references(() => tenants.id);

export type PromotionKind = 'percent_off' | 'amount_off' | 'buy_x_get_y' | 'multi_buy' | 'cart_percent' | 'cart_amount';

export const promotions = pgTable('promotions', {
  id: id(),
  tenantId: tenantId(),
  name: text('name').notNull(),
  kind: text('kind').$type<PromotionKind>().notNull(),
  productIds: uuid('product_ids').array().notNull().default(sql`'{}'`), // empty with no categories = every product
  categoryIds: uuid('category_ids').array().notNull().default(sql`'{}'`),
  percentBp: integer('percent_bp'), // percent_off, cart_percent, and the "get" units of buy_x_get_y (10000 = free)
  amountPesewas: integer('amount_pesewas'), // amount_off per unit, cart_amount
  buyQty: integer('buy_qty'),
  getQty: integer('get_qty'),
  groupQty: integer('group_qty'), // multi_buy: N for groupPricePesewas
  groupPricePesewas: integer('group_price_pesewas'),
  minSubtotalPesewas: integer('min_subtotal_pesewas').notNull().default(0), // cart promotions
  startsOn: date('starts_on', { mode: 'string' }),
  endsOn: date('ends_on', { mode: 'string' }),
  days: integer('days').array().notNull().default(sql`'{}'`), // 0 = Sunday; empty = every day
  startTime: text('start_time'), // happy hour 'HH:MM'
  endTime: text('end_time'),
  branchIds: uuid('branch_ids').array().notNull().default(sql`'{}'`), // empty = every branch
  stackable: boolean('stackable').notNull().default(false),
  requiresCoupon: boolean('requires_coupon').notNull().default(false),
  active: boolean('active').notNull().default(true),
  createdAt: createdAt(),
}, (t) => [
  unique('promotions_tenant_id').on(t.tenantId, t.id),
  check('promotions_kind', sql`${t.kind} in ('percent_off', 'amount_off', 'buy_x_get_y', 'multi_buy', 'cart_percent', 'cart_amount')`),
  check('promotions_numbers', sql`coalesce(${t.percentBp}, 0) between 0 and 10000 and coalesce(${t.amountPesewas}, 0) >= 0 and coalesce(${t.buyQty}, 1) >= 1 and coalesce(${t.getQty}, 1) >= 1 and coalesce(${t.groupQty}, 2) >= 2 and coalesce(${t.groupPricePesewas}, 0) >= 0`),
]);

export const coupons = pgTable('coupons', {
  id: id(),
  tenantId: tenantId(),
  code: text('code').notNull(), // upper case
  promotionId: uuid('promotion_id').notNull(),
  maxUses: integer('max_uses'), // null = no limit; 1 = single use
  perCustomerLimit: integer('per_customer_limit'),
  usedCount: integer('used_count').notNull().default(0),
  expiresOn: date('expires_on', { mode: 'string' }),
  active: boolean('active').notNull().default(true),
  createdAt: createdAt(),
}, (t) => [
  unique('coupons_tenant_id').on(t.tenantId, t.id),
  unique('coupons_code').on(t.tenantId, t.code),
  foreignKey({ name: 'coupons_promotion_fk', columns: [t.tenantId, t.promotionId], foreignColumns: [promotions.tenantId, promotions.id] }),
]);

/** A coupon is used up only when its sale completes (spec 6.29). */
export const couponUses = pgTable('coupon_uses', {
  tenantId: tenantId(),
  couponId: uuid('coupon_id').notNull(),
  saleId: uuid('sale_id').notNull(),
  customerId: uuid('customer_id'),
  createdAt: createdAt(),
}, (t) => [
  primaryKey({ name: 'coupon_uses_pk', columns: [t.tenantId, t.couponId, t.saleId] }),
  foreignKey({ name: 'coupon_uses_coupon_fk', columns: [t.tenantId, t.couponId], foreignColumns: [coupons.tenantId, coupons.id] }),
  foreignKey({ name: 'coupon_uses_sale_fk', columns: [t.tenantId, t.saleId], foreignColumns: [sales.tenantId, sales.id] }),
]);

export type LoyaltyEntryType = 'earned' | 'redeemed' | 'reversed' | 'expired';

export const loyaltyEntries = pgTable('loyalty_entries', {
  id: id(),
  tenantId: tenantId(),
  customerId: uuid('customer_id').notNull(),
  type: text('type').$type<LoyaltyEntryType>().notNull(),
  points: integer('points').notNull(), // signed
  saleId: uuid('sale_id'),
  expiryChecked: boolean('expiry_checked').notNull().default(false), // earned entries already looked at by the expiry job
  createdAt: createdAt(),
}, (t) => [
  index('loyalty_entries_customer').on(t.tenantId, t.customerId, t.createdAt),
  check('loyalty_entries_type', sql`${t.type} in ('earned', 'redeemed', 'reversed', 'expired')`),
  foreignKey({ name: 'loyalty_entries_customer_fk', columns: [t.tenantId, t.customerId], foreignColumns: [customers.tenantId, customers.id] }),
]);

export const giftCards = pgTable('gift_cards', {
  id: id(),
  tenantId: tenantId(),
  codeHash: text('code_hash').notNull().unique(), // sha256 of the code; lookups never need the code stored in the clear
  codeSealed: text('code_sealed').notNull(), // encrypted, so the receipt can print it again
  last4: text('last4').notNull(),
  initialPesewas: integer('initial_pesewas').notNull(),
  balancePesewas: integer('balance_pesewas').notNull(),
  expiresOn: date('expires_on', { mode: 'string' }),
  saleId: uuid('sale_id'),
  status: text('status').$type<'active' | 'void'>().notNull().default('active'),
  createdAt: createdAt(),
}, (t) => [
  unique('gift_cards_tenant_id').on(t.tenantId, t.id),
  check('gift_cards_balance', sql`${t.balancePesewas} between 0 and ${t.initialPesewas}`),
  check('gift_cards_status', sql`${t.status} in ('active', 'void')`),
]);

export const giftCardEntries = pgTable('gift_card_entries', {
  id: id(),
  tenantId: tenantId(),
  giftCardId: uuid('gift_card_id').notNull(),
  type: text('type').$type<'issued' | 'redeemed'>().notNull(),
  amountPesewas: integer('amount_pesewas').notNull(),
  saleId: uuid('sale_id'),
  createdAt: createdAt(),
}, (t) => [
  check('gift_card_entries_type', sql`${t.type} in ('issued', 'redeemed')`),
  foreignKey({ name: 'gift_card_entries_card_fk', columns: [t.tenantId, t.giftCardId], foreignColumns: [giftCards.tenantId, giftCards.id] }),
]);

export type OrderLine = { variantId: string; unitId: string; name: string; unitName: string; quantity: string; baseQuantity: string; unitPricePesewas: number; totalPesewas: number };
export type CustomerOrderStatus = 'open' | 'ready' | 'collected' | 'cancelled';

/** Spec 6.34: layaway (items reserved, paid in parts) and special orders (items not in stock yet). */
export const customerOrders = pgTable('customer_orders', {
  id: id(),
  tenantId: tenantId(),
  branchId: uuid('branch_id').notNull(),
  number: text('number').notNull(), // LA-0001, SO-0001
  kind: text('kind').$type<'layaway' | 'special'>().notNull(),
  status: text('status').$type<CustomerOrderStatus>().notNull().default('open'),
  customerId: uuid('customer_id').notNull(),
  lines: jsonb('lines').$type<OrderLine[]>().notNull(),
  totalPesewas: integer('total_pesewas').notNull(),
  paidPesewas: integer('paid_pesewas').notNull().default(0),
  dueDate: date('due_date', { mode: 'string' }),
  note: text('note'),
  saleId: uuid('sale_id'),
  createdBy: uuid('created_by').notNull(),
  createdAt: createdAt(),
}, (t) => [
  unique('customer_orders_tenant_id').on(t.tenantId, t.id),
  unique('customer_orders_number').on(t.tenantId, t.number),
  check('customer_orders_kind', sql`${t.kind} in ('layaway', 'special')`),
  check('customer_orders_status', sql`${t.status} in ('open', 'ready', 'collected', 'cancelled')`),
  check('customer_orders_paid', sql`${t.paidPesewas} >= 0`),
  foreignKey({ name: 'customer_orders_branch_fk', columns: [t.tenantId, t.branchId], foreignColumns: [branches.tenantId, branches.id] }),
  foreignKey({ name: 'customer_orders_customer_fk', columns: [t.tenantId, t.customerId], foreignColumns: [customers.tenantId, customers.id] }),
]);

/** Money held for a customer order: deposits and part payments (+), refunds on cancellation (−). Not a sale until collected. */
export const orderPayments = pgTable('order_payments', {
  id: id(),
  tenantId: tenantId(),
  orderId: uuid('order_id').notNull(),
  method: text('method').notNull(),
  amountPesewas: integer('amount_pesewas').notNull(),
  reference: text('reference'),
  shiftId: uuid('shift_id'),
  createdBy: uuid('created_by').notNull(),
  createdAt: createdAt(),
}, (t) => [
  check('order_payments_amount', sql`${t.amountPesewas} <> 0`),
  check('order_payments_method', sql`${t.method} in ('cash', 'momo_manual', 'card_terminal', 'bank_transfer', 'store_credit', 'fee')`),
  foreignKey({ name: 'order_payments_order_fk', columns: [t.tenantId, t.orderId], foreignColumns: [customerOrders.tenantId, customerOrders.id] }),
]);

/** Spec 6.41: the most specific active rule wins: product, then category, then the person, then the shop default (all empty). */
export const commissionRules = pgTable('commission_rules', {
  id: id(),
  tenantId: tenantId(),
  userId: uuid('user_id'),
  productId: uuid('product_id'),
  categoryId: uuid('category_id'),
  percentBp: integer('percent_bp'),
  fixedPesewas: integer('fixed_pesewas'), // per unit sold
  active: boolean('active').notNull().default(true),
  createdAt: createdAt(),
}, (t) => [
  check('commission_rules_amount', sql`(${t.percentBp} is null) <> (${t.fixedPesewas} is null) and coalesce(${t.percentBp}, 0) between 0 and 10000 and coalesce(${t.fixedPesewas}, 0) >= 0`),
]);

export const commissionEntries = pgTable('commission_entries', {
  id: id(),
  tenantId: tenantId(),
  userId: uuid('user_id').notNull(),
  saleId: uuid('sale_id').notNull(),
  saleLineId: uuid('sale_line_id').notNull(),
  returnId: uuid('return_id'),
  amountPesewas: integer('amount_pesewas').notNull(), // negative for returns
  paidAt: timestamptz('paid_at'),
  createdAt: createdAt(),
}, (t) => [
  index('commission_entries_user').on(t.tenantId, t.userId, t.createdAt),
  foreignKey({ name: 'commission_entries_user_fk', columns: [t.tenantId, t.userId], foreignColumns: [users.tenantId, users.id] }),
]);

/** Spec 6.50: a screen paired to one register; it can read only that register's current cart. */
export const customerDisplays = pgTable('customer_displays', {
  id: id(),
  tenantId: tenantId(),
  registerId: uuid('register_id').notNull(),
  tokenHash: text('token_hash').notNull().unique(),
  createdAt: createdAt(),
}, (t) => [foreignKey({ name: 'customer_displays_register_fk', columns: [t.tenantId, t.registerId], foreignColumns: [registers.tenantId, registers.id] })]);

export type DisplayCart = { lines: Array<{ name: string; quantity: string; totalPesewas: number }>; discountPesewas: number; totalPesewas: number; paidPesewas: number; changePesewas: number };

export const cartSnapshots = pgTable('cart_snapshots', {
  tenantId: tenantId(),
  registerId: uuid('register_id').notNull(),
  cart: jsonb('cart').$type<DisplayCart | null>(),
  updatedAt: timestamptz('updated_at').notNull().defaultNow(),
}, (t) => [primaryKey({ name: 'cart_snapshots_pk', columns: [t.tenantId, t.registerId] })]);

/** A short pairing code shown on the till, valid 10 minutes. */
export const displayPairings = pgTable('display_pairings', {
  tenantId: tenantId(),
  registerId: uuid('register_id').notNull(),
  code: text('code').notNull(),
  expiresAt: timestamptz('expires_at').notNull(),
}, (t) => [primaryKey({ name: 'display_pairings_pk', columns: [t.tenantId, t.registerId] }), uniqueIndex('display_pairings_code').on(t.code)]);

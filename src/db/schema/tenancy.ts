import { sql } from 'drizzle-orm';
import { bigint, boolean, check, date, integer, jsonb, pgTable, primaryKey, text, unique, uuid } from 'drizzle-orm/pg-core';
import type { ScaleLayout } from '@/lib/barcode';
import type { ShopType } from '@/lib/permissions';
import type { SubscriptionStatus } from '@/lib/subscription';
import { createdAt, id, timestamptz } from './columns';
import { plans, platformAdmins } from './platform';

/** The storefront's shop section (spec 4.12). */
export type StorefrontSettings = {
  about: string; whatsapp: string; hours: string; themeColor: string; facebook: string; instagram: string;
  showPrices: boolean; showStock: boolean; announcement: string; announcementUntil: string;
};

export const tenants = pgTable('tenants', {
  id: id(),
  slug: text('slug').notNull().unique(),
  name: text('name').notNull(),
  shopType: text('shop_type').$type<ShopType>().notNull(),
  modules: text('modules').array().notNull().default(sql`'{}'`),
  status: text('status').$type<'active' | 'suspended' | 'closed'>().notNull().default('active'),
  timezone: text('timezone').notNull().default('Africa/Accra'),
  currency: text('currency').notNull().default('GHS'),
  taxMode: text('tax_mode').$type<'inclusive' | 'exclusive'>().notNull().default('inclusive'),
  businessDayCutoff: text('business_day_cutoff').notNull().default('00:00'),
  address: text('address'),
  phone: text('phone'),
  managerPhone: text('manager_phone'),
  taxEnabled: boolean('tax_enabled').notNull().default(false),
  scaleBarcode: jsonb('scale_barcode').$type<ScaleLayout>(), // null = no scale labels
  offlineEnabled: boolean('offline_enabled').notNull().default(true), // spec 4.9: a shop can switch offline selling off
  allowNegativeStock: boolean('allow_negative_stock').notNull().default(true), // spec 4.1: sell past zero and alert, unless the shop blocks it
  taxNumber: text('tax_number'), // TIN or VAT number printed on receipts
  receiptFooter: text('receipt_footer'), // return policy text
  serviceChargeBp: integer('service_charge_bp').notNull().default(0), // table service charge, 0 = off (spec 4.24)
  refundLimitPesewas: integer('refund_limit_pesewas').notNull().default(0), // refunds above this need a manager unless the user may refund freely (spec 6.12)
  allowNoReceiptReturns: boolean('allow_no_receipt_returns').notNull().default(false),
  noReceiptMonthlyLimit: integer('no_receipt_monthly_limit').notNull().default(2),
  cashRoundingStep: integer('cash_rounding_step').notNull().default(0), // pesewas cash totals round to, 0 = off (spec 6.40)
  counterOrderExpiryMinutes: integer('counter_order_expiry_minutes').notNull().default(120), // unpaid counter orders lapse after this (spec 6.39)
  otcOnly: boolean('otc_only').notNull().default(false), // licensed chemical seller: no prescription-only medicine (spec 4.23)
  expiryWarningDays: integer('expiry_warning_days').notNull().default(90), // near-expiry window (spec 4.17)
  requireShifts: boolean('require_shifts').notNull().default(false), // sales need an open shift at the till (spec 4.6)
  cashVarianceLimitPesewas: integer('cash_variance_limit_pesewas').notNull().default(0), // closing variance a cashier may leave without a manager
  expenseApprovalLimitPesewas: integer('expense_approval_limit_pesewas').notNull().default(0), // expenses above this need a manager (spec 6.43)
  loyaltyEnabled: boolean('loyalty_enabled').notNull().default(false), // spec 6.30
  pesewasPerPoint: integer('pesewas_per_point').notNull().default(100), // money spent per point earned
  pointValuePesewas: integer('point_value_pesewas').notNull().default(1), // what one point is worth when spent
  minRedeemPoints: integer('min_redeem_points').notNull().default(100),
  pointsExpiryMonths: integer('points_expiry_months').notNull().default(0), // 0 = never
  giftCardExpiryMonths: integer('gift_card_expiry_months').notNull().default(0), // 0 = never
  layawayMinDepositPercent: integer('layaway_min_deposit_percent').notNull().default(20),
  orderCancellationFeePesewas: integer('order_cancellation_fee_pesewas').notNull().default(0),
  orderRefundAs: text('order_refund_as').$type<'store_credit' | 'cash'>().notNull().default('store_credit'),
  momoNumber: text('momo_number'), // shown on the customer display (spec 4.28)
  countApprovalLimitPesewas: integer('count_approval_limit_pesewas').notNull().default(0), // count differences above this value need a manager (6.26)
  adjustmentApprovalLimitPesewas: integer('adjustment_approval_limit_pesewas').notNull().default(0),
  reorderCoverDays: integer('reorder_cover_days').notNull().default(14), // suggested orders cover lead time plus this many days (6.24)
  smsReports: boolean('sms_reports').notNull().default(false), // daily sales and weekly stock SMS to the manager phone (spec 4.8)
  reportTime: text('report_time').notNull().default('21:00'), // shop time the daily report goes out
  weeklyReportDay: integer('weekly_report_day').notNull().default(1), // 0 = Sunday ... 6 = Saturday
  storefrontPublished: boolean('storefront_published').notNull().default(false), // spec 4.12: hidden until the owner publishes
  storefrontTakenDown: boolean('storefront_taken_down').notNull().default(false), // set by the platform for terms breaches
  storefront: jsonb('storefront').$type<StorefrontSettings>().notNull().default(sql`'{"about":"","whatsapp":"","hours":"","themeColor":"#1e40af","facebook":"","instagram":"","showPrices":true,"showStock":true,"announcement":"","announcementUntil":""}'::jsonb`),
  paystackSecretSealed: text('paystack_secret_sealed'), // spec 6.11: the shop's own Paystack secret key, sealed; sales money settles to the shop
  paystackKeyHint: text('paystack_key_hint'), // e.g. sk_live_…a1b2, shown in settings
  onlineOrdersEnabled: boolean('online_orders_enabled').notNull().default(false), // spec 6.49
  onlineOrderExpiryMinutes: integer('online_order_expiry_minutes').notNull().default(60), // unpaid online orders lapse and release stock
  deliveryFeePesewas: integer('delivery_fee_pesewas').notNull().default(0),
  transferInstructions: text('transfer_instructions'), // bank or MoMo details shown to visitors paying by transfer
  createdAt: createdAt(),
}, (t) => [
  check('tenants_online_order_expiry', sql`${t.onlineOrderExpiryMinutes} between 10 and 10080`),
  check('tenants_service_charge', sql`${t.serviceChargeBp} between 0 and 2500`),
  check('tenants_cash_rounding', sql`${t.cashRoundingStep} in (0, 5, 10, 50, 100)`),
  check('tenants_counter_order_expiry', sql`${t.counterOrderExpiryMinutes} between 5 and 1440`),
  check('tenants_expiry_warning', sql`${t.expiryWarningDays} between 1 and 365`),
  check('tenants_weekly_report_day', sql`${t.weeklyReportDay} between 0 and 6`),
  check('tenants_shop_type', sql`${t.shopType} in ('retail', 'pharmacy', 'food')`),
  check('tenants_status', sql`${t.status} in ('active', 'suspended', 'closed')`),
  check('tenants_tax_mode', sql`${t.taxMode} in ('inclusive', 'exclusive')`),
]);

export const subscriptions = pgTable('subscriptions', {
  id: id(),
  tenantId: uuid('tenant_id').notNull().unique().references(() => tenants.id),
  planId: text('plan_id').notNull().references(() => plans.id),
  status: text('status').$type<SubscriptionStatus>().notNull(),
  endDate: date('end_date', { mode: 'string' }).notNull(),
  graceDays: integer('grace_days').notNull().default(14),
  autoRenew: boolean('auto_renew').notNull().default(false),
  authorizationCode: text('authorization_code'), // sealed Paystack card authorisation for renewal; never card numbers (spec 5)
  cardLabel: text('card_label'), // e.g. "visa ending 4081", for the owner
  billingEmail: text('billing_email'), // the email Paystack knows the card by
  updatedAt: timestamptz('updated_at').notNull().defaultNow(),
}, (t) => [check('subscriptions_status', sql`${t.status} in ('trial', 'active', 'cancelled')`)]);

export const subscriptionPayments = pgTable('subscription_payments', {
  id: id(),
  tenantId: uuid('tenant_id').notNull().references(() => tenants.id),
  method: text('method').$type<'momo' | 'bank_transfer' | 'cash' | 'card_terminal' | 'paystack'>().notNull(),
  reference: text('reference').notNull().unique(),
  amountPesewas: integer('amount_pesewas').notNull(),
  periodMonths: integer('period_months').notNull(),
  planId: text('plan_id').notNull().references(() => plans.id),
  recordedBy: uuid('recorded_by').references(() => platformAdmins.id),
  createdAt: createdAt(),
}, (t) => [
  check('subscription_payments_method', sql`${t.method} in ('momo', 'bank_transfer', 'cash', 'card_terminal', 'paystack')`),
  check('subscription_payments_amount', sql`${t.amountPesewas} > 0`),
  check('subscription_payments_period', sql`${t.periodMonths} between 1 and 36`),
]);

export type CheckoutStatus = 'pending' | 'applied' | 'failed' | 'mismatch';

/** Spec 6.20: a Paystack payment the platform is waiting on; applied once, by reference, after server-side verification. */
export const subscriptionCheckouts = pgTable('subscription_checkouts', {
  id: id(),
  tenantId: uuid('tenant_id').notNull().references(() => tenants.id),
  reference: text('reference').notNull().unique(),
  planId: text('plan_id').notNull().references(() => plans.id),
  amountPesewas: integer('amount_pesewas').notNull(),
  periodMonths: integer('period_months').notNull(),
  kind: text('kind').$type<'checkout' | 'renewal'>().notNull(),
  status: text('status').$type<CheckoutStatus>().notNull().default('pending'),
  autoRenew: boolean('auto_renew').notNull().default(false),
  consentText: text('consent_text'), // the exact wording the owner agreed to (spec 6.20)
  consentBy: uuid('consent_by'),
  failureReason: text('failure_reason'),
  createdAt: createdAt(),
  appliedAt: timestamptz('applied_at'),
}, (t) => [
  check('subscription_checkouts_kind', sql`${t.kind} in ('checkout', 'renewal')`),
  check('subscription_checkouts_status', sql`${t.status} in ('pending', 'applied', 'failed', 'mismatch')`),
  check('subscription_checkouts_amount', sql`${t.amountPesewas} > 0`),
]);

export const branches = pgTable('branches', {
  id: id(),
  tenantId: uuid('tenant_id').notNull().references(() => tenants.id),
  name: text('name').notNull(),
  branchCode: text('branch_code').notNull(),
  serviceModes: text('service_modes').array().notNull().default(sql`'{}'`), // food: 'counter' | 'table' | 'quick' (spec 4.24)
  boardTokenHash: text('board_token_hash').unique(), // sha256 of the Ready board link token
  address: text('address'),
  phone: text('phone'),
  createdAt: createdAt(),
}, (t) => [
  unique('branches_code').on(t.tenantId, t.branchCode),
  check('branches_service_modes', sql`${t.serviceModes} <@ array['counter', 'table', 'quick']::text[]`),
  unique('branches_tenant_id').on(t.tenantId, t.id), // target of composite foreign keys
]);

export const registers = pgTable('registers', {
  id: id(),
  tenantId: uuid('tenant_id').notNull().references(() => tenants.id),
  branchId: uuid('branch_id').notNull().references(() => branches.id),
  name: text('name').notNull(),
  registerCode: text('register_code').notNull(),
  receiptCounter: bigint('receipt_counter', { mode: 'number' }).notNull().default(0),
  deviceTokenHash: text('device_token_hash').unique(),
  deviceRegisteredAt: timestamptz('device_registered_at'),
  status: text('status').$type<'active' | 'retired'>().notNull().default('active'),
  createdAt: createdAt(),
}, (t) => [
  unique('registers_code').on(t.tenantId, t.registerCode),
  unique('registers_tenant_id').on(t.tenantId, t.id), // target of composite foreign keys
  check('registers_status', sql`${t.status} in ('active', 'retired')`),
]);

/** Spec 4.12: storefront visits and clicks per day, counts only (no personal data). Keys: view, product:<id>, whatsapp[:<id>], call[:<id>]. */
export const storefrontStats = pgTable('storefront_stats', {
  tenantId: uuid('tenant_id').notNull().references(() => tenants.id),
  day: date('day', { mode: 'string' }).notNull(),
  key: text('key').notNull(),
  count: integer('count').notNull(),
}, (t) => [primaryKey({ name: 'storefront_stats_pk', columns: [t.tenantId, t.day, t.key] })]);

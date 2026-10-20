import { sql } from 'drizzle-orm';
import { bigint, boolean, check, date, integer, jsonb, pgTable, text, unique, uuid } from 'drizzle-orm/pg-core';
import type { ScaleLayout } from '@/lib/barcode';
import type { ShopType } from '@/lib/permissions';
import type { SubscriptionStatus } from '@/lib/subscription';
import { createdAt, id, timestamptz } from './columns';
import { plans, platformAdmins } from './platform';

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
  createdAt: createdAt(),
}, (t) => [
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

export const branches = pgTable('branches', {
  id: id(),
  tenantId: uuid('tenant_id').notNull().references(() => tenants.id),
  name: text('name').notNull(),
  branchCode: text('branch_code').notNull(),
  address: text('address'),
  phone: text('phone'),
  createdAt: createdAt(),
}, (t) => [
  unique('branches_code').on(t.tenantId, t.branchCode),
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
  check('registers_status', sql`${t.status} in ('active', 'retired')`),
]);

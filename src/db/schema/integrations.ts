import { sql } from 'drizzle-orm';
import { boolean, check, foreignKey, index, integer, jsonb, pgTable, text, unique, uuid } from 'drizzle-orm/pg-core';
import { createdAt, id, timestamptz } from './columns';
import type { OrderLine } from './growth';
import { branches, tenants } from './tenancy';

// Phase 6 (spec 4.12, 4.29, 6.11, 6.49): payments on the shop's own Paystack account, storefront online orders, API keys and outgoing webhooks, custom domains.

const tenantId = () => uuid('tenant_id').notNull().references(() => tenants.id);

export type ChargeStatus = 'pending' | 'success' | 'failed' | 'mismatch';
/** The sale a till charge completes once Paystack confirms it (prices were checked when the charge started). */
export type ChargeSale = {
  registerId: string; userId: string; customerId: string | null;
  lines: Array<{ variantId: string; unitId: string; quantity: string; unitPricePesewas: number; discountPesewas: number }>;
};

/** A Paystack charge on the shop's own account: a till sale or an online order. Money settles to the shop; the platform never holds it. */
export const shopCharges = pgTable('shop_charges', {
  id: id(),
  tenantId: tenantId(),
  reference: text('reference').notNull().unique(),
  purpose: text('purpose').$type<'till' | 'online_order'>().notNull(),
  amountPesewas: integer('amount_pesewas').notNull(),
  status: text('status').$type<ChargeStatus>().notNull().default('pending'),
  sale: jsonb('sale').$type<ChargeSale>(), // till charges only
  orderId: uuid('order_id'), // online orders only
  saleId: uuid('sale_id'),
  channel: text('channel'), // card or mobile_money, from Paystack's verification
  authorizationUrl: text('authorization_url'),
  createdAt: createdAt(),
  completedAt: timestamptz('completed_at'),
}, (t) => [
  check('shop_charges_purpose', sql`${t.purpose} in ('till', 'online_order')`),
  check('shop_charges_status', sql`${t.status} in ('pending', 'success', 'failed', 'mismatch')`),
  check('shop_charges_amount', sql`${t.amountPesewas} > 0`),
]);

export type OnlineOrderStatus = 'awaiting_payment' | 'proof_uploaded' | 'confirmed' | 'ready' | 'out_for_delivery' | 'completed' | 'cancelled' | 'expired';
export type OrderSource = 'storefront' | 'whatsapp' | 'instagram' | 'facebook' | 'walk_in';

/** Spec 6.49: an order placed on the storefront; stock is reserved until it is paid and collected, or it expires. */
export const onlineOrders = pgTable('online_orders', {
  id: id(),
  tenantId: tenantId(),
  branchId: uuid('branch_id').notNull(),
  number: text('number').notNull(), // WEB-0001
  status: text('status').$type<OnlineOrderStatus>().notNull().default('awaiting_payment'),
  source: text('source').$type<OrderSource>().notNull().default('storefront'),
  fulfilment: text('fulfilment').$type<'pickup' | 'delivery'>().notNull(),
  contactName: text('contact_name').notNull(),
  contactPhone: text('contact_phone').notNull(),
  deliveryAddress: text('delivery_address'),
  note: text('note'),
  lines: jsonb('lines').$type<OrderLine[]>().notNull(),
  deliveryFeePesewas: integer('delivery_fee_pesewas').notNull().default(0),
  totalPesewas: integer('total_pesewas').notNull(),
  payMethod: text('pay_method').$type<'paystack' | 'transfer'>().notNull(),
  paidPesewas: integer('paid_pesewas').notNull().default(0),
  paymentReference: text('payment_reference'),
  proofKey: text('proof_key'), // private image store key of the transfer proof
  expiresAt: timestamptz('expires_at').notNull(),
  saleId: uuid('sale_id'),
  ip: text('ip'),
  createdAt: createdAt(),
}, (t) => [
  unique('online_orders_tenant_id').on(t.tenantId, t.id),
  unique('online_orders_number').on(t.tenantId, t.number),
  index('online_orders_phone').on(t.tenantId, t.contactPhone),
  check('online_orders_status', sql`${t.status} in ('awaiting_payment', 'proof_uploaded', 'confirmed', 'ready', 'out_for_delivery', 'completed', 'cancelled', 'expired')`),
  check('online_orders_source', sql`${t.source} in ('storefront', 'whatsapp', 'instagram', 'facebook', 'walk_in')`),
  check('online_orders_fulfilment', sql`${t.fulfilment} in ('pickup', 'delivery')`),
  check('online_orders_pay_method', sql`${t.payMethod} in ('paystack', 'transfer')`),
  foreignKey({ name: 'online_orders_branch_fk', columns: [t.tenantId, t.branchId], foreignColumns: [branches.tenantId, branches.id] }),
]);

/** Spec 6.49: a visitor proves their phone with an SMS code before the first order; the token then stays on that browser. */
export const phoneVerifications = pgTable('phone_verifications', {
  id: id(),
  tenantId: tenantId(),
  phone: text('phone').notNull(),
  codeHash: text('code_hash').notNull(),
  attempts: integer('attempts').notNull().default(0),
  expiresAt: timestamptz('expires_at').notNull(),
  tokenHash: text('token_hash').unique(), // set once the code is right
  verifiedAt: timestamptz('verified_at'),
  createdAt: createdAt(),
}, (t) => [index('phone_verifications_phone').on(t.tenantId, t.phone)]);

export const API_SCOPES = ['products:read', 'stock:read', 'sales:read', 'orders:read'] as const;
export type ApiScope = (typeof API_SCOPES)[number];

/** Spec 4.29: per-shop API keys; only a hash is kept, the prefix finds the key. */
export const apiKeys = pgTable('api_keys', {
  id: id(),
  tenantId: tenantId(),
  name: text('name').notNull(),
  prefix: text('prefix').notNull().unique(),
  keyHash: text('key_hash').notNull(),
  scopes: text('scopes').array().$type<ApiScope[]>().notNull(),
  createdBy: uuid('created_by').notNull(),
  lastUsedAt: timestamptz('last_used_at'),
  revokedAt: timestamptz('revoked_at'),
  createdAt: createdAt(),
});

export const WEBHOOK_EVENTS = ['sale.completed', 'stock.low', 'order.created'] as const;
export type WebhookEvent = (typeof WEBHOOK_EVENTS)[number];

export const webhookEndpoints = pgTable('webhook_endpoints', {
  id: id(),
  tenantId: tenantId(),
  url: text('url').notNull(),
  secretSealed: text('secret_sealed').notNull(), // signs each delivery; shown once when created
  events: text('events').array().$type<WebhookEvent[]>().notNull(),
  active: boolean('active').notNull().default(true),
  createdAt: createdAt(),
}, (t) => [unique('webhook_endpoints_tenant_id').on(t.tenantId, t.id)]);

export const webhookDeliveries = pgTable('webhook_deliveries', {
  id: id(),
  tenantId: tenantId(),
  endpointId: uuid('endpoint_id').notNull(),
  event: text('event').$type<WebhookEvent>().notNull(),
  payload: jsonb('payload').$type<Record<string, unknown>>().notNull(),
  status: text('status').$type<'pending' | 'delivered' | 'failed'>().notNull().default('pending'),
  attempts: integer('attempts').notNull().default(0),
  nextAttemptAt: timestamptz('next_attempt_at').notNull().defaultNow(),
  lastError: text('last_error'),
  deliveredAt: timestamptz('delivered_at'),
  createdAt: createdAt(),
}, (t) => [
  index('webhook_deliveries_due').on(t.status, t.nextAttemptAt),
  check('webhook_deliveries_status', sql`${t.status} in ('pending', 'delivered', 'failed')`),
  foreignKey({ name: 'webhook_deliveries_endpoint_fk', columns: [t.tenantId, t.endpointId], foreignColumns: [webhookEndpoints.tenantId, webhookEndpoints.id] }).onDelete('cascade'),
]);

/** Spec 3: a custom domain pointing at the shop; live once its DNS TXT record proves the owner controls it. */
export const shopDomains = pgTable('shop_domains', {
  id: id(),
  tenantId: tenantId(),
  host: text('host').notNull().unique(),
  verifyToken: text('verify_token').notNull(),
  verifiedAt: timestamptz('verified_at'),
  createdAt: createdAt(),
});

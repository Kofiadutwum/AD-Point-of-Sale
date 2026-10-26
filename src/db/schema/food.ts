import { sql } from 'drizzle-orm';
import { boolean, check, date, foreignKey, index, integer, pgTable, primaryKey, text, unique, uuid } from 'drizzle-orm/pg-core';
import { id, timestamptz } from './columns';
import { variants } from './catalogue';
import { users } from './people';
import { sales } from './selling';
import { branches, tenants } from './tenancy';

export type KitchenOrderStatus = 'preparing' | 'ready' | 'collected' | 'handed_over' | 'cancelled';

const tenantId = () => uuid('tenant_id').notNull().references(() => tenants.id);

/** One row per shop: which catalogue item is the takeaway pack and how it is charged (spec 6.56). */
export const foodSettings = pgTable('food_settings', {
  tenantId: uuid('tenant_id').primaryKey().references(() => tenants.id),
  packVariantId: uuid('pack_variant_id'),
  packFeeMode: text('pack_fee_mode').$type<'per_item' | 'per_order'>().notNull().default('per_order'),
  updatedAt: timestamptz('updated_at').notNull().defaultNow(),
}, (t) => [
  foreignKey({ name: 'food_settings_pack_fk', columns: [t.tenantId, t.packVariantId], foreignColumns: [variants.tenantId, variants.id] }),
  check('food_settings_pack_fee_mode', sql`${t.packFeeMode} in ('per_item', 'per_order')`),
]);

/** Online order numbers: one counter per branch per business date (spec 6.51). */
export const branchOrderCounters = pgTable('branch_order_counters', {
  tenantId: tenantId(),
  branchId: uuid('branch_id').notNull(),
  businessDate: date('business_date', { mode: 'string' }).notNull(),
  last: integer('last').notNull().default(0),
}, (t) => [
  primaryKey({ name: 'branch_order_counters_pk', columns: [t.tenantId, t.branchId, t.businessDate] }),
  foreignKey({ name: 'branch_order_counters_branch_fk', columns: [t.tenantId, t.branchId], foreignColumns: [branches.tenantId, branches.id] }),
]);

/** An item sold out at a branch for one business date; it clears itself when the date changes (spec 6.55). */
export const soldOut = pgTable('sold_out', {
  tenantId: tenantId(),
  branchId: uuid('branch_id').notNull(),
  variantId: uuid('variant_id').notNull(),
  businessDate: date('business_date', { mode: 'string' }).notNull(),
  setBy: uuid('set_by').notNull(),
  setAt: timestamptz('set_at').notNull(),
}, (t) => [
  primaryKey({ name: 'sold_out_pk', columns: [t.tenantId, t.branchId, t.variantId, t.businessDate] }),
  foreignKey({ name: 'sold_out_branch_fk', columns: [t.tenantId, t.branchId], foreignColumns: [branches.tenantId, branches.id] }),
  foreignKey({ name: 'sold_out_variant_fk', columns: [t.tenantId, t.variantId], foreignColumns: [variants.tenantId, variants.id] }),
  foreignKey({ name: 'sold_out_set_by_fk', columns: [t.tenantId, t.setBy], foreignColumns: [users.tenantId, users.id] }),
]);

/** What the kitchen makes for a counter order, and its way to the customer (spec 6.51, 6.58). */
export const kitchenOrders = pgTable('kitchen_orders', {
  id: id(),
  tenantId: tenantId(),
  branchId: uuid('branch_id').notNull(),
  saleId: uuid('sale_id'), // null for unpaid phone orders (Plan 1b-3)
  orderNumber: text('order_number').notNull(),
  businessDate: date('business_date', { mode: 'string' }).notNull(),
  diningOption: text('dining_option').$type<'eat_in' | 'takeaway' | 'delivery'>().notNull(),
  status: text('status').$type<KitchenOrderStatus>().notNull().default('preparing'),
  needsPacking: boolean('needs_packing').notNull(),
  sentAt: timestamptz('sent_at').notNull(),
  readyAt: timestamptz('ready_at'),
  closedAt: timestamptz('closed_at'),
  closedBy: uuid('closed_by'),
  handedTo: text('handed_to'),
}, (t) => [
  unique('kitchen_orders_tenant_id').on(t.tenantId, t.id),
  unique('kitchen_orders_sale').on(t.tenantId, t.saleId),
  index('kitchen_orders_day').on(t.tenantId, t.branchId, t.businessDate, t.status),
  foreignKey({ name: 'kitchen_orders_branch_fk', columns: [t.tenantId, t.branchId], foreignColumns: [branches.tenantId, branches.id] }),
  foreignKey({ name: 'kitchen_orders_sale_fk', columns: [t.tenantId, t.saleId], foreignColumns: [sales.tenantId, sales.id] }),
  foreignKey({ name: 'kitchen_orders_closed_by_fk', columns: [t.tenantId, t.closedBy], foreignColumns: [users.tenantId, users.id] }),
  check('kitchen_orders_status', sql`${t.status} in ('preparing', 'ready', 'collected', 'handed_over', 'cancelled')`),
  check('kitchen_orders_dining_option', sql`${t.diningOption} in ('eat_in', 'takeaway', 'delivery')`),
]);

/** One tick per packed line of a takeaway or delivery order (spec 6.58). */
export const packingTicks = pgTable('packing_ticks', {
  tenantId: tenantId(),
  kitchenOrderId: uuid('kitchen_order_id').notNull(),
  lineNo: integer('line_no').notNull(),
  packedBy: uuid('packed_by').notNull(),
  packedAt: timestamptz('packed_at').notNull(),
}, (t) => [
  primaryKey({ name: 'packing_ticks_pk', columns: [t.kitchenOrderId, t.lineNo] }),
  foreignKey({ name: 'packing_ticks_order_fk', columns: [t.tenantId, t.kitchenOrderId], foreignColumns: [kitchenOrders.tenantId, kitchenOrders.id] }),
  foreignKey({ name: 'packing_ticks_packed_by_fk', columns: [t.tenantId, t.packedBy], foreignColumns: [users.tenantId, users.id] }),
]);

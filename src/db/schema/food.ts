import { sql } from 'drizzle-orm';
import { boolean, check, date, foreignKey, index, integer, jsonb, numeric, pgTable, primaryKey, text, unique, uniqueIndex, uuid } from 'drizzle-orm/pg-core';
import { createdAt, id, timestamptz } from './columns';
import { type KitchenStation, variants, variantUnits } from './catalogue';
import { users } from './people';
import { sales, salesChannels } from './selling';
import { branches, tenants } from './tenancy';

export type PendingLine = {
  variantId: string; unitId: string; quantity: string; byAmount?: boolean; amountPesewas?: number; choices?: Array<{ slotId: string; variantId: string }>;
  addOns?: Array<{ groupId: string; optionId: string }>; note?: string;
};
export type KitchenOrderStatus = 'preparing' | 'ready' | 'collected' | 'handed_over' | 'cancelled';

const tenantId = () => uuid('tenant_id').notNull().references(() => tenants.id);

/** One row per shop: which catalogue item is the takeaway pack and how it is charged (spec 6.56). */
export const foodSettings = pgTable('food_settings', {
  tenantId: uuid('tenant_id').primaryKey().references(() => tenants.id),
  packVariantId: uuid('pack_variant_id'),
  packFeeMode: text('pack_fee_mode').$type<'per_item' | 'per_order'>().notNull().default('per_order'),
  keepPotLeftovers: boolean('keep_pot_leftovers').notNull().default(false), // carry leftovers to the next business day instead of wasting them
  potVarianceLimitBp: integer('pot_variance_limit_bp').notNull().default(1000), // 10%
  updatedAt: timestamptz('updated_at').notNull().defaultNow(),
}, (t) => [
  foreignKey({ name: 'food_settings_pack_fk', columns: [t.tenantId, t.packVariantId], foreignColumns: [variants.tenantId, variants.id] }),
  check('food_settings_pack_fee_mode', sql`${t.packFeeMode} in ('per_item', 'per_order')`),
  check('food_settings_pot_variance_limit', sql`${t.potVarianceLimitBp} between 0 and 10000`),
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
  channelId: uuid('channel_id'),
  customerName: text('customer_name'),
  customerPhone: text('customer_phone'),
  pickupAt: timestamptz('pickup_at'),
  deliveryAddress: text('delivery_address'),
  payOnCollect: boolean('pay_on_collect').notNull().default(false), // phone order paid when collected; its sale is made then (spec 6.57)
  pendingLines: jsonb('pending_lines').$type<PendingLine[]>(),
}, (t) => [
  check('kitchen_orders_paid', sql`${t.payOnCollect} or ${t.saleId} is not null`),
  check('kitchen_orders_pending_lines', sql`not ${t.payOnCollect} or ${t.pendingLines} is not null`),
  foreignKey({ name: 'kitchen_orders_channel_fk', columns: [t.tenantId, t.channelId], foreignColumns: [salesChannels.tenantId, salesChannels.id] }),
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

const qty = (name: string) => numeric(name, { precision: 14, scale: 3 });

/** A combo's choice slot, such as "Drink: pick 1" (spec 6.52); its fixed items are ordinary components. */
export const comboSlots = pgTable('combo_slots', {
  id: id(),
  tenantId: tenantId(),
  comboVariantId: uuid('combo_variant_id').notNull(),
  name: text('name').notNull(),
  minChoices: integer('min_choices').notNull(),
  maxChoices: integer('max_choices').notNull(),
  sortOrder: integer('sort_order').notNull().default(0),
  createdAt: createdAt(),
}, (t) => [
  unique('combo_slots_tenant_id').on(t.tenantId, t.id),
  foreignKey({ name: 'combo_slots_combo_fk', columns: [t.tenantId, t.comboVariantId], foreignColumns: [variants.tenantId, variants.id] }).onDelete('cascade'),
  check('combo_slots_choices', sql`0 <= ${t.minChoices} and ${t.minChoices} <= ${t.maxChoices} and ${t.maxChoices} >= 1`),
]);

/** One item a customer may pick in a slot, with any upgrade price (spec 6.52). */
export const comboChoices = pgTable('combo_choices', {
  id: id(),
  tenantId: tenantId(),
  slotId: uuid('slot_id').notNull(),
  variantId: uuid('variant_id').notNull(),
  upgradePesewas: integer('upgrade_pesewas').notNull().default(0),
}, (t) => [
  unique('combo_choices_slot_variant').on(t.slotId, t.variantId),
  foreignKey({ name: 'combo_choices_slot_fk', columns: [t.tenantId, t.slotId], foreignColumns: [comboSlots.tenantId, comboSlots.id] }).onDelete('cascade'),
  foreignKey({ name: 'combo_choices_variant_fk', columns: [t.tenantId, t.variantId], foreignColumns: [variants.tenantId, variants.id] }),
  check('combo_choices_upgrade', sql`${t.upgradePesewas} >= 0`),
]);

/** Pots cooked of a sell-by-amount item on one business day, and the closing count (spec 6.54). */
export const potRecords = pgTable('pot_records', {
  id: id(),
  tenantId: tenantId(),
  branchId: uuid('branch_id').notNull(),
  variantId: uuid('variant_id').notNull(),
  businessDate: date('business_date', { mode: 'string' }).notNull(),
  cooked: qty('cooked').notNull().default('0'),
  carriedIn: qty('carried_in').notNull().default('0'),
  leftover: qty('leftover'),
  expectedPesewas: integer('expected_pesewas'),
  actualPesewas: integer('actual_pesewas'),
  variancePesewas: integer('variance_pesewas'),
  flagged: boolean('flagged').notNull().default(false),
  closedBy: uuid('closed_by'),
  closedAt: timestamptz('closed_at'),
}, (t) => [
  unique('pot_records_tenant_id').on(t.tenantId, t.id),
  unique('pot_records_day').on(t.tenantId, t.branchId, t.variantId, t.businessDate),
  foreignKey({ name: 'pot_records_branch_fk', columns: [t.tenantId, t.branchId], foreignColumns: [branches.tenantId, branches.id] }),
  foreignKey({ name: 'pot_records_variant_fk', columns: [t.tenantId, t.variantId], foreignColumns: [variants.tenantId, variants.id] }),
  foreignKey({ name: 'pot_records_closed_by_fk', columns: [t.tenantId, t.closedBy], foreignColumns: [users.tenantId, users.id] }),
  check('pot_records_cooked', sql`${t.cooked} >= 0`),
  check('pot_records_leftover', sql`${t.leftover} >= 0 and ${t.leftover} <= ${t.cooked}`),
]);

export type WastageReason = 'spoiled' | 'dropped' | 'staff_meal' | 'leftover';

/** Food thrown away or eaten by staff, with its cost when recorded (spec 4.24); never edited. */
export const wastageEntries = pgTable('wastage_entries', {
  id: id(),
  tenantId: tenantId(),
  branchId: uuid('branch_id').notNull(),
  variantId: uuid('variant_id').notNull(),
  businessDate: date('business_date', { mode: 'string' }).notNull(),
  quantity: qty('quantity').notNull(),
  reason: text('reason').$type<WastageReason>().notNull(),
  costPesewas: integer('cost_pesewas').notNull(),
  potRecordId: uuid('pot_record_id'),
  note: text('note'),
  userId: uuid('user_id').notNull(),
  createdAt: createdAt(),
}, (t) => [
  foreignKey({ name: 'wastage_entries_branch_fk', columns: [t.tenantId, t.branchId], foreignColumns: [branches.tenantId, branches.id] }),
  foreignKey({ name: 'wastage_entries_variant_fk', columns: [t.tenantId, t.variantId], foreignColumns: [variants.tenantId, variants.id] }),
  foreignKey({ name: 'wastage_entries_pot_fk', columns: [t.tenantId, t.potRecordId], foreignColumns: [potRecords.tenantId, potRecords.id] }),
  foreignKey({ name: 'wastage_entries_user_fk', columns: [t.tenantId, t.userId], foreignColumns: [users.tenantId, users.id] }),
  check('wastage_entries_quantity', sql`${t.quantity} > 0`),
  check('wastage_entries_reason', sql`${t.reason} in ('spoiled', 'dropped', 'staff_meal', 'leftover')`),
  check('wastage_entries_cost', sql`${t.costPesewas} >= 0`),
]);

/** A payout from a delivery app, matched against what the app owed for its orders (spec 6.57). */
export const channelPayouts = pgTable('channel_payouts', {
  id: id(),
  tenantId: tenantId(),
  channelId: uuid('channel_id').notNull(),
  amountPesewas: integer('amount_pesewas').notNull(),
  reference: text('reference').notNull(),
  periodFrom: date('period_from', { mode: 'string' }),
  periodTo: date('period_to', { mode: 'string' }),
  expectedPesewas: integer('expected_pesewas').notNull(),
  differencePesewas: integer('difference_pesewas').notNull(),
  recordedBy: uuid('recorded_by'),
  createdAt: createdAt(),
}, (t) => [
  unique('channel_payouts_tenant_id').on(t.tenantId, t.id),
  unique('channel_payouts_reference').on(t.tenantId, t.channelId, t.reference),
  foreignKey({ name: 'channel_payouts_channel_fk', columns: [t.tenantId, t.channelId], foreignColumns: [salesChannels.tenantId, salesChannels.id] }),
  foreignKey({ name: 'channel_payouts_recorded_by_fk', columns: [t.tenantId, t.recordedBy], foreignColumns: [users.tenantId, users.id] }),
  check('channel_payouts_amount', sql`${t.amountPesewas} > 0`),
  check('channel_payouts_period', sql`${t.periodTo} >= ${t.periodFrom}`),
]);

/** What a delivery app owes for one sale it collected the money for: total minus commission (spec 6.57). */
export const channelReceivables = pgTable('channel_receivables', {
  id: id(),
  tenantId: tenantId(),
  saleId: uuid('sale_id').notNull(),
  channelId: uuid('channel_id').notNull(),
  expectedPesewas: integer('expected_pesewas').notNull(),
  payoutId: uuid('payout_id'),
  createdAt: createdAt(),
}, (t) => [
  unique('channel_receivables_sale').on(t.tenantId, t.saleId),
  foreignKey({ name: 'channel_receivables_sale_fk', columns: [t.tenantId, t.saleId], foreignColumns: [sales.tenantId, sales.id] }),
  foreignKey({ name: 'channel_receivables_channel_fk', columns: [t.tenantId, t.channelId], foreignColumns: [salesChannels.tenantId, salesChannels.id] }),
  foreignKey({ name: 'channel_receivables_payout_fk', columns: [t.tenantId, t.payoutId], foreignColumns: [channelPayouts.tenantId, channelPayouts.id] }),
]);

/** A shop-level add-on group such as "Protein: choose 1" or "Extras", linked to items (spec 4.24). */
export const addOnGroups = pgTable('add_on_groups', {
  id: id(),
  tenantId: tenantId(),
  name: text('name').notNull(),
  minChoices: integer('min_choices').notNull().default(0),
  maxChoices: integer('max_choices').notNull().default(1),
  createdAt: createdAt(),
}, (t) => [
  unique('add_on_groups_tenant_id').on(t.tenantId, t.id),
  uniqueIndex('add_on_groups_name').on(t.tenantId, sql`lower(${t.name})`),
  check('add_on_groups_choices', sql`${t.minChoices} between 0 and 20 and ${t.maxChoices} between 1 and 20 and ${t.minChoices} <= ${t.maxChoices}`),
]);

/** One add-on with its price and the ingredient it uses, if any; never deleted, only made inactive. */
export const addOnOptions = pgTable('add_on_options', {
  id: id(),
  tenantId: tenantId(),
  groupId: uuid('group_id').notNull(),
  name: text('name').notNull(),
  pricePesewas: integer('price_pesewas').notNull().default(0),
  ingredientVariantId: uuid('ingredient_variant_id'),
  ingredientQuantity: qty('ingredient_quantity'),
  sortOrder: integer('sort_order').notNull().default(0),
  active: boolean('active').notNull().default(true),
}, (t) => [
  unique('add_on_options_tenant_id').on(t.tenantId, t.id),
  foreignKey({ name: 'add_on_options_group_fk', columns: [t.tenantId, t.groupId], foreignColumns: [addOnGroups.tenantId, addOnGroups.id] }),
  foreignKey({ name: 'add_on_options_ingredient_fk', columns: [t.tenantId, t.ingredientVariantId], foreignColumns: [variants.tenantId, variants.id] }),
  check('add_on_options_price', sql`${t.pricePesewas} >= 0`),
  check('add_on_options_ingredient', sql`(${t.ingredientVariantId} is null) = (${t.ingredientQuantity} is null) and (${t.ingredientQuantity} is null or ${t.ingredientQuantity} > 0)`),
]);

/** The add-on groups an item offers, in order. */
export const variantAddOnGroups = pgTable('variant_add_on_groups', {
  tenantId: tenantId(),
  variantId: uuid('variant_id').notNull(),
  groupId: uuid('group_id').notNull(),
  sortOrder: integer('sort_order').notNull().default(0),
}, (t) => [
  primaryKey({ name: 'variant_add_on_groups_pk', columns: [t.tenantId, t.variantId, t.groupId] }),
  foreignKey({ name: 'variant_add_on_groups_variant_fk', columns: [t.tenantId, t.variantId], foreignColumns: [variants.tenantId, variants.id] }).onDelete('cascade'),
  foreignKey({ name: 'variant_add_on_groups_group_fk', columns: [t.tenantId, t.groupId], foreignColumns: [addOnGroups.tenantId, addOnGroups.id] }),
]);

export type TableStatus = 'free' | 'ordering' | 'waiting_for_food' | 'bill_printed';
export type TicketStatus = 'open' | 'paid' | 'merged' | 'cancelled';
export type TicketLineStatus = 'new' | 'sent' | 'ready' | 'void';

/** A sit-down restaurant's table (spec 4.24); never deleted, only made inactive. */
export const diningTables = pgTable('dining_tables', {
  id: id(),
  tenantId: tenantId(),
  branchId: uuid('branch_id').notNull(),
  name: text('name').notNull(),
  status: text('status').$type<TableStatus>().notNull().default('free'),
  active: boolean('active').notNull().default(true),
  sortOrder: integer('sort_order').notNull().default(0),
  createdAt: createdAt(),
}, (t) => [
  unique('dining_tables_tenant_id').on(t.tenantId, t.id),
  uniqueIndex('dining_tables_name').on(t.tenantId, t.branchId, sql`lower(${t.name})`),
  foreignKey({ name: 'dining_tables_branch_fk', columns: [t.tenantId, t.branchId], foreignColumns: [branches.tenantId, branches.id] }),
  check('dining_tables_status', sql`${t.status} in ('free', 'ordering', 'waiting_for_food', 'bill_printed')`),
]);

/** An open ticket for a table or a name, added to before it is paid (spec 6.37). */
export const tickets = pgTable('tickets', {
  id: id(),
  tenantId: tenantId(),
  branchId: uuid('branch_id').notNull(),
  tableId: uuid('table_id'),
  label: text('label').notNull(),
  waiterId: uuid('waiter_id').notNull(),
  diningOption: text('dining_option').$type<'eat_in' | 'takeaway' | 'delivery'>().notNull(),
  status: text('status').$type<TicketStatus>().notNull().default('open'),
  saleId: uuid('sale_id'),
  openedAt: timestamptz('opened_at').notNull(),
  closedAt: timestamptz('closed_at'),
}, (t) => [
  unique('tickets_tenant_id').on(t.tenantId, t.id),
  unique('tickets_sale').on(t.tenantId, t.saleId),
  uniqueIndex('tickets_open_table').on(t.tenantId, t.tableId).where(sql`${t.status} = 'open' and ${t.tableId} is not null`),
  foreignKey({ name: 'tickets_branch_fk', columns: [t.tenantId, t.branchId], foreignColumns: [branches.tenantId, branches.id] }),
  foreignKey({ name: 'tickets_table_fk', columns: [t.tenantId, t.tableId], foreignColumns: [diningTables.tenantId, diningTables.id] }),
  foreignKey({ name: 'tickets_waiter_fk', columns: [t.tenantId, t.waiterId], foreignColumns: [users.tenantId, users.id] }),
  foreignKey({ name: 'tickets_sale_fk', columns: [t.tenantId, t.saleId], foreignColumns: [sales.tenantId, sales.id] }),
  check('tickets_status', sql`${t.status} in ('open', 'paid', 'merged', 'cancelled')`),
  check('tickets_dining', sql`${t.diningOption} in ('eat_in', 'takeaway', 'delivery')`),
  check('tickets_paid', sql`${t.status} <> 'paid' or ${t.saleId} is not null`),
]);

/** One item on a ticket with its kitchen station and status; priced when the ticket is paid (spec 6.37). */
export const ticketLines = pgTable('ticket_lines', {
  id: id(),
  tenantId: tenantId(),
  ticketId: uuid('ticket_id').notNull(),
  lineNo: integer('line_no').notNull(),
  variantId: uuid('variant_id').notNull(),
  unitId: uuid('unit_id').notNull(),
  quantity: qty('quantity').notNull(),
  byAmount: boolean('by_amount').notNull().default(false),
  amountPesewas: integer('amount_pesewas'),
  choices: jsonb('choices').$type<Array<{ slotId: string; variantId: string }>>().notNull().default(sql`'[]'::jsonb`),
  addOns: jsonb('add_ons').$type<Array<{ groupId: string; optionId: string }>>().notNull().default(sql`'[]'::jsonb`),
  note: text('note'),
  station: text('station').$type<KitchenStation>().notNull(),
  kitchenStatus: text('kitchen_status').$type<TicketLineStatus>().notNull().default('new'),
  sentAt: timestamptz('sent_at'),
  readyAt: timestamptz('ready_at'),
  voidReason: text('void_reason'),
  voidedBy: uuid('voided_by'),
  approvedBy: uuid('approved_by'),
  createdAt: createdAt(),
}, (t) => [
  unique('ticket_lines_tenant_id').on(t.tenantId, t.id),
  unique('ticket_lines_line_no').on(t.ticketId, t.lineNo),
  foreignKey({ name: 'ticket_lines_ticket_fk', columns: [t.tenantId, t.ticketId], foreignColumns: [tickets.tenantId, tickets.id] }),
  foreignKey({ name: 'ticket_lines_variant_fk', columns: [t.tenantId, t.variantId], foreignColumns: [variants.tenantId, variants.id] }),
  foreignKey({ name: 'ticket_lines_unit_fk', columns: [t.tenantId, t.variantId, t.unitId], foreignColumns: [variantUnits.tenantId, variantUnits.variantId, variantUnits.id] }),
  check('ticket_lines_station', sql`${t.station} in ('kitchen', 'bar', 'grill')`),
  check('ticket_lines_status', sql`${t.kitchenStatus} in ('new', 'sent', 'ready', 'void')`),
  check('ticket_lines_void', sql`${t.kitchenStatus} <> 'void' or ${t.voidReason} is not null`),
  check('ticket_lines_quantity', sql`${t.quantity} > 0`),
  check('ticket_lines_note', sql`length(${t.note}) <= 140`),
]);

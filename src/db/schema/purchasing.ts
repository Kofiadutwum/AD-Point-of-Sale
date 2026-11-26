import { sql } from 'drizzle-orm';
import { boolean, check, date, foreignKey, index, integer, numeric, pgTable, primaryKey, text, unique, uniqueIndex, uuid } from 'drizzle-orm/pg-core';
import { variants } from './catalogue';
import { createdAt, id, timestamptz } from './columns';
import { users } from './people';
import { stockBatches, stockReceipts } from './stock';
import { branches, tenants } from './tenancy';

// Spec 4.19, 6.23-6.26: suppliers, purchase orders, supplier bills and returns, transfers, counts, and adjustments. Quantities are base units unless named otherwise.

const tenantId = () => uuid('tenant_id').notNull().references(() => tenants.id);
const quantity = (name: string) => numeric(name, { precision: 14, scale: 3 });

export const suppliers = pgTable('suppliers', {
  id: id(),
  tenantId: tenantId(),
  name: text('name').notNull(),
  phone: text('phone'),
  email: text('email'),
  paymentTermsDays: integer('payment_terms_days').notNull().default(0), // bill due this many days after receiving
  leadTimeDays: integer('lead_time_days').notNull().default(7),
  note: text('note'),
  createdAt: createdAt(),
}, (t) => [
  unique('suppliers_tenant_id').on(t.tenantId, t.id),
  uniqueIndex('suppliers_name').on(t.tenantId, sql`lower(${t.name})`),
  check('suppliers_terms', sql`${t.paymentTermsDays} between 0 and 365 and ${t.leadTimeDays} between 0 and 365`),
]);

/** What a supplier sells us: the pack size (as a purchasable unit) and the last cost per pack. */
export const supplierItems = pgTable('supplier_items', {
  tenantId: tenantId(),
  supplierId: uuid('supplier_id').notNull(),
  variantId: uuid('variant_id').notNull(),
  unitId: uuid('unit_id').notNull(), // the pack the supplier sells
  packFactor: quantity('pack_factor').notNull(), // base units in one pack, copied from the unit
  lastCostPesewas: integer('last_cost_pesewas'), // per pack
  isMain: boolean('is_main').notNull().default(true), // suggested orders go to the main supplier
}, (t) => [
  primaryKey({ name: 'supplier_items_pk', columns: [t.tenantId, t.supplierId, t.variantId] }),
  foreignKey({ name: 'supplier_items_supplier_fk', columns: [t.tenantId, t.supplierId], foreignColumns: [suppliers.tenantId, suppliers.id] }),
  foreignKey({ name: 'supplier_items_variant_fk', columns: [t.tenantId, t.variantId], foreignColumns: [variants.tenantId, variants.id] }),
]);

export type PurchaseOrderStatus = 'draft' | 'sent' | 'partly_received' | 'received' | 'closed';

export const purchaseOrders = pgTable('purchase_orders', {
  id: id(),
  tenantId: tenantId(),
  number: text('number').notNull(), // PO-0001
  branchId: uuid('branch_id').notNull(),
  supplierId: uuid('supplier_id').notNull(),
  status: text('status').$type<PurchaseOrderStatus>().notNull().default('draft'),
  suggested: boolean('suggested').notNull().default(false), // built by the reorder job; a person must review it (6.24)
  note: text('note'),
  createdBy: uuid('created_by'),
  sentAt: timestamptz('sent_at'),
  createdAt: createdAt(),
}, (t) => [
  unique('purchase_orders_tenant_id').on(t.tenantId, t.id),
  unique('purchase_orders_number').on(t.tenantId, t.number),
  check('purchase_orders_status', sql`${t.status} in ('draft', 'sent', 'partly_received', 'received', 'closed')`),
  foreignKey({ name: 'purchase_orders_branch_fk', columns: [t.tenantId, t.branchId], foreignColumns: [branches.tenantId, branches.id] }),
  foreignKey({ name: 'purchase_orders_supplier_fk', columns: [t.tenantId, t.supplierId], foreignColumns: [suppliers.tenantId, suppliers.id] }),
]);

/** Quantities in the ordered unit (packs); `factor` is base units per that unit. */
export const purchaseOrderLines = pgTable('purchase_order_lines', {
  id: id(),
  tenantId: tenantId(),
  purchaseOrderId: uuid('purchase_order_id').notNull(),
  variantId: uuid('variant_id').notNull(),
  unitId: uuid('unit_id').notNull(),
  factor: quantity('factor').notNull(),
  quantity: quantity('quantity').notNull(),
  receivedQuantity: quantity('received_quantity').notNull().default('0'),
  unitCostPesewas: integer('unit_cost_pesewas').notNull().default(0), // expected cost per ordered unit
}, (t) => [
  foreignKey({ name: 'purchase_order_lines_po_fk', columns: [t.tenantId, t.purchaseOrderId], foreignColumns: [purchaseOrders.tenantId, purchaseOrders.id] }).onDelete('cascade'),
  foreignKey({ name: 'purchase_order_lines_variant_fk', columns: [t.tenantId, t.variantId], foreignColumns: [variants.tenantId, variants.id] }),
  check('purchase_order_lines_quantity', sql`${t.quantity} > 0 and ${t.receivedQuantity} >= 0`),
]);

/** Spec 4.19: what is owed to a supplier for a delivery, its due date, and what has been paid. */
export const supplierBills = pgTable('supplier_bills', {
  id: id(),
  tenantId: tenantId(),
  supplierId: uuid('supplier_id').notNull(),
  receiptId: uuid('receipt_id'),
  reference: text('reference'), // the supplier's invoice number
  amountPesewas: integer('amount_pesewas').notNull(),
  paidPesewas: integer('paid_pesewas').notNull().default(0),
  dueDate: date('due_date', { mode: 'string' }).notNull(),
  createdBy: uuid('created_by').notNull(),
  createdAt: createdAt(),
}, (t) => [
  unique('supplier_bills_tenant_id').on(t.tenantId, t.id),
  check('supplier_bills_amounts', sql`${t.amountPesewas} > 0 and ${t.paidPesewas} between 0 and ${t.amountPesewas}`),
  foreignKey({ name: 'supplier_bills_supplier_fk', columns: [t.tenantId, t.supplierId], foreignColumns: [suppliers.tenantId, suppliers.id] }),
  foreignKey({ name: 'supplier_bills_receipt_fk', columns: [t.tenantId, t.receiptId], foreignColumns: [stockReceipts.tenantId, stockReceipts.id] }),
]);

/** A payment to a supplier, or a credit from a supplier return, applied to bills (method 'credit'). */
export const supplierPayments = pgTable('supplier_payments', {
  id: id(),
  tenantId: tenantId(),
  supplierId: uuid('supplier_id').notNull(),
  billId: uuid('bill_id'),
  amountPesewas: integer('amount_pesewas').notNull(),
  method: text('method').notNull(),
  reference: text('reference'),
  createdBy: uuid('created_by').notNull(),
  createdAt: createdAt(),
}, (t) => [
  check('supplier_payments_amount', sql`${t.amountPesewas} > 0`),
  check('supplier_payments_method', sql`${t.method} in ('cash', 'momo_manual', 'bank_transfer', 'cheque', 'credit')`),
  foreignKey({ name: 'supplier_payments_supplier_fk', columns: [t.tenantId, t.supplierId], foreignColumns: [suppliers.tenantId, suppliers.id] }),
  foreignKey({ name: 'supplier_payments_bill_fk', columns: [t.tenantId, t.billId], foreignColumns: [supplierBills.tenantId, supplierBills.id] }),
]);

/** Spec 6.24: goods sent back; the credit is what the supplier owes us (refund or replacement). */
export const supplierReturns = pgTable('supplier_returns', {
  id: id(),
  tenantId: tenantId(),
  branchId: uuid('branch_id').notNull(),
  supplierId: uuid('supplier_id').notNull(),
  reason: text('reason').notNull(),
  creditPesewas: integer('credit_pesewas').notNull(),
  creditUsedPesewas: integer('credit_used_pesewas').notNull().default(0),
  createdBy: uuid('created_by').notNull(),
  createdAt: createdAt(),
}, (t) => [
  unique('supplier_returns_tenant_id').on(t.tenantId, t.id),
  check('supplier_returns_credit', sql`${t.creditPesewas} >= 0 and ${t.creditUsedPesewas} between 0 and ${t.creditPesewas}`),
  foreignKey({ name: 'supplier_returns_supplier_fk', columns: [t.tenantId, t.supplierId], foreignColumns: [suppliers.tenantId, suppliers.id] }),
  foreignKey({ name: 'supplier_returns_branch_fk', columns: [t.tenantId, t.branchId], foreignColumns: [branches.tenantId, branches.id] }),
]);

export const stockTransfers = pgTable('stock_transfers', {
  id: id(),
  tenantId: tenantId(),
  number: text('number').notNull(), // TR-0001
  fromBranchId: uuid('from_branch_id').notNull(),
  toBranchId: uuid('to_branch_id').notNull(),
  status: text('status').$type<'sent' | 'received'>().notNull().default('sent'),
  note: text('note'),
  sentBy: uuid('sent_by').notNull(),
  sentAt: timestamptz('sent_at').notNull(),
  receivedBy: uuid('received_by'),
  receivedAt: timestamptz('received_at'),
}, (t) => [
  unique('stock_transfers_tenant_id').on(t.tenantId, t.id),
  unique('stock_transfers_number').on(t.tenantId, t.number),
  check('stock_transfers_status', sql`${t.status} in ('sent', 'received')`),
  check('stock_transfers_branches', sql`${t.fromBranchId} <> ${t.toBranchId}`),
  foreignKey({ name: 'stock_transfers_from_fk', columns: [t.tenantId, t.fromBranchId], foreignColumns: [branches.tenantId, branches.id] }),
  foreignKey({ name: 'stock_transfers_to_fk', columns: [t.tenantId, t.toBranchId], foreignColumns: [branches.tenantId, branches.id] }),
]);

/** Sent and received base quantities; batch details travel with the stock. The gap between them is "in transit" until received. */
export const stockTransferLines = pgTable('stock_transfer_lines', {
  id: id(),
  tenantId: tenantId(),
  transferId: uuid('transfer_id').notNull(),
  variantId: uuid('variant_id').notNull(),
  batchNumber: text('batch_number'),
  expiryDate: date('expiry_date', { mode: 'string' }),
  quantity: quantity('quantity').notNull(),
  receivedQuantity: quantity('received_quantity'),
  unitCost: numeric('unit_cost', { precision: 14, scale: 4 }).notNull(),
  differenceReason: text('difference_reason'),
}, (t) => [
  foreignKey({ name: 'stock_transfer_lines_transfer_fk', columns: [t.tenantId, t.transferId], foreignColumns: [stockTransfers.tenantId, stockTransfers.id] }),
  foreignKey({ name: 'stock_transfer_lines_variant_fk', columns: [t.tenantId, t.variantId], foreignColumns: [variants.tenantId, variants.id] }),
  check('stock_transfer_lines_quantity', sql`${t.quantity} > 0 and (${t.receivedQuantity} is null or ${t.receivedQuantity} >= 0)`),
]);

export const stockCounts = pgTable('stock_counts', {
  id: id(),
  tenantId: tenantId(),
  branchId: uuid('branch_id').notNull(),
  status: text('status').$type<'open' | 'completed' | 'cancelled'>().notNull().default('open'),
  note: text('note'),
  startedBy: uuid('started_by').notNull(),
  startedAt: timestamptz('started_at').notNull(),
  completedBy: uuid('completed_by'),
  completedAt: timestamptz('completed_at'),
  approvedBy: uuid('approved_by'),
  differenceValuePesewas: integer('difference_value_pesewas'),
}, (t) => [
  unique('stock_counts_tenant_id').on(t.tenantId, t.id),
  check('stock_counts_status', sql`${t.status} in ('open', 'completed', 'cancelled')`),
  foreignKey({ name: 'stock_counts_branch_fk', columns: [t.tenantId, t.branchId], foreignColumns: [branches.tenantId, branches.id] }),
]);

/** One counted item: the snapshot taken at the start, what was counted, and when (selling continues during a count). */
export const stockCountLines = pgTable('stock_count_lines', {
  id: id(),
  tenantId: tenantId(),
  countId: uuid('count_id').notNull(),
  variantId: uuid('variant_id').notNull(),
  batchId: uuid('batch_id'),
  expected: quantity('expected').notNull(),
  counted: quantity('counted'),
  countedAt: timestamptz('counted_at'),
  difference: quantity('difference'),
}, (t) => [
  uniqueIndex('stock_count_lines_item').on(t.countId, t.variantId, sql`coalesce(${t.batchId}, '00000000-0000-0000-0000-000000000000'::uuid)`),
  index('stock_count_lines_count').on(t.tenantId, t.countId),
  foreignKey({ name: 'stock_count_lines_count_fk', columns: [t.tenantId, t.countId], foreignColumns: [stockCounts.tenantId, stockCounts.id] }),
  foreignKey({ name: 'stock_count_lines_variant_fk', columns: [t.tenantId, t.variantId], foreignColumns: [variants.tenantId, variants.id] }),
  foreignKey({ name: 'stock_count_lines_batch_fk', columns: [t.tenantId, t.batchId], foreignColumns: [stockBatches.tenantId, stockBatches.id] }),
]);

export type AdjustmentReason = 'damage' | 'loss' | 'theft' | 'own_use' | 'found' | 'expiry_disposal';

export const stockAdjustments = pgTable('stock_adjustments', {
  id: id(),
  tenantId: tenantId(),
  branchId: uuid('branch_id').notNull(),
  variantId: uuid('variant_id').notNull(),
  batchId: uuid('batch_id'),
  quantity: quantity('quantity').notNull(), // signed base units: found stock is positive
  reason: text('reason').$type<AdjustmentReason>().notNull(),
  note: text('note'),
  valuePesewas: integer('value_pesewas').notNull(),
  approvedBy: uuid('approved_by'),
  createdBy: uuid('created_by').notNull(),
  createdAt: createdAt(),
}, (t) => [
  check('stock_adjustments_reason', sql`${t.reason} in ('damage', 'loss', 'theft', 'own_use', 'found', 'expiry_disposal')`),
  check('stock_adjustments_quantity', sql`${t.quantity} <> 0`),
  foreignKey({ name: 'stock_adjustments_branch_fk', columns: [t.tenantId, t.branchId], foreignColumns: [branches.tenantId, branches.id] }),
  foreignKey({ name: 'stock_adjustments_variant_fk', columns: [t.tenantId, t.variantId], foreignColumns: [variants.tenantId, variants.id] }),
  foreignKey({ name: 'stock_adjustments_user_fk', columns: [t.tenantId, t.createdBy], foreignColumns: [users.tenantId, users.id] }),
]);

import { sql } from 'drizzle-orm';
import { bigint, check, date, foreignKey, index, numeric, pgTable, primaryKey, text, unique, uuid } from 'drizzle-orm/pg-core';
import { createdAt, id, timestamptz } from './columns';
import { variants } from './catalogue';
import { users } from './people';
import { branches, tenants } from './tenancy';

// Stock is always held in base units (spec 6.0). Balances may go below zero: a sale is allowed even when recorded stock runs out (4.1).

export type MovementType = 'opening_stock' | 'received' | 'sale' | 'used_in_production' | 'waste' | 'return_restock' | 'produced';
export type SerialStatus = 'in_stock' | 'sold';

const tenantId = () => uuid('tenant_id').notNull().references(() => tenants.id);
const quantity = (name: string) => numeric(name, { precision: 14, scale: 3 });

export const stockBalances = pgTable('stock_balances', {
  tenantId: tenantId(),
  branchId: uuid('branch_id').notNull(),
  variantId: uuid('variant_id').notNull(),
  onHand: quantity('on_hand').notNull().default('0'),
  updatedAt: timestamptz('updated_at').notNull().defaultNow(),
}, (t) => [
  primaryKey({ name: 'stock_balances_pk', columns: [t.tenantId, t.branchId, t.variantId] }),
  foreignKey({ name: 'stock_balances_branch_fk', columns: [t.tenantId, t.branchId], foreignColumns: [branches.tenantId, branches.id] }),
  foreignKey({ name: 'stock_balances_variant_fk', columns: [t.tenantId, t.variantId], foreignColumns: [variants.tenantId, variants.id] }),
]);

export const stockBatches = pgTable('stock_batches', {
  id: id(),
  tenantId: tenantId(),
  branchId: uuid('branch_id').notNull(),
  variantId: uuid('variant_id').notNull(),
  batchNumber: text('batch_number').notNull(),
  expiryDate: date('expiry_date', { mode: 'string' }).notNull(),
  onHand: quantity('on_hand').notNull().default('0'),
  createdAt: createdAt(),
}, (t) => [
  unique('stock_batches_tenant_id').on(t.tenantId, t.id),
  unique('stock_batches_number').on(t.tenantId, t.branchId, t.variantId, t.batchNumber),
  foreignKey({ name: 'stock_batches_branch_fk', columns: [t.tenantId, t.branchId], foreignColumns: [branches.tenantId, branches.id] }),
  foreignKey({ name: 'stock_batches_variant_fk', columns: [t.tenantId, t.variantId], foreignColumns: [variants.tenantId, variants.id] }),
]);

export const serials = pgTable('serials', {
  id: id(),
  tenantId: tenantId(),
  variantId: uuid('variant_id').notNull(),
  branchId: uuid('branch_id').notNull(),
  serial: text('serial').notNull(),
  status: text('status').$type<SerialStatus>().notNull().default('in_stock'),
  saleId: uuid('sale_id'),
  soldAt: timestamptz('sold_at'),
  createdAt: createdAt(),
}, (t) => [
  unique('serials_tenant_id').on(t.tenantId, t.id),
  unique('serials_serial').on(t.tenantId, t.variantId, t.serial),
  foreignKey({ name: 'serials_branch_fk', columns: [t.tenantId, t.branchId], foreignColumns: [branches.tenantId, branches.id] }),
  foreignKey({ name: 'serials_variant_fk', columns: [t.tenantId, t.variantId], foreignColumns: [variants.tenantId, variants.id] }),
  check('serials_status', sql`${t.status} in ('in_stock', 'sold')`),
]);

export const stockReceipts = pgTable('stock_receipts', {
  id: id(),
  tenantId: tenantId(),
  branchId: uuid('branch_id').notNull(),
  kind: text('kind').$type<'received' | 'opening_stock'>().notNull(),
  supplierName: text('supplier_name'),
  note: text('note'),
  receivedBy: uuid('received_by').notNull(),
  createdAt: createdAt(),
}, (t) => [
  unique('stock_receipts_tenant_id').on(t.tenantId, t.id),
  foreignKey({ name: 'stock_receipts_branch_fk', columns: [t.tenantId, t.branchId], foreignColumns: [branches.tenantId, branches.id] }),
  foreignKey({ name: 'stock_receipts_user_fk', columns: [t.tenantId, t.receivedBy], foreignColumns: [users.tenantId, users.id] }),
  check('stock_receipts_kind', sql`${t.kind} in ('received', 'opening_stock')`),
]);

/** Append-only history: who changed stock, when, by how much (signed, base units), and why (spec 4.1). */
export const stockMovements = pgTable('stock_movements', {
  id: bigint('id', { mode: 'number' }).primaryKey().generatedAlwaysAsIdentity(),
  tenantId: tenantId(),
  branchId: uuid('branch_id').notNull(),
  variantId: uuid('variant_id').notNull(),
  type: text('type').$type<MovementType>().notNull(),
  quantity: quantity('quantity').notNull(),
  batchId: uuid('batch_id'),
  serialId: uuid('serial_id'),
  unitCost: numeric('unit_cost', { precision: 14, scale: 4 }), // pesewas per base unit, receipts only
  referenceType: text('reference_type').$type<'stock_receipt' | 'sale' | 'pot_record' | 'wastage' | 'return' | 'production'>().notNull(),
  referenceId: uuid('reference_id').notNull(),
  saleLineId: uuid('sale_line_id'),
  userId: uuid('user_id'),
  createdAt: createdAt(),
}, (t) => [
  index('stock_movements_variant_time').on(t.tenantId, t.variantId, t.createdAt),
  foreignKey({ name: 'stock_movements_branch_fk', columns: [t.tenantId, t.branchId], foreignColumns: [branches.tenantId, branches.id] }),
  foreignKey({ name: 'stock_movements_variant_fk', columns: [t.tenantId, t.variantId], foreignColumns: [variants.tenantId, variants.id] }),
  foreignKey({ name: 'stock_movements_batch_fk', columns: [t.tenantId, t.batchId], foreignColumns: [stockBatches.tenantId, stockBatches.id] }),
  foreignKey({ name: 'stock_movements_serial_fk', columns: [t.tenantId, t.serialId], foreignColumns: [serials.tenantId, serials.id] }),
  check('stock_movements_type', sql`${t.type} in ('opening_stock', 'received', 'sale', 'used_in_production', 'waste', 'return_restock', 'produced')`),
  check('stock_movements_reference', sql`${t.referenceType} in ('stock_receipt', 'sale', 'pot_record', 'wastage', 'return', 'production')`),
  check('stock_movements_quantity', sql`${t.quantity} <> 0`),
]);

/** Spec 6.27: what one base unit of a made item uses. Separate from bundle and recipe components, which are sold, not made ahead. */
export const productionIngredients = pgTable('production_ingredients', {
  id: id(),
  tenantId: tenantId(),
  variantId: uuid('variant_id').notNull(), // the made item
  ingredientVariantId: uuid('ingredient_variant_id').notNull(),
  quantity: quantity('quantity').notNull(), // ingredient base units per one made base unit
  createdAt: createdAt(),
}, (t) => [
  unique('production_ingredients_pair').on(t.tenantId, t.variantId, t.ingredientVariantId),
  check('production_ingredients_quantity', sql`${t.quantity} > 0`),
  check('production_ingredients_not_self', sql`${t.variantId} <> ${t.ingredientVariantId}`),
  foreignKey({ name: 'production_ingredients_variant_fk', columns: [t.tenantId, t.variantId], foreignColumns: [variants.tenantId, variants.id] }),
  foreignKey({ name: 'production_ingredients_ingredient_fk', columns: [t.tenantId, t.ingredientVariantId], foreignColumns: [variants.tenantId, variants.id] }),
]);

/** One batch made: e.g. 40 loaves baked this morning. */
export const productionRuns = pgTable('production_runs', {
  id: id(),
  tenantId: tenantId(),
  branchId: uuid('branch_id').notNull(),
  variantId: uuid('variant_id').notNull(),
  quantity: quantity('quantity').notNull(),
  unitCost: numeric('unit_cost', { precision: 14, scale: 4 }).notNull(), // pesewas per base unit, from the ingredients' average costs
  userId: uuid('user_id').notNull(),
  createdAt: createdAt(),
}, (t) => [
  unique('production_runs_tenant_id').on(t.tenantId, t.id),
  check('production_runs_quantity', sql`${t.quantity} > 0`),
  foreignKey({ name: 'production_runs_branch_fk', columns: [t.tenantId, t.branchId], foreignColumns: [branches.tenantId, branches.id] }),
  foreignKey({ name: 'production_runs_variant_fk', columns: [t.tenantId, t.variantId], foreignColumns: [variants.tenantId, variants.id] }),
  foreignKey({ name: 'production_runs_user_fk', columns: [t.tenantId, t.userId], foreignColumns: [users.tenantId, users.id] }),
]);

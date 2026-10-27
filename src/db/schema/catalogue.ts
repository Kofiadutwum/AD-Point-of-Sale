import { sql } from 'drizzle-orm';
import { boolean, check, date, foreignKey, integer, jsonb, numeric, pgTable, text, unique, uniqueIndex, uuid } from 'drizzle-orm/pg-core';
import type { Levy } from '@/lib/tax';
import { createdAt, id } from './columns';
import { branches, tenants } from './tenancy';

// Every link between catalogue rows is a composite (tenant_id, id) foreign key, so the database refuses a row
// that points at another shop's data even when a service forgets to check.

export type Tracking = 'none' | 'batch' | 'serial';
export type VariantKind = 'standard' | 'bundle' | 'recipe' | 'combo';
export type CatalogueStatus = 'active' | 'archived';
export type PriceListKind = 'retail' | 'wholesale' | 'customer_group' | 'branch';

const tenantId = () => uuid('tenant_id').notNull().references(() => tenants.id);
/** numeric(14,3): quantities travel as strings such as '1.250' */
const quantity = (name: string) => numeric(name, { precision: 14, scale: 3 });

export const taxRules = pgTable('tax_rules', {
  id: id(),
  tenantId: tenantId(),
  name: text('name').notNull(),
  rateBp: integer('rate_bp').notNull(),
  levies: jsonb('levies').$type<Levy[]>().notNull().default([]),
  vatOnLevies: boolean('vat_on_levies').notNull().default(false),
  isDefault: boolean('is_default').notNull().default(false),
  active: boolean('active').notNull().default(true),
  createdAt: createdAt(),
}, (t) => [
  unique('tax_rules_tenant_id').on(t.tenantId, t.id),
  uniqueIndex('tax_rules_name').on(t.tenantId, sql`lower(${t.name})`),
  uniqueIndex('tax_rules_one_default').on(t.tenantId).where(sql`${t.isDefault}`),
  check('tax_rules_rate', sql`${t.rateBp} between 0 and 10000`),
  check('tax_rules_default_active', sql`not (${t.isDefault} and not ${t.active})`),
]);

export const categories = pgTable('categories', {
  id: id(),
  tenantId: tenantId(),
  name: text('name').notNull(),
  createdAt: createdAt(),
}, (t) => [
  unique('categories_tenant_id').on(t.tenantId, t.id),
  uniqueIndex('categories_name').on(t.tenantId, sql`lower(${t.name})`),
]);

export type KitchenStation = 'kitchen' | 'bar' | 'grill';
export const products = pgTable('products', {
  id: id(),
  tenantId: tenantId(),
  name: text('name').notNull(),
  description: text('description'),
  categoryId: uuid('category_id'),
  brand: text('brand'),
  taxRuleId: uuid('tax_rule_id'), // null = the shop's default rule
  tracking: text('tracking').$type<Tracking>().notNull().default('none'),
  status: text('status').$type<CatalogueStatus>().notNull().default('active'),
  showOnStorefront: boolean('show_on_storefront').notNull().default(false),
  featured: boolean('featured').notNull().default(false),
  genericName: text('generic_name'),
  strength: text('strength'),
  dosageForm: text('dosage_form'),
  registrationNumber: text('registration_number'),
  prescriptionOnly: boolean('prescription_only').notNull().default(false),
  kitchenStation: text('kitchen_station').$type<KitchenStation>().notNull().default('kitchen'), // where its tickets go (spec 4.24)
  createdAt: createdAt(),
}, (t) => [
  unique('products_tenant_id').on(t.tenantId, t.id),
  check('products_kitchen_station', sql`${t.kitchenStation} in ('kitchen', 'bar', 'grill')`),
  foreignKey({ name: 'products_category_fk', columns: [t.tenantId, t.categoryId], foreignColumns: [categories.tenantId, categories.id] }),
  foreignKey({ name: 'products_tax_rule_fk', columns: [t.tenantId, t.taxRuleId], foreignColumns: [taxRules.tenantId, taxRules.id] }),
  check('products_tracking', sql`${t.tracking} in ('none', 'batch', 'serial')`),
  check('products_status', sql`${t.status} in ('active', 'archived')`),
]);

export const variants = pgTable('variants', {
  id: id(),
  tenantId: tenantId(),
  productId: uuid('product_id').notNull(),
  kind: text('kind').$type<VariantKind>().notNull().default('standard'),
  name: text('name').notNull().default(''), // option label such as "Red, Large"; empty for a single variant
  sku: text('sku'),
  allowsFractions: boolean('allows_fractions').notNull().default(false),
  basePricePesewas: integer('base_price_pesewas').notNull(),
  averageCost: numeric('average_cost', { precision: 14, scale: 4 }).notNull().default('0'), // pesewas per base unit
  reorderLevel: quantity('reorder_level'),
  scaleItemCode: integer('scale_item_code'),
  sellable: boolean('sellable').notNull().default(true),
  needsPack: boolean('needs_pack').notNull().default(false), // food: takeaway needs a pack for each unit (spec 6.56)
  sellByAmount: boolean('sell_by_amount').notNull().default(false), // food: rice, stew, waakye sold by cedi amount (spec 6.53)
  minAmountPesewas: integer('min_amount_pesewas'),
  valuePerPotPesewas: integer('value_per_pot_pesewas'), // expected sales from one pot (spec 6.54)
  status: text('status').$type<CatalogueStatus>().notNull().default('active'),
  createdAt: createdAt(),
}, (t) => [
  unique('variants_tenant_id').on(t.tenantId, t.id),
  unique('variants_sku').on(t.tenantId, t.sku),
  unique('variants_scale_code').on(t.tenantId, t.scaleItemCode),
  foreignKey({ name: 'variants_product_fk', columns: [t.tenantId, t.productId], foreignColumns: [products.tenantId, products.id] }),
  check('variants_kind', sql`${t.kind} in ('standard', 'bundle', 'recipe', 'combo')`),
  check('variants_by_amount', sql`not ${t.sellByAmount} or (coalesce(${t.minAmountPesewas}, 0) >= 1 and ${t.kind} in ('standard', 'recipe'))`),
  check('variants_value_per_pot', sql`${t.valuePerPotPesewas} > 0`),
  check('variants_status', sql`${t.status} in ('active', 'archived')`),
  check('variants_price', sql`${t.basePricePesewas} >= 0`),
  check('variants_cost', sql`${t.averageCost} >= 0`),
  check('variants_reorder', sql`${t.reorderLevel} >= 0`),
  check('variants_scale_code_positive', sql`${t.scaleItemCode} > 0`),
]);

export const variantUnits = pgTable('variant_units', {
  id: id(),
  tenantId: tenantId(),
  variantId: uuid('variant_id').notNull(),
  name: text('name').notNull(),
  factor: quantity('factor').notNull(), // base units in one of this unit
  pricePesewas: integer('price_pesewas'), // null = base price × factor
  sellable: boolean('sellable').notNull().default(true),
  purchasable: boolean('purchasable').notNull().default(true),
  isBase: boolean('is_base').notNull().default(false),
  createdAt: createdAt(),
}, (t) => [
  unique('variant_units_tenant_variant_id').on(t.tenantId, t.variantId, t.id),
  uniqueIndex('variant_units_one_base').on(t.variantId).where(sql`${t.isBase}`),
  uniqueIndex('variant_units_name').on(t.variantId, sql`lower(${t.name})`),
  foreignKey({ name: 'variant_units_variant_fk', columns: [t.tenantId, t.variantId], foreignColumns: [variants.tenantId, variants.id] }),
  check('variant_units_factor', sql`(${t.isBase} and ${t.factor} = 1 and ${t.pricePesewas} is null) or (not ${t.isBase} and ${t.factor} > 1)`),
  check('variant_units_price', sql`${t.pricePesewas} >= 0`),
]);

export const barcodes = pgTable('barcodes', {
  id: id(),
  tenantId: tenantId(),
  variantId: uuid('variant_id').notNull(),
  unitId: uuid('unit_id').notNull(),
  code: text('code').notNull(),
  createdAt: createdAt(),
}, (t) => [
  unique('barcodes_code').on(t.tenantId, t.code),
  foreignKey({
    name: 'barcodes_unit_fk', columns: [t.tenantId, t.variantId, t.unitId],
    foreignColumns: [variantUnits.tenantId, variantUnits.variantId, variantUnits.id],
  }).onDelete('cascade'),
]);

export const components = pgTable('components', {
  id: id(),
  tenantId: tenantId(),
  parentVariantId: uuid('parent_variant_id').notNull(),
  componentVariantId: uuid('component_variant_id').notNull(),
  quantity: quantity('quantity').notNull(), // in the component's base units
  createdAt: createdAt(),
}, (t) => [
  unique('components_pair').on(t.parentVariantId, t.componentVariantId),
  foreignKey({ name: 'components_parent_fk', columns: [t.tenantId, t.parentVariantId], foreignColumns: [variants.tenantId, variants.id] }),
  foreignKey({ name: 'components_part_fk', columns: [t.tenantId, t.componentVariantId], foreignColumns: [variants.tenantId, variants.id] }),
  check('components_not_self', sql`${t.parentVariantId} <> ${t.componentVariantId}`),
  check('components_quantity', sql`${t.quantity} > 0`),
]);

export const priceLists = pgTable('price_lists', {
  id: id(),
  tenantId: tenantId(),
  name: text('name').notNull(),
  kind: text('kind').$type<PriceListKind>().notNull(),
  branchId: uuid('branch_id'),
  startsOn: date('starts_on', { mode: 'string' }),
  endsOn: date('ends_on', { mode: 'string' }),
  active: boolean('active').notNull().default(true),
  createdAt: createdAt(),
}, (t) => [
  unique('price_lists_tenant_id').on(t.tenantId, t.id),
  uniqueIndex('price_lists_one_retail').on(t.tenantId).where(sql`${t.kind} = 'retail'`),
  uniqueIndex('price_lists_one_per_branch').on(t.tenantId, t.branchId).where(sql`${t.kind} = 'branch'`),
  foreignKey({ name: 'price_lists_branch_fk', columns: [t.tenantId, t.branchId], foreignColumns: [branches.tenantId, branches.id] }),
  check('price_lists_kind', sql`${t.kind} in ('retail', 'wholesale', 'customer_group', 'branch')`),
  check('price_lists_branch', sql`(${t.kind} = 'branch') = (${t.branchId} is not null)`),
  check('price_lists_retail_undated', sql`${t.kind} <> 'retail' or (${t.startsOn} is null and ${t.endsOn} is null)`),
  check('price_lists_dates', sql`${t.endsOn} >= ${t.startsOn}`),
]);

export const priceListItems = pgTable('price_list_items', {
  id: id(),
  tenantId: tenantId(),
  priceListId: uuid('price_list_id').notNull(),
  variantId: uuid('variant_id').notNull(),
  unitId: uuid('unit_id').notNull(),
  minQuantity: quantity('min_quantity').notNull().default('1'), // in the unit sold
  pricePesewas: integer('price_pesewas').notNull(),
  createdAt: createdAt(),
}, (t) => [
  unique('price_list_items_break').on(t.priceListId, t.unitId, t.minQuantity),
  foreignKey({ name: 'price_list_items_list_fk', columns: [t.tenantId, t.priceListId], foreignColumns: [priceLists.tenantId, priceLists.id] })
    .onDelete('cascade'),
  foreignKey({
    name: 'price_list_items_unit_fk', columns: [t.tenantId, t.variantId, t.unitId],
    foreignColumns: [variantUnits.tenantId, variantUnits.variantId, variantUnits.id],
  }).onDelete('cascade'),
  check('price_list_items_min', sql`${t.minQuantity} > 0`),
  check('price_list_items_price', sql`${t.pricePesewas} >= 0`),
]);

export const productImages = pgTable('product_images', {
  id: id(),
  tenantId: tenantId(),
  productId: uuid('product_id').notNull(),
  storageKey: text('storage_key').notNull().unique(),
  bytes: integer('bytes').notNull(),
  width: integer('width').notNull(),
  height: integer('height').notNull(),
  sortOrder: integer('sort_order').notNull(), // 0 = main photo
  createdAt: createdAt(),
}, (t) => [
  foreignKey({ name: 'product_images_product_fk', columns: [t.tenantId, t.productId], foreignColumns: [products.tenantId, products.id] }),
  check('product_images_bytes', sql`${t.bytes} between 1 and 30720`),
  check('product_images_sort', sql`${t.sortOrder} between 0 and 4`),
]);

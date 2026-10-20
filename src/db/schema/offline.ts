import { sql } from 'drizzle-orm';
import { bigint, check, integer, jsonb, pgTable, text, unique, uuid } from 'drizzle-orm/pg-core';
import { id, timestamptz } from './columns';
import { users } from './people';
import { registers, tenants } from './tenancy';

/** An offline sale the server refused; held for manager review on the dashboard (spec 6.10). */
export const heldSales = pgTable('held_sales', {
  id: id(),
  tenantId: uuid('tenant_id').notNull().references(() => tenants.id),
  registerId: uuid('register_id').notNull().references(() => registers.id),
  saleId: uuid('sale_id').notNull(), // made on the device
  receiptNumber: text('receipt_number').notNull(),
  cashierId: uuid('cashier_id'), // sent by the device; no foreign key so a bad id cannot fail the report
  totalPesewas: integer('total_pesewas').notNull(),
  error: text('error').notNull(),
  sale: jsonb('sale').$type<Record<string, unknown>>().notNull(), // the request the device sent
  deviceCreatedAt: timestamptz('device_created_at').notNull(),
  reportedAt: timestamptz('reported_at').notNull(),
  resolvedAt: timestamptz('resolved_at'),
  resolvedBy: uuid('resolved_by').references(() => users.id),
  resolution: text('resolution').$type<'resolved' | 'synced'>(),
  note: text('note'),
}, (t) => [
  unique('held_sales_sale').on(t.tenantId, t.saleId),
  check('held_sales_total', sql`${t.totalPesewas} >= 0`),
  check('held_sales_resolution', sql`${t.resolution} in ('resolved', 'synced')`),
]);

/** Bumped by triggers whenever data cached on tills changes, so tills know to refetch (spec 6.10). */
export const deviceCacheVersions = pgTable('device_cache_versions', {
  tenantId: uuid('tenant_id').primaryKey().references(() => tenants.id),
  version: bigint('version', { mode: 'number' }).notNull().default(0),
});

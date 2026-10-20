import { sql } from 'drizzle-orm';
import { bigint, check, index, jsonb, pgTable, text, uuid } from 'drizzle-orm/pg-core';
import { createdAt } from './columns';
import { tenants } from './tenancy';

export type ActorType = 'user' | 'platform' | 'anonymous' | 'system';

export const auditLog = pgTable('audit_log', {
  id: bigint('id', { mode: 'number' }).primaryKey().generatedAlwaysAsIdentity(),
  tenantId: uuid('tenant_id').references(() => tenants.id), // null = platform event
  actorType: text('actor_type').$type<ActorType>().notNull(),
  actorId: uuid('actor_id'),
  action: text('action').notNull(),
  recordType: text('record_type'),
  recordId: text('record_id'),
  reason: text('reason'),
  changes: jsonb('changes').$type<Record<string, unknown>>(),
  createdAt: createdAt(),
}, (t) => [
  index('audit_log_tenant_time').on(t.tenantId, t.createdAt),
  check('audit_log_actor_type', sql`${t.actorType} in ('user', 'platform', 'anonymous', 'system')`),
]);

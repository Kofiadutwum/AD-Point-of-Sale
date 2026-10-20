import { integer, pgTable, text, unique, uuid } from 'drizzle-orm/pg-core';
import { createdAt, id, timestamptz } from './columns';
import { users } from './people';
import { tenants } from './tenancy';

/** Single-use MFA recovery codes, stored only as SHA-256 hashes (spec 6.1). */
export const mfaRecoveryCodes = pgTable('mfa_recovery_codes', {
  id: id(),
  tenantId: uuid('tenant_id').notNull().references(() => tenants.id),
  userId: uuid('user_id').notNull().references(() => users.id),
  codeHash: text('code_hash').notNull(),
  usedAt: timestamptz('used_at'),
  createdAt: createdAt(),
}, (t) => [unique('mfa_recovery_codes_hash').on(t.userId, t.codeHash)]);

/** The step between a correct password and a session, for users with MFA on. */
export const mfaChallenges = pgTable('mfa_challenges', {
  id: text('id').primaryKey(), // sha256 of the challenge token
  tenantId: uuid('tenant_id').notNull().references(() => tenants.id),
  userId: uuid('user_id').notNull().references(() => users.id),
  expiresAt: timestamptz('expires_at').notNull(),
  attempts: integer('attempts').notNull().default(0),
  createdAt: createdAt(),
});

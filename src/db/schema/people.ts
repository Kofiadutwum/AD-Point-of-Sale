import { sql } from 'drizzle-orm';
import { bigint, check, integer, pgTable, text, unique, uuid } from 'drizzle-orm/pg-core';
import type { RolePreset } from '@/lib/permissions';
import { createdAt, id, timestamptz } from './columns';
import { registers, tenants } from './tenancy';

export type UserStatus = 'pending_activation' | 'invited' | 'active' | 'inactive';

export const users = pgTable('users', {
  id: id(),
  tenantId: uuid('tenant_id').notNull().references(() => tenants.id),
  name: text('name').notNull(),
  email: text('email'),
  phone: text('phone'),
  rolePreset: text('role_preset').$type<RolePreset>().notNull(),
  permissions: text('permissions').array().notNull(),
  branchIds: uuid('branch_ids').array().notNull().default(sql`'{}'`),
  passwordHash: text('password_hash'),
  pinHash: text('pin_hash'),
  failedPinCount: integer('failed_pin_count').notNull().default(0),
  pinLockedUntil: timestamptz('pin_locked_until'),
  mfaSecret: text('mfa_secret'), // sealed TOTP secret; set while enrolling, kept once mfa_enabled_at is set
  mfaEnabledAt: timestamptz('mfa_enabled_at'),
  mfaLastStep: bigint('mfa_last_step', { mode: 'number' }), // last accepted TOTP step, so a code works once
  status: text('status').$type<UserStatus>().notNull(),
  createdAt: createdAt(),
}, (t) => [
  unique('users_email').on(t.tenantId, t.email),
  unique('users_phone').on(t.tenantId, t.phone),
  check('users_contact', sql`${t.email} is not null or ${t.phone} is not null`),
  check('users_role', sql`${t.rolePreset} in ('owner', 'manager', 'cashier')`),
  check('users_status', sql`${t.status} in ('pending_activation', 'invited', 'active', 'inactive')`),
]);

export const userTokens = pgTable('user_tokens', {
  id: id(),
  tenantId: uuid('tenant_id').notNull().references(() => tenants.id),
  userId: uuid('user_id').notNull().references(() => users.id),
  purpose: text('purpose').$type<'activation' | 'invite'>().notNull(),
  tokenHash: text('token_hash').notNull().unique(),
  expiresAt: timestamptz('expires_at').notNull(),
  usedAt: timestamptz('used_at'),
  createdAt: createdAt(),
}, (t) => [check('user_tokens_purpose', sql`${t.purpose} in ('activation', 'invite')`)]);

export const sessions = pgTable('sessions', {
  id: text('id').primaryKey(), // sha256 of the session token
  tenantId: uuid('tenant_id').notNull().references(() => tenants.id),
  userId: uuid('user_id').notNull().references(() => users.id),
  registerId: uuid('register_id').references(() => registers.id),
  kind: text('kind').$type<'password' | 'pin'>().notNull(),
  expiresAt: timestamptz('expires_at').notNull(),
  createdAt: createdAt(),
}, (t) => [check('sessions_kind', sql`${t.kind} in ('password', 'pin')`)]);

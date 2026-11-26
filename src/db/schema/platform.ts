import { sql } from 'drizzle-orm';
import { integer, jsonb, pgTable, primaryKey, text, uuid } from 'drizzle-orm/pg-core';
import { createdAt, id, timestamptz } from './columns';

export type PlanLimits = { branches: number; registers: number; staff: number; products: number; sms_per_month: number };

export const plans = pgTable('plans', {
  id: text('id').primaryKey(),
  name: text('name').notNull(),
  pricePesewas: integer('price_pesewas').notNull().default(0),
  limits: jsonb('limits').$type<PlanLimits>().notNull(),
  modules: text('modules').array().notNull().default(sql`'{}'`),
});

export const platformAdmins = pgTable('platform_admins', {
  id: id(),
  email: text('email').notNull().unique(),
  name: text('name').notNull(),
  passwordHash: text('password_hash').notNull(),
  createdAt: createdAt(),
});

export const adminSessions = pgTable('admin_sessions', {
  id: text('id').primaryKey(), // sha256 of the session token
  adminId: uuid('admin_id').notNull().references(() => platformAdmins.id),
  expiresAt: timestamptz('expires_at').notNull(),
  createdAt: createdAt(),
});

export const authAttempts = pgTable('auth_attempts', {
  key: text('key').primaryKey(),
  windowStart: timestamptz('window_start').notNull(),
  count: integer('count').notNull(),
});

/** Spec 6.11: a payment-provider event handled once; the key blocks a second run of a redelivered webhook. */
export const processedEvents = pgTable('processed_events', {
  provider: text('provider').notNull(),
  eventType: text('event_type').notNull(),
  reference: text('reference').notNull(),
  createdAt: createdAt(),
}, (t) => [primaryKey({ name: 'processed_events_pk', columns: [t.provider, t.eventType, t.reference] })]);

/** Spec 4.27, 6.48: a self sign-up waiting for its phone and email codes. Codes are stored hashed. */
export const signupVerifications = pgTable('signup_verifications', {
  id: id(),
  shopName: text('shop_name').notNull(),
  shopType: text('shop_type').notNull(),
  slug: text('slug').notNull(),
  ownerName: text('owner_name').notNull(),
  email: text('email').notNull(),
  phone: text('phone').notNull(),
  smsCodeHash: text('sms_code_hash').notNull(),
  emailCodeHash: text('email_code_hash').notNull(),
  attempts: integer('attempts').notNull().default(0),
  expiresAt: timestamptz('expires_at').notNull(),
  usedAt: timestamptz('used_at'),
  createdAt: createdAt(),
});

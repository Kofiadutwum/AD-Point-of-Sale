import { sql } from 'drizzle-orm';
import { integer, jsonb, pgTable, text, uuid } from 'drizzle-orm/pg-core';
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

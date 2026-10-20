import 'server-only';
import { sql } from 'drizzle-orm';
import { z } from 'zod';
import type { Db, Tx } from './client';

const tenantIdSchema = z.uuid();

/** Runs fn as role pos_app with app.tenant_id set, so row-level security filters every query. */
export async function withTenant<T>(db: Db, tenantId: string, fn: (tx: Tx) => Promise<T>): Promise<T> {
  if (!tenantIdSchema.safeParse(tenantId).success) throw new Error('invalid tenant id');
  return db.transaction(async (tx) => {
    await tx.execute(sql`set local role pos_app`);
    await tx.execute(sql`select set_config('app.tenant_id', ${tenantId}, true)`);
    return fn(tx);
  });
}

/** Runs fn as the owner role, which row-level security does not apply to. Pre-sign-in and platform code only. */
export function asPlatform<T>(db: Db, fn: (tx: Tx) => Promise<T>): Promise<T> {
  return db.transaction(fn);
}

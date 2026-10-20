import 'server-only';
import { eq, sql } from 'drizzle-orm';
import type { Tx } from '@/db/client';
import { authAttempts } from '@/db/schema';

export const MAX_ATTEMPTS = 10;
export const WINDOW_MINUTES = 15;
const WINDOW_MS = WINDOW_MINUTES * 60_000;

export async function tooManyAttempts(tx: Tx, key: string, now: Date): Promise<boolean> {
  const [row] = await tx.select().from(authAttempts).where(eq(authAttempts.key, key));
  return !!row && row.windowStart.getTime() > now.getTime() - WINDOW_MS && row.count >= MAX_ATTEMPTS;
}

/** One upsert: a window older than 15 minutes restarts at 1, otherwise the count goes up by one. */
export async function countFailedAttempt(tx: Tx, key: string, now: Date): Promise<void> {
  const expired = sql`${authAttempts.windowStart} <= ${new Date(now.getTime() - WINDOW_MS).toISOString()}::timestamptz`;
  await tx.insert(authAttempts).values({ key, windowStart: now, count: 1 }).onConflictDoUpdate({
    target: authAttempts.key,
    set: {
      count: sql`case when ${expired} then 1 else ${authAttempts.count} + 1 end`,
      windowStart: sql`case when ${expired} then ${now.toISOString()}::timestamptz else ${authAttempts.windowStart} end`,
    },
  });
}

export async function clearAttempts(tx: Tx, key: string): Promise<void> {
  await tx.delete(authAttempts).where(eq(authAttempts.key, key));
}

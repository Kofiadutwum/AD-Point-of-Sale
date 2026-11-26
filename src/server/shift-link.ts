import 'server-only';
import { and, eq } from 'drizzle-orm';
import type { Tx } from '@/db/client';
import { shifts } from '@/db/schema';

/** The register's open shift, if any (spec 6.14): sales, cash refunds, and cash expenses at that till belong to it. */
export async function openShiftId(tx: Tx, registerId: string): Promise<string | null> {
  const [s] = await tx.select({ id: shifts.id }).from(shifts).where(and(eq(shifts.registerId, registerId), eq(shifts.status, 'open')));
  return s?.id ?? null;
}

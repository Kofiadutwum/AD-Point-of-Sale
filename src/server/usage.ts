import 'server-only';
import { inArray } from 'drizzle-orm';
import type { Tx } from '@/db/client';
import { saleLines, stockMovements } from '@/db/schema';

/** True once any of these variants has stock history or has been sold; their tracking, fractions, and unit sizes are then fixed. */
export async function variantsInUse(tx: Tx, variantIds: string[]): Promise<boolean> {
  if (variantIds.length === 0) return false;
  const [moved] = await tx.select({ id: stockMovements.id }).from(stockMovements).where(inArray(stockMovements.variantId, variantIds)).limit(1);
  if (moved) return true;
  const [sold] = await tx.select({ id: saleLines.id }).from(saleLines).where(inArray(saleLines.variantId, variantIds)).limit(1);
  return Boolean(sold);
}

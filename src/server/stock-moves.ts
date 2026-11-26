import 'server-only';
import { and, eq, sql } from 'drizzle-orm';
import type { Tx } from '@/db/client';
import { type MovementType, products, stockBalances, stockBatches, stockMovements, variants, variantUnits } from '@/db/schema';
import { multiplyQty, parseQuantity, toMilli, validSaleQuantity } from '@/lib/decimal';
import type { Ctx } from './context';
import { isUuid, itemLabel } from './products';
import { changeBalance } from './stock';

// Shared by transfers, supplier returns, counts, and adjustments. Serial-tracked items are not handled here.

export type MoveLine = { variantId: string; unitId: string; quantity: string; batchNumber?: string };
export type ResolvedLine = { variantId: string; baseQty: string; tracking: 'none' | 'batch'; averageCost: string; name: string; batchNumber: string | null };
export type LineError = 'unknown_item' | 'not_stocked' | 'invalid_quantity' | 'serial_tracked' | 'batch_required';

type MovementRef = { type: MovementType; referenceType: 'transfer' | 'supplier_return' | 'stock_count' | 'adjustment'; referenceId: string };

/** A line typed in any unit becomes base units of a stocked, untracked or batch-tracked variant. */
export async function resolveLine(tx: Tx, line: MoveLine): Promise<ResolvedLine | LineError> {
  if (!isUuid(line.variantId) || !isUuid(line.unitId)) return 'unknown_item';
  const [item] = await tx.select({
    factor: variantUnits.factor, isBase: variantUnits.isBase, kind: variants.kind, allowsFractions: variants.allowsFractions, averageCost: variants.averageCost,
    tracking: products.tracking, productName: products.name, variantName: variants.name,
  }).from(variantUnits).innerJoin(variants, eq(variants.id, variantUnits.variantId)).innerJoin(products, eq(products.id, variants.productId))
    .where(and(eq(variantUnits.id, line.unitId), eq(variantUnits.variantId, line.variantId)));
  if (!item) return 'unknown_item';
  if (item.kind !== 'standard') return 'not_stocked';
  if (item.tracking === 'serial') return 'serial_tracked'; // shortcut: serial items move only by sale and receipt for now; add serial pickers when shops ask
  const quantity = parseQuantity(line.quantity);
  if (!validSaleQuantity(quantity, item.isBase && item.allowsFractions)) return 'invalid_quantity';
  const batchNumber = line.batchNumber?.trim() || null;
  if (item.tracking === 'batch' && !batchNumber) return 'batch_required';
  return { variantId: line.variantId, baseQty: multiplyQty(quantity!, item.factor), tracking: item.tracking, averageCost: item.averageCost, name: itemLabel(item.productName, item.variantName), batchNumber };
}

/** Removes stock at a branch (and from the named batch). With `requireStock`, refuses to go below zero. */
export async function takeStock(tx: Tx, ctx: Ctx, branchId: string, line: ResolvedLine, ref: MovementRef, requireStock: boolean): Promise<
  { ok: true; batchId: string | null; expiryDate: string | null } | { ok: false; error: 'not_enough_stock' | 'unknown_batch' }
> {
  let batchId: string | null = null;
  let expiryDate: string | null = null;
  if (line.tracking === 'batch') {
    const [b] = await tx.select().from(stockBatches).where(and(eq(stockBatches.branchId, branchId), eq(stockBatches.variantId, line.variantId), eq(stockBatches.batchNumber, line.batchNumber!))).for('update');
    if (!b) return { ok: false, error: 'unknown_batch' };
    if (requireStock && toMilli(b.onHand) < toMilli(line.baseQty)) return { ok: false, error: 'not_enough_stock' };
    await tx.update(stockBatches).set({ onHand: sql`${stockBatches.onHand} - ${line.baseQty}::numeric` }).where(eq(stockBatches.id, b.id));
    batchId = b.id;
    expiryDate = b.expiryDate;
  } else if (requireStock) {
    const [bal] = await tx.select({ onHand: stockBalances.onHand }).from(stockBalances)
      .where(and(eq(stockBalances.branchId, branchId), eq(stockBalances.variantId, line.variantId))).for('update');
    if (!bal || toMilli(bal.onHand) < toMilli(line.baseQty)) return { ok: false, error: 'not_enough_stock' };
  }
  await changeBalance(tx, ctx.tenantId, branchId, line.variantId, line.baseQty, true);
  await tx.insert(stockMovements).values({
    tenantId: ctx.tenantId, branchId, variantId: line.variantId, type: ref.type, quantity: `-${line.baseQty}`, batchId, referenceType: ref.referenceType, referenceId: ref.referenceId, userId: ctx.userId,
  });
  return { ok: true, batchId, expiryDate };
}

/** Adds stock at a branch, into the named batch (created with its expiry when new). Average cost is unchanged: the stock was already ours. */
export async function putStock(tx: Tx, ctx: Ctx, branchId: string, variantId: string, baseQty: string, batch: { number: string; expiry: string } | null, ref: MovementRef): Promise<void> {
  let batchId: string | null = null;
  if (batch) {
    const [b] = await tx.insert(stockBatches).values({ tenantId: ctx.tenantId, branchId, variantId, batchNumber: batch.number, expiryDate: batch.expiry, onHand: baseQty })
      .onConflictDoUpdate({ target: [stockBatches.tenantId, stockBatches.branchId, stockBatches.variantId, stockBatches.batchNumber], set: { onHand: sql`${stockBatches.onHand} + ${baseQty}::numeric` } })
      .returning({ id: stockBatches.id });
    batchId = b.id;
  }
  await changeBalance(tx, ctx.tenantId, branchId, variantId, baseQty);
  await tx.insert(stockMovements).values({ tenantId: ctx.tenantId, branchId, variantId, type: ref.type, quantity: baseQty, batchId, referenceType: ref.referenceType, referenceId: ref.referenceId, userId: ctx.userId });
}

/** Value of a base quantity at average cost, in whole pesewas. */
export const valueOf = (baseQty: string, averageCost: string) => Math.round(Math.abs(Number(baseQty)) * Number(averageCost));

import 'server-only';
import { and, asc, eq, gt, inArray, sql } from 'drizzle-orm';
import { z } from 'zod';
import type { Db, Tx } from '@/db/client';
import {
  barcodes, branches, components, products, serials, stockBalances, stockBatches, stockMovements, stockReceipts, type Tracking, variants, variantUnits,
} from '@/db/schema';
import { withTenant } from '@/db/tenant';
import { normaliseBarcode } from '@/lib/barcode';
import { todayIn } from '@/lib/dates';
import { fromMilli, multiplyQty, parseQuantity, toMilli, validSaleQuantity } from '@/lib/decimal';
import { unitCostOf, weightedAverageCost } from '@/lib/stock';
import { writeAudit } from './audit';
import { assertPermission, type Ctx } from './context';
import { type Fail, fail, isUuid, itemLabel, normaliseSku } from './products';

export type ReceiveLine = {
  variantId: string; unitId: string; quantity: string; totalCostPesewas: number; batchNumber?: string; expiryDate?: string; serials?: string[];
};
export type ReceiveError = 'invalid_input' | 'unknown_branch' | 'unknown_item' | 'not_purchasable' | 'not_stocked' | 'invalid_quantity'
  | 'batch_required' | 'expired_batch' | 'batch_expiry_mismatch' | 'serials_mismatch' | 'duplicate_serial';

const lineSchema = z.object({
  variantId: z.string(), unitId: z.string(), quantity: z.string(), totalCostPesewas: z.number().int().min(0).max(2_000_000_000),
  batchNumber: z.string().optional(), expiryDate: z.string().optional(), serials: z.array(z.string()).max(1000).optional(),
});
const receiptSchema = z.object({
  branchId: z.string(), kind: z.enum(['received', 'opening_stock']),
  supplierName: z.string().trim().max(80).optional(), note: z.string().trim().max(200).optional(),
  lines: z.array(lineSchema).min(1).max(100),
});
const isoDate = z.iso.date();

/** On-hand in base units at one branch; '0.000' before any stock. May be negative. */
export async function stockOnHand(tx: Tx, branchId: string, variantId: string): Promise<string> {
  const [b] = await tx.select({ onHand: stockBalances.onHand }).from(stockBalances)
    .where(and(eq(stockBalances.branchId, branchId), eq(stockBalances.variantId, variantId)));
  return b?.onHand ?? '0.000';
}

async function shopOnHand(tx: Tx, variantId: string): Promise<string> {
  const [r] = await tx.select({ total: sql<string>`coalesce(sum(${stockBalances.onHand}), 0)::numeric(14,3)::text` })
    .from(stockBalances).where(eq(stockBalances.variantId, variantId));
  return r.total;
}

/** Adds (or with `subtract`, removes) base units at a branch in SQL, since balances may go below zero; true when the result is negative. */
export async function changeBalance(tx: Tx, tenantId: string, branchId: string, variantId: string, qty: string, subtract = false): Promise<boolean> {
  const delta = subtract ? sql`(0 - ${qty}::numeric)` : sql`${qty}::numeric`;
  const [row] = await tx.insert(stockBalances).values({ tenantId, branchId, variantId, onHand: sql`${delta}` as unknown as string })
    .onConflictDoUpdate({
      target: [stockBalances.tenantId, stockBalances.branchId, stockBalances.variantId],
      set: { onHand: sql`${stockBalances.onHand} + ${delta}`, updatedAt: sql`now()` },
    }).returning({ negative: sql<boolean>`${stockBalances.onHand} < 0` });
  return row.negative;
}

type PlannedLine = {
  variantId: string; tracking: Tracking; baseQty: string; unitCost: string; batch: { number: string; expiry: string } | null; serials: string[];
};

/** Spec 6.23 (and opening stock, 6.3). Every line is checked before anything is written, so a refusal saves nothing. */
export async function receiveStock(
  db: Db, ctx: Ctx, input: { branchId: string; kind: 'received' | 'opening_stock'; supplierName?: string; note?: string; lines: ReceiveLine[] }, now: Date,
): Promise<{ ok: true; receiptId: string } | Fail<ReceiveError>> {
  assertPermission(ctx, 'receive_stock');
  const parsed = receiptSchema.safeParse(input);
  if (!parsed.success) return fail('invalid_input');
  const r = parsed.data;
  if (!isUuid(r.branchId)) return fail('unknown_branch');
  const today = todayIn(ctx.timezone, now);

  return withTenant(db, ctx.tenantId, async (tx) => {
    const [branch] = await tx.select({ id: branches.id }).from(branches).where(eq(branches.id, r.branchId));
    if (!branch) return fail('unknown_branch');

    const planned: PlannedLine[] = [];
    const seenSerials = new Set<string>();
    const seenBatches = new Map<string, string>();
    for (const [i, line] of r.lines.entries()) {
      const at = String(i);
      if (!isUuid(line.variantId) || !isUuid(line.unitId)) return fail('unknown_item', at);
      const [item] = await tx.select({
        factor: variantUnits.factor, isBase: variantUnits.isBase, purchasable: variantUnits.purchasable,
        kind: variants.kind, allowsFractions: variants.allowsFractions, tracking: products.tracking,
      }).from(variantUnits)
        .innerJoin(variants, eq(variants.id, variantUnits.variantId))
        .innerJoin(products, eq(products.id, variants.productId))
        .where(and(eq(variantUnits.id, line.unitId), eq(variantUnits.variantId, line.variantId)));
      if (!item) return fail('unknown_item', at);
      if (item.kind !== 'standard') return fail('not_stocked', at); // bundles and recipes hold no stock (4.18)
      if (!item.purchasable) return fail('not_purchasable', at);
      const quantity = parseQuantity(line.quantity);
      if (!validSaleQuantity(quantity, item.isBase && item.allowsFractions)) return fail('invalid_quantity', at);
      const baseQty = multiplyQty(quantity!, item.factor);
      let batch: PlannedLine['batch'] = null;
      let lineSerials: string[] = [];
      if (item.tracking === 'batch') {
        const number = line.batchNumber?.trim() ?? '';
        const expiry = line.expiryDate?.trim() ?? '';
        if (!number || number.length > 40 || !isoDate.safeParse(expiry).success) return fail('batch_required', at);
        if (expiry <= today) return fail('expired_batch', at); // expiring today counts as expired
        const key = `${line.variantId}/${number}`;
        const [saved] = await tx.select({ expiry: stockBatches.expiryDate }).from(stockBatches).where(and(
          eq(stockBatches.branchId, r.branchId), eq(stockBatches.variantId, line.variantId), eq(stockBatches.batchNumber, number)));
        const known = saved?.expiry ?? seenBatches.get(key);
        if (known !== undefined && known !== expiry) return fail('batch_expiry_mismatch', at);
        seenBatches.set(key, expiry);
        batch = { number, expiry };
      } else if (item.tracking === 'serial') {
        lineSerials = (line.serials ?? []).map((s) => s.trim());
        if (lineSerials.some((s) => !s || s.length > 64) || toMilli(baseQty) !== BigInt(lineSerials.length) * 1000n) return fail('serials_mismatch', at);
        for (const s of lineSerials) {
          if (seenSerials.has(`${line.variantId}/${s}`)) return fail('duplicate_serial', at);
          seenSerials.add(`${line.variantId}/${s}`);
        }
        const [taken] = await tx.select({ id: serials.id }).from(serials)
          .where(and(eq(serials.variantId, line.variantId), inArray(serials.serial, lineSerials))).limit(1);
        if (taken) return fail('duplicate_serial', at);
      }
      planned.push({ variantId: line.variantId, tracking: item.tracking, baseQty, unitCost: unitCostOf(line.totalCostPesewas, baseQty), batch, serials: lineSerials });
    }

    const [receipt] = await tx.insert(stockReceipts).values({
      tenantId: ctx.tenantId, branchId: r.branchId, kind: r.kind, supplierName: r.supplierName || null, note: r.note || null, receivedBy: ctx.userId,
    }).returning({ id: stockReceipts.id });
    const movement = { tenantId: ctx.tenantId, branchId: r.branchId, type: r.kind, referenceType: 'stock_receipt' as const, referenceId: receipt.id, userId: ctx.userId };

    for (const p of planned) {
      // average cost is per variant across all branches, from the stock held just before this line
      const [v] = await tx.select({ averageCost: variants.averageCost }).from(variants).where(eq(variants.id, p.variantId));
      const averageCost = weightedAverageCost(await shopOnHand(tx, p.variantId), v.averageCost, p.baseQty, p.unitCost);
      await tx.update(variants).set({ averageCost }).where(eq(variants.id, p.variantId));
      await changeBalance(tx, ctx.tenantId, r.branchId, p.variantId, p.baseQty);
      if (p.batch) {
        const [b] = await tx.insert(stockBatches).values({
          tenantId: ctx.tenantId, branchId: r.branchId, variantId: p.variantId, batchNumber: p.batch.number, expiryDate: p.batch.expiry, onHand: p.baseQty,
        }).onConflictDoUpdate({
          target: [stockBatches.tenantId, stockBatches.branchId, stockBatches.variantId, stockBatches.batchNumber],
          set: { onHand: sql`${stockBatches.onHand} + ${p.baseQty}::numeric` },
        }).returning({ id: stockBatches.id });
        await tx.insert(stockMovements).values({ ...movement, variantId: p.variantId, quantity: p.baseQty, batchId: b.id, unitCost: p.unitCost });
      } else if (p.tracking === 'serial') {
        for (const s of p.serials) {
          const [row] = await tx.insert(serials).values({ tenantId: ctx.tenantId, variantId: p.variantId, branchId: r.branchId, serial: s })
            .returning({ id: serials.id });
          await tx.insert(stockMovements).values({ ...movement, variantId: p.variantId, quantity: '1', serialId: row.id, unitCost: p.unitCost });
        }
      } else {
        await tx.insert(stockMovements).values({ ...movement, variantId: p.variantId, quantity: p.baseQty, unitCost: p.unitCost });
      }
    }
    await writeAudit(tx, {
      tenantId: ctx.tenantId, actorType: 'user', actorId: ctx.userId, action: 'stock_received', recordType: 'stock_receipt', recordId: receipt.id,
      changes: { kind: r.kind, lines: planned.length },
    });
    return { ok: true, receiptId: receipt.id } as const;
  });
}

export type DeductProblems = { negative: boolean; onlyExpired: boolean; serialsMissing: boolean };

const minus = (milli: bigint) => `-${fromMilli(milli)}`;

/**
 * Spec 6.28, inside the sale's transaction. Bundles and recipes deduct their components; batch items take the earliest unexpired
 * batch first; serial items mark each serial sold. Problems are reported, never refused here: the caller decides (6.8, 6.10).
 */
export async function deductStockForLine(
  tx: Tx, s: { tenantId: string; branchId: string; saleId: string; saleLineId: string; userId: string; today: string },
  line: { variantId: string; baseQty: string; serials: string[]; choices?: string[] },
): Promise<DeductProblems> {
  const [v] = await tx.select({ kind: variants.kind, tracking: products.tracking }).from(variants)
    .innerJoin(products, eq(products.id, variants.productId)).where(eq(variants.id, line.variantId));
  if (!v) throw new Error(`unknown variant ${line.variantId}`);
  const problems: DeductProblems = { negative: false, onlyExpired: false, serialsMissing: false };

  if (v.kind !== 'standard') { // bundles and recipes hold no stock of their own
    const parts = await tx.select({ id: components.componentVariantId, quantity: components.quantity }).from(components)
      .where(eq(components.parentVariantId, line.variantId)).orderBy(asc(components.createdAt), asc(components.id));
    for (const part of parts) {
      const p = await deductStockForLine(tx, s, { variantId: part.id, baseQty: multiplyQty(part.quantity, line.baseQty), serials: [] });
      problems.negative ||= p.negative;
      problems.onlyExpired ||= p.onlyExpired;
      problems.serialsMissing ||= p.serialsMissing;
    }
    // a combo also gives what the customer chose; a chosen recipe gives its ingredients (spec 6.52)
    for (const chosen of line.choices ?? []) {
      const p = await deductStockForLine(tx, s, { variantId: chosen, baseQty: line.baseQty, serials: [] });
      problems.negative ||= p.negative;
      problems.onlyExpired ||= p.onlyExpired;
      problems.serialsMissing ||= p.serialsMissing;
    }
    return problems;
  }

  const move = (quantity: string, extra: { batchId?: string; serialId?: string } = {}) => tx.insert(stockMovements).values({
    tenantId: s.tenantId, branchId: s.branchId, variantId: line.variantId, type: 'sale', quantity, referenceType: 'sale', referenceId: s.saleId,
    saleLineId: s.saleLineId, userId: s.userId, ...extra,
  });
  const takeFromBatch = (batchId: string, milli: bigint) => tx.update(stockBatches)
    .set({ onHand: sql`${stockBatches.onHand} - ${fromMilli(milli)}::numeric` }).where(eq(stockBatches.id, batchId));
  let left = toMilli(line.baseQty);

  if (v.tracking === 'batch') {
    const here = and(eq(stockBatches.branchId, s.branchId), eq(stockBatches.variantId, line.variantId));
    const live = await tx.select({ id: stockBatches.id, onHand: stockBatches.onHand }).from(stockBatches)
      .where(and(here, sql`${stockBatches.onHand} > 0`, gt(stockBatches.expiryDate, s.today)))
      .orderBy(asc(stockBatches.expiryDate), asc(stockBatches.createdAt)).for('update');
    if (live.length === 0) {
      const [stocked] = await tx.select({ id: stockBatches.id }).from(stockBatches).where(and(here, sql`${stockBatches.onHand} > 0`)).limit(1);
      problems.onlyExpired = Boolean(stocked); // expired stock is never sold (4.17)
    }
    for (const b of live) {
      const take = left < toMilli(b.onHand) ? left : toMilli(b.onHand);
      if (take <= 0n) break;
      await takeFromBatch(b.id, take);
      await move(minus(take), { batchId: b.id });
      left -= take;
    }
    if (left > 0n) { // batched stock ran out: the rest goes to the first unexpired batch, which goes negative
      const [target] = live.length ? live : await tx.select({ id: stockBatches.id }).from(stockBatches)
        .where(and(here, gt(stockBatches.expiryDate, s.today))).orderBy(asc(stockBatches.expiryDate), asc(stockBatches.createdAt)).limit(1);
      if (target) await takeFromBatch(target.id, left);
      await move(minus(left), target ? { batchId: target.id } : {});
    }
  } else if (v.tracking === 'serial') {
    for (const serial of line.serials) {
      if (left <= 0n) break;
      const [row] = await tx.update(serials).set({ status: 'sold', saleId: s.saleId, soldAt: sql`now()` as unknown as Date }).where(and(
        eq(serials.variantId, line.variantId), eq(serials.branchId, s.branchId), eq(serials.serial, serial), eq(serials.status, 'in_stock'),
      )).returning({ id: serials.id });
      if (!row) continue;
      await move('-1', { serialId: row.id });
      left -= 1000n;
    }
    if (left > 0n) {
      problems.serialsMissing = true;
      await move(minus(left));
    }
  } else {
    await move(minus(left));
  }

  problems.negative = await changeBalance(tx, s.tenantId, s.branchId, line.variantId, line.baseQty, true);
  if (problems.negative) {
    await writeAudit(tx, {
      tenantId: s.tenantId, actorType: 'system', actorId: null, action: 'negative_stock', recordType: 'variant', recordId: line.variantId,
      changes: { branchId: s.branchId, saleId: s.saleId },
    });
  }
  return problems;
}

/** An item to receive by barcode (its own unit) or SKU (the base unit). */
export async function lookupStockItem(
  db: Db, ctx: Ctx, code: string,
): Promise<{ variantId: string; unitId: string; name: string; unitName: string; tracking: Tracking } | null> {
  assertPermission(ctx, 'receive_stock');
  const barcode = typeof code === 'string' ? normaliseBarcode(code) : null;
  const sku = typeof code === 'string' ? normaliseSku(code) : null;
  if (!barcode && !sku) return null;
  return withTenant(db, ctx.tenantId, async (tx) => {
    const cols = {
      variantId: variants.id, unitId: variantUnits.id, productName: products.name, variantName: variants.name, unitName: variantUnits.name,
      tracking: products.tracking,
    };
    const [byBarcode] = barcode ? await tx.select(cols).from(barcodes)
      .innerJoin(variantUnits, eq(variantUnits.id, barcodes.unitId))
      .innerJoin(variants, eq(variants.id, barcodes.variantId))
      .innerJoin(products, eq(products.id, variants.productId)).where(eq(barcodes.code, barcode)) : [];
    const [bySku] = !byBarcode && sku ? await tx.select(cols).from(variants)
      .innerJoin(variantUnits, and(eq(variantUnits.variantId, variants.id), eq(variantUnits.isBase, true)))
      .innerJoin(products, eq(products.id, variants.productId)).where(eq(variants.sku, sku)) : [];
    const hit = byBarcode ?? bySku;
    return hit ? { variantId: hit.variantId, unitId: hit.unitId, name: itemLabel(hit.productName, hit.variantName), unitName: hit.unitName, tracking: hit.tracking } : null;
  });
}

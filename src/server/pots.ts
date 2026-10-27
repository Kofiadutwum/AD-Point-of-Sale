import 'server-only';
import { and, asc, eq, isNull, lt, sql } from 'drizzle-orm';
import { z } from 'zod';
import type { Db, Tx } from '@/db/client';
import { foodSettings, potRecords, products, saleLines, sales, tenants, users, variants, wastageEntries } from '@/db/schema';
import { withTenant } from '@/db/tenant';
import { addDays, businessDate } from '@/lib/dates';
import { divHalfUp, parseQuantity, toMilli } from '@/lib/decimal';
import { potVariance } from '@/lib/food';
import { writeAudit } from './audit';
import { assertPermission, type Ctx } from './context';
import type { Fail } from './products';
import { deductRecipe } from './stock';
import { costOf } from './variants';

export type PotRow = {
  id: string; variantId: string; name: string; businessDate: string; cooked: string; carriedIn: string; leftover: string | null;
  expectedPesewas: number | null; actualPesewas: number | null; variancePesewas: number | null; flagged: boolean; closed: boolean;
};

const isUuid = (value: string) => z.uuid().safeParse(value).success;

/** Pesewas for `qty` base units at a 4-place cost per unit, rounded half up. */
export function costFor(cost: string, qty: string): number {
  const [whole, frac = ''] = cost.split('.');
  const scaled = BigInt(whole) * 10000n + BigInt((frac + '0000').slice(0, 4));
  return Number(divHalfUp(scaled * toMilli(qty), 10_000_000n));
}

async function shopDay(tx: Tx, ctx: Ctx, branchId: string, now: Date): Promise<{ today: string; assigned: boolean }> {
  const [shop] = await tx.select({ timezone: tenants.timezone, cutoff: tenants.businessDayCutoff }).from(tenants).where(eq(tenants.id, ctx.tenantId));
  const [me] = await tx.select({ branchIds: users.branchIds }).from(users).where(eq(users.id, ctx.userId));
  return { today: businessDate(shop.timezone, shop.cutoff, now), assigned: isUuid(branchId) && (me?.branchIds.includes(branchId) ?? false) };
}

/** A pot recipe is the components of a recipe item; a plain by-amount item has none, so pots move no stock (spec 6.54). */
async function deductPots(tx: Tx, s: { tenantId: string; branchId: string; userId: string }, variantId: string, qty: string,
  type: 'used_in_production' | 'waste', ref: { type: 'pot_record' | 'wastage'; id: string }): Promise<void> {
  const [v] = await tx.select({ kind: variants.kind }).from(variants).where(eq(variants.id, variantId));
  if (v?.kind === 'recipe') await deductRecipe(tx, s, variantId, qty, type, ref);
}

const potColumns = {
  id: potRecords.id, variantId: potRecords.variantId, name: products.name, businessDate: potRecords.businessDate, cooked: potRecords.cooked,
  carriedIn: potRecords.carriedIn, leftover: potRecords.leftover, expectedPesewas: potRecords.expectedPesewas, actualPesewas: potRecords.actualPesewas,
  variancePesewas: potRecords.variancePesewas, flagged: potRecords.flagged, closedAt: potRecords.closedAt,
};
const toRow = ({ closedAt, ...r }: { closedAt: Date | null } & Omit<PotRow, 'closed'>): PotRow => ({ ...r, closed: closedAt !== null });

/** Spec 6.54: adds pots to today's record and takes one pot recipe per pot out of stock. */
export async function recordPots(
  db: Db, ctx: Ctx, input: { branchId: string; variantId: string; pots: string }, now: Date,
): Promise<{ ok: true; cooked: string } | Fail<'invalid_input' | 'not_assigned' | 'not_sold_by_amount' | 'already_closed'>> {
  assertPermission(ctx, 'record_kitchen_stock');
  const pots = typeof input.pots === 'string' ? parseQuantity(input.pots) : null;
  if (!pots || toMilli(pots) <= 0n || typeof input.variantId !== 'string') return { ok: false, error: 'invalid_input' };
  return withTenant(db, ctx.tenantId, async (tx) => {
    const { today, assigned } = await shopDay(tx, ctx, input.branchId, now);
    if (!assigned) return { ok: false, error: 'not_assigned' } as const;
    const [item] = isUuid(input.variantId) ? await tx.select({ sellByAmount: variants.sellByAmount }).from(variants).where(eq(variants.id, input.variantId)) : [];
    if (!item?.sellByAmount) return { ok: false, error: 'not_sold_by_amount' } as const;
    const [pot] = await tx.insert(potRecords).values({ tenantId: ctx.tenantId, branchId: input.branchId, variantId: input.variantId, businessDate: today, cooked: pots })
      .onConflictDoUpdate({
        target: [potRecords.tenantId, potRecords.branchId, potRecords.variantId, potRecords.businessDate],
        set: { cooked: sql`${potRecords.cooked} + ${pots}::numeric` }, setWhere: isNull(potRecords.closedAt),
      }).returning({ id: potRecords.id, cooked: potRecords.cooked });
    if (!pot) return { ok: false, error: 'already_closed' } as const;
    await deductPots(tx, { tenantId: ctx.tenantId, branchId: input.branchId, userId: ctx.userId }, input.variantId, pots, 'used_in_production', { type: 'pot_record', id: pot.id });
    await writeAudit(tx, { tenantId: ctx.tenantId, actorType: 'user', actorId: ctx.userId, action: 'pots_recorded', recordType: 'pot_record', recordId: pot.id, changes: { pots } });
    return { ok: true, cooked: pot.cooked } as const;
  });
}

/** Spec 6.54: what by-amount lines of the item took at a branch on a business day, in completed sales only. */
export async function potActualSales(tx: Tx, branchId: string, variantId: string, day: string): Promise<number> {
  const [{ total }] = await tx.select({ total: sql<number>`coalesce(sum(${saleLines.grossPesewas} - ${saleLines.discountPesewas}), 0)::int` })
    .from(saleLines).innerJoin(sales, eq(sales.id, saleLines.saleId)).where(and(
      eq(sales.branchId, branchId), eq(sales.businessDate, day), eq(sales.status, 'completed'), eq(saleLines.variantId, variantId), eq(saleLines.byAmount, true),
    ));
  return total;
}

/**
 * Spec 6.54: the closing count for today or yesterday. Works out expected against actual sales, flags a large gap, then carries the
 * leftover to the next business day or wastes it.
 */
export async function recordClosingLeftover(
  db: Db, ctx: Ctx, input: { branchId: string; variantId: string; leftover: string; businessDate?: string }, now: Date,
): Promise<{ ok: true; pot: PotRow } | Fail<'invalid_input' | 'not_assigned' | 'no_pots' | 'already_closed' | 'leftover_above_cooked' | 'too_old'>> {
  assertPermission(ctx, 'record_kitchen_stock');
  const leftover = typeof input.leftover === 'string' ? parseQuantity(input.leftover) : null;
  if (leftover === null || typeof input.variantId !== 'string' || (input.businessDate !== undefined && !/^\d{4}-\d{2}-\d{2}$/.test(input.businessDate))) {
    return { ok: false, error: 'invalid_input' };
  }
  return withTenant(db, ctx.tenantId, async (tx) => {
    const { today, assigned } = await shopDay(tx, ctx, input.branchId, now);
    if (!assigned) return { ok: false, error: 'not_assigned' } as const;
    const day = input.businessDate ?? today;
    if (day !== today && day !== addDays(today, -1)) return { ok: false, error: 'too_old' } as const;
    const [pot] = isUuid(input.variantId) ? await tx.select().from(potRecords).where(and(
      eq(potRecords.branchId, input.branchId), eq(potRecords.variantId, input.variantId), eq(potRecords.businessDate, day),
    )).for('update') : [];
    if (!pot) return { ok: false, error: 'no_pots' } as const;
    if (pot.closedAt) return { ok: false, error: 'already_closed' } as const;
    if (toMilli(leftover) > toMilli(pot.cooked)) return { ok: false, error: 'leftover_above_cooked' } as const;

    const [item] = await tx.select({ valuePerPot: variants.valuePerPotPesewas }).from(variants).where(eq(variants.id, pot.variantId));
    const [settings] = await tx.select().from(foodSettings);
    const actual = await potActualSales(tx, pot.branchId, pot.variantId, day);
    const v = potVariance({ cookedQty: pot.cooked, leftoverQty: leftover, valuePerPotPesewas: item.valuePerPot, actualPesewas: actual, limitBp: settings?.potVarianceLimitBp ?? 1000 });
    await tx.update(potRecords).set({
      leftover, expectedPesewas: v.expectedPesewas, actualPesewas: actual, variancePesewas: v.variancePesewas, flagged: v.flagged, closedBy: ctx.userId, closedAt: now,
    }).where(eq(potRecords.id, pot.id));
    await writeAudit(tx, { tenantId: ctx.tenantId, actorType: 'user', actorId: ctx.userId, action: 'pot_closed', recordType: 'pot_record', recordId: pot.id, changes: { leftover } });
    if (v.flagged) {
      await writeAudit(tx, { tenantId: ctx.tenantId, actorType: 'system', actorId: null, action: 'pot_variance', recordType: 'pot_record', recordId: pot.id,
        changes: { expected: v.expectedPesewas, actual, variance: v.variancePesewas } });
    }

    if (toMilli(leftover) > 0n) {
      if (settings?.keepPotLeftovers) {
        await tx.insert(potRecords).values({ tenantId: ctx.tenantId, branchId: pot.branchId, variantId: pot.variantId, businessDate: addDays(day, 1), cooked: leftover, carriedIn: leftover })
          .onConflictDoUpdate({
            target: [potRecords.tenantId, potRecords.branchId, potRecords.variantId, potRecords.businessDate],
            set: { cooked: sql`${potRecords.cooked} + ${leftover}::numeric`, carriedIn: sql`${potRecords.carriedIn} + ${leftover}::numeric` },
          });
      } else {
        const [w] = await tx.insert(wastageEntries).values({
          tenantId: ctx.tenantId, branchId: pot.branchId, variantId: pot.variantId, businessDate: day, quantity: leftover, reason: 'leftover',
          costPesewas: costFor(await costOf(tx, pot.variantId), leftover), potRecordId: pot.id, userId: ctx.userId,
        }).returning({ id: wastageEntries.id });
        await deductPots(tx, { tenantId: ctx.tenantId, branchId: pot.branchId, userId: ctx.userId }, pot.variantId, leftover, 'waste', { type: 'wastage', id: w.id });
      }
    }
    const [row] = await tx.select(potColumns).from(potRecords).innerJoin(variants, eq(variants.id, potRecords.variantId))
      .innerJoin(products, eq(products.id, variants.productId)).where(eq(potRecords.id, pot.id));
    return { ok: true, pot: toRow(row) } as const;
  });
}

/** Every pot record of a branch on a business day, for the kitchen stock page. */
export async function getPotDay(db: Db, ctx: Ctx, branchId: string, day: string): Promise<PotRow[]> {
  assertPermission(ctx, 'record_kitchen_stock');
  if (!isUuid(branchId)) return [];
  return withTenant(db, ctx.tenantId, async (tx) => (await tx.select(potColumns).from(potRecords)
    .innerJoin(variants, eq(variants.id, potRecords.variantId)).innerJoin(products, eq(products.id, variants.productId))
    .where(and(eq(potRecords.branchId, branchId), eq(potRecords.businessDate, day))).orderBy(asc(products.name))).map(toRow));
}

/** Pot records from before today still waiting for their leftover count (no job runner yet, so the dashboard lists them). */
export async function potReminders(tx: Tx, today: string): Promise<Array<{ branchId: string; variantId: string; name: string; businessDate: string }>> {
  return tx.select({ branchId: potRecords.branchId, variantId: potRecords.variantId, name: products.name, businessDate: potRecords.businessDate })
    .from(potRecords).innerJoin(variants, eq(variants.id, potRecords.variantId)).innerJoin(products, eq(products.id, variants.productId))
    .where(and(lt(potRecords.businessDate, today), isNull(potRecords.closedAt), sql`${potRecords.cooked} > 0`))
    .orderBy(asc(potRecords.businessDate), asc(products.name));
}

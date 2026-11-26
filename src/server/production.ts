import 'server-only';
import { asc, desc, eq, inArray } from 'drizzle-orm';
import { z } from 'zod';
import type { Db, Tx } from '@/db/client';
import { products, productionIngredients, productionRuns, stockMovements, users, variants } from '@/db/schema';
import { withTenant } from '@/db/tenant';
import { multiplyQty, parseQuantity, toMilli } from '@/lib/decimal';
import { weightedAverageCost } from '@/lib/stock';
import { writeAudit } from './audit';
import { assertPermission, type Ctx } from './context';
import { type Fail, fail, isUuid, itemLabel } from './products';
import { changeBalance, deductRecipe, shopOnHand } from './stock';
import { costOf } from './variants';

const listSchema = z.object({
  variantId: z.uuid(), ingredients: z.array(z.object({ variantId: z.uuid(), quantity: z.string() })).max(50),
});
const myBranches = async (tx: Tx, ctx: Ctx) => (await tx.select({ branchIds: users.branchIds }).from(users).where(eq(users.id, ctx.userId)))[0]?.branchIds ?? [];
const nameOf = (r: { productName: string; variantName: string }) => itemLabel(r.productName, r.variantName);

/** Spec 6.27: replaces what one base unit of a made item uses (an empty list stops it being made). */
export async function saveProductionList(db: Db, ctx: Ctx, input: { variantId: string; ingredients: Array<{ variantId: string; quantity: string }> }): Promise<
  { ok: true } | Fail<'invalid_input' | 'not_found' | 'not_supported' | 'unknown_ingredient' | 'contains_itself'>
> {
  assertPermission(ctx, 'manage_products');
  const parsed = listSchema.safeParse(input);
  if (!parsed.success) return fail('invalid_input');
  const s = parsed.data;
  const rows = s.ingredients.map((i) => ({ ...i, quantity: parseQuantity(i.quantity) }));
  if (rows.some((r) => !r.quantity || toMilli(r.quantity) <= 0n) || new Set(rows.map((r) => r.variantId)).size !== rows.length) return fail('invalid_input');
  return withTenant(db, ctx.tenantId, async (tx) => {
    const [made] = await tx.select({ kind: variants.kind, tracking: products.tracking }).from(variants)
      .innerJoin(products, eq(products.id, variants.productId)).where(eq(variants.id, s.variantId));
    if (!made) return fail('not_found');
    // shortcut: only plain stock items are made ahead; batch and serial production waits until a shop needs it
    if (made.kind !== 'standard' || made.tracking !== 'none') return fail('not_supported');
    if (rows.some((r) => r.variantId === s.variantId)) return fail('contains_itself');
    if (rows.length) {
      const found = await tx.select({ id: variants.id }).from(variants).where(inArray(variants.id, rows.map((r) => r.variantId)));
      if (found.length !== rows.length) return fail('unknown_ingredient');
    }
    // no made item may use itself through another made item's list
    const edges = await tx.select({ made: productionIngredients.variantId, part: productionIngredients.ingredientVariantId }).from(productionIngredients);
    const reaches = (from: string, seen = new Set<string>()): boolean => {
      if (from === s.variantId) return true;
      if (seen.has(from)) return false;
      seen.add(from);
      return edges.filter((e) => e.made === from).some((e) => reaches(e.part, seen));
    };
    if (rows.some((r) => reaches(r.variantId))) return fail('contains_itself');
    await tx.delete(productionIngredients).where(eq(productionIngredients.variantId, s.variantId));
    if (rows.length) {
      await tx.insert(productionIngredients).values(rows.map((r) => ({ tenantId: ctx.tenantId, variantId: s.variantId, ingredientVariantId: r.variantId, quantity: r.quantity! })));
    }
    await writeAudit(tx, { tenantId: ctx.tenantId, actorType: 'user', actorId: ctx.userId, action: 'production_list_saved', recordType: 'variant', recordId: s.variantId, changes: { ingredients: rows.length } });
    return { ok: true as const };
  });
}

export async function getProductionList(db: Db, ctx: Ctx, variantId: string): Promise<Array<{ variantId: string; name: string; quantity: string }>> {
  if (!isUuid(variantId)) return [];
  return withTenant(db, ctx.tenantId, async (tx) => (await tx.select({
    variantId: variants.id, productName: products.name, variantName: variants.name, quantity: productionIngredients.quantity,
  }).from(productionIngredients).innerJoin(variants, eq(variants.id, productionIngredients.ingredientVariantId)).innerJoin(products, eq(products.id, variants.productId))
    .where(eq(productionIngredients.variantId, variantId)).orderBy(asc(productionIngredients.createdAt), asc(products.name)))
    .map((r) => ({ variantId: r.variantId, name: nameOf(r), quantity: r.quantity })));
}

/** Items with a production list, for the production screen. */
export async function listMadeItems(db: Db, ctx: Ctx): Promise<Array<{ variantId: string; name: string; ingredients: number }>> {
  return withTenant(db, ctx.tenantId, async (tx) => {
    const rows = await tx.select({ variantId: productionIngredients.variantId, productName: products.name, variantName: variants.name }).from(productionIngredients)
      .innerJoin(variants, eq(variants.id, productionIngredients.variantId)).innerJoin(products, eq(products.id, variants.productId));
    const made = new Map<string, { variantId: string; name: string; ingredients: number }>();
    for (const r of rows) {
      const m = made.get(r.variantId) ?? { variantId: r.variantId, name: nameOf(r), ingredients: 0 };
      m.ingredients += 1;
      made.set(r.variantId, m);
    }
    return [...made.values()].sort((a, b) => a.name.localeCompare(b.name));
  });
}

/** Spec 6.27: ingredients out, the made item in at what its ingredients cost now; the made item's average cost is re-weighted. */
export async function recordProduction(db: Db, ctx: Ctx, input: { branchId: string; variantId: string; quantity: string }, now: Date): Promise<
  { ok: true; runId: string; unitCostPesewas: string; negativeStock: boolean } | Fail<'invalid_input' | 'not_found' | 'no_production_list'>
> {
  assertPermission(ctx, 'record_production');
  const quantity = typeof input.quantity === 'string' ? parseQuantity(input.quantity) : null;
  if (!isUuid(input.branchId) || !isUuid(input.variantId) || !quantity || toMilli(quantity) <= 0n) return fail('invalid_input');
  return withTenant(db, ctx.tenantId, async (tx) => {
    if (!(await myBranches(tx, ctx)).includes(input.branchId)) return fail('not_found');
    const [made] = await tx.select({ id: variants.id, allowsFractions: variants.allowsFractions }).from(variants).where(eq(variants.id, input.variantId)).for('update');
    if (!made) return fail('not_found');
    if (!made.allowsFractions && toMilli(quantity) % 1000n !== 0n) return fail('invalid_input');
    const parts = await tx.select({ id: productionIngredients.ingredientVariantId, quantity: productionIngredients.quantity }).from(productionIngredients)
      .where(eq(productionIngredients.variantId, input.variantId));
    if (!parts.length) return fail('no_production_list');
    let costPesewas = 0; // shortcut: float pesewas, rounded to 4 places below; fine at shop scale
    const used = [];
    for (const p of parts) {
      const qty = multiplyQty(p.quantity, quantity);
      costPesewas += Number(qty) * Number(await costOf(tx, p.id));
      used.push({ id: p.id, qty });
    }
    const unitCost = (costPesewas / Number(quantity)).toFixed(4);
    const [run] = await tx.insert(productionRuns).values({
      tenantId: ctx.tenantId, branchId: input.branchId, variantId: input.variantId, quantity, unitCost, userId: ctx.userId, createdAt: now,
    }).returning({ id: productionRuns.id });
    let negativeStock = false;
    for (const u of used) {
      const r = await deductRecipe(tx, { tenantId: ctx.tenantId, branchId: input.branchId, userId: ctx.userId }, u.id, u.qty, 'used_in_production', { type: 'production', id: run.id });
      negativeStock ||= r.negative;
    }
    const [v] = await tx.select({ averageCost: variants.averageCost }).from(variants).where(eq(variants.id, input.variantId));
    const averageCost = weightedAverageCost(await shopOnHand(tx, input.variantId), v.averageCost, quantity, unitCost);
    await tx.update(variants).set({ averageCost }).where(eq(variants.id, input.variantId));
    await changeBalance(tx, ctx.tenantId, input.branchId, input.variantId, quantity);
    await tx.insert(stockMovements).values({
      tenantId: ctx.tenantId, branchId: input.branchId, variantId: input.variantId, type: 'produced', quantity, unitCost,
      referenceType: 'production', referenceId: run.id, userId: ctx.userId,
    });
    await writeAudit(tx, {
      tenantId: ctx.tenantId, actorType: 'user', actorId: ctx.userId, action: 'production_recorded', recordType: 'variant', recordId: input.variantId,
      changes: { runId: run.id, branchId: input.branchId, quantity, unitCost, negativeStock },
    });
    return { ok: true as const, runId: run.id, unitCostPesewas: unitCost, negativeStock };
  });
}

/** The latest batches made at the user's branches. */
export async function listProductionRuns(db: Db, ctx: Ctx, limit = 20): Promise<Array<{ id: string; name: string; quantity: string; unitCost: string; by: string; at: Date }>> {
  return withTenant(db, ctx.tenantId, async (tx) => {
    const mine = await myBranches(tx, ctx);
    if (!mine.length) return [];
    return (await tx.select({
      id: productionRuns.id, productName: products.name, variantName: variants.name, quantity: productionRuns.quantity, unitCost: productionRuns.unitCost,
      by: users.name, at: productionRuns.createdAt,
    }).from(productionRuns).innerJoin(variants, eq(variants.id, productionRuns.variantId)).innerJoin(products, eq(products.id, variants.productId))
      .innerJoin(users, eq(users.id, productionRuns.userId)).where(inArray(productionRuns.branchId, mine))
      .orderBy(desc(productionRuns.createdAt)).limit(Math.min(Math.max(limit, 1), 100)))
      .map((r) => ({ id: r.id, name: nameOf(r), quantity: r.quantity, unitCost: r.unitCost, by: r.by, at: r.at }));
  });
}

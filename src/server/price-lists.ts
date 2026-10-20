import 'server-only';
import { and, asc, eq } from 'drizzle-orm';
import { z } from 'zod';
import type { Db, Tx } from '@/db/client';
import { branches, type PriceListKind, priceListItems, priceLists, products, variants, variantUnits } from '@/db/schema';
import { withTenant } from '@/db/tenant';
import { todayIn } from '@/lib/dates';
import { parseQuantity, validSaleQuantity } from '@/lib/decimal';
import { choosePriceList, type PriceRule, resolvePrice } from '@/lib/pricing';
import { writeAudit } from './audit';
import { assertPermission, type Ctx } from './context';
import { lockTenant } from './plan-limits';
import { type Fail, fail, isUuid } from './products';

export type PriceListInput = { name: string; kind: PriceListKind; branchId: string | null; startsOn: string | null; endsOn: string | null };
export type PriceListView = Omit<PriceRule, 'items'> & {
  name: string; branchName: string | null;
  items: Array<PriceRule['items'][number] & { id: string; productName: string; variantName: string; unitName: string }>;
};

const date = z.iso.date().nullable();
const name = z.string().trim().min(1).max(60);
const datesInOrder = (d: { startsOn: string | null; endsOn: string | null }) => !d.startsOn || !d.endsOn || d.startsOn <= d.endsOn;
const listSchema = z.object({
  name, kind: z.enum(['retail', 'wholesale', 'customer_group', 'branch']), branchId: z.string().nullable(), startsOn: date, endsOn: date,
}).refine(datesInOrder)
  .refine((l) => (l.kind === 'branch') === (l.branchId !== null)) // only branch lists name a branch
  .refine((l) => l.kind !== 'retail' || (!l.startsOn && !l.endsOn)); // Retail is the always-on default
const updateSchema = z.object({ name, startsOn: date, endsOn: date, active: z.boolean() }).refine(datesInOrder);

const audit = (tx: Tx, ctx: Ctx, action: string, recordType: string, recordId: string, changes?: Record<string, unknown>) =>
  writeAudit(tx, { tenantId: ctx.tenantId, actorType: 'user', actorId: ctx.userId, action, recordType, recordId, changes });

export async function createPriceList(
  db: Db, ctx: Ctx, input: PriceListInput,
): Promise<{ ok: true; priceListId: string } | Fail<'invalid_input' | 'unknown_branch' | 'retail_exists' | 'branch_has_list'>> {
  assertPermission(ctx, 'manage_products');
  const parsed = listSchema.safeParse(input);
  if (!parsed.success) return fail('invalid_input');
  const l = parsed.data;
  return withTenant(db, ctx.tenantId, async (tx) => {
    await lockTenant(tx, ctx.tenantId);
    if (l.branchId !== null) {
      // row-level security hides other shops' branches, so they count as unknown
      const [b] = isUuid(l.branchId) ? await tx.select({ id: branches.id }).from(branches).where(eq(branches.id, l.branchId)) : [];
      if (!b) return fail('unknown_branch');
      const [taken] = await tx.select({ id: priceLists.id }).from(priceLists)
        .where(and(eq(priceLists.kind, 'branch'), eq(priceLists.branchId, l.branchId)));
      if (taken) return fail('branch_has_list');
    }
    if (l.kind === 'retail') {
      const [taken] = await tx.select({ id: priceLists.id }).from(priceLists).where(eq(priceLists.kind, 'retail'));
      if (taken) return fail('retail_exists');
    }
    const [row] = await tx.insert(priceLists).values({ tenantId: ctx.tenantId, ...l }).returning({ id: priceLists.id });
    await audit(tx, ctx, 'price_list_created', 'price_list', row.id, { ...l });
    return { ok: true, priceListId: row.id } as const;
  });
}

export async function updatePriceList(
  db: Db, ctx: Ctx, priceListId: string, input: { name: string; startsOn: string | null; endsOn: string | null; active: boolean },
): Promise<{ ok: true } | Fail<'invalid_input' | 'not_found'>> {
  assertPermission(ctx, 'manage_products');
  const parsed = updateSchema.safeParse(input);
  if (!parsed.success) return fail('invalid_input');
  if (!isUuid(priceListId)) return fail('not_found');
  const u = parsed.data;
  return withTenant(db, ctx.tenantId, async (tx) => {
    await lockTenant(tx, ctx.tenantId);
    const [l] = await tx.select({ kind: priceLists.kind }).from(priceLists).where(eq(priceLists.id, priceListId));
    if (!l) return fail('not_found');
    if (l.kind === 'retail' && (u.startsOn || u.endsOn)) return fail('invalid_input');
    await tx.update(priceLists).set(u).where(eq(priceLists.id, priceListId));
    await audit(tx, ctx, 'price_list_updated', 'price_list', priceListId, { ...u });
    return { ok: true } as const;
  });
}

/** Adds or replaces the price for one unit at one minimum quantity (a quantity break), in the unit sold. */
export async function setPriceListItem(
  db: Db, ctx: Ctx, input: { priceListId: string; unitId: string; minQuantity: string; pricePesewas: number },
): Promise<{ ok: true; itemId: string } | Fail<'invalid_input' | 'not_found'>> {
  assertPermission(ctx, 'manage_products');
  const minQuantity = typeof input.minQuantity === 'string' ? parseQuantity(input.minQuantity) : null;
  if (!z.number().int().min(0).max(2_000_000_000).safeParse(input.pricePesewas).success || !minQuantity) return fail('invalid_input');
  if (!isUuid(input.priceListId) || !isUuid(input.unitId)) return fail('not_found');
  return withTenant(db, ctx.tenantId, async (tx) => {
    await lockTenant(tx, ctx.tenantId);
    const [list] = await tx.select({ id: priceLists.id }).from(priceLists).where(eq(priceLists.id, input.priceListId));
    const [unit] = await tx.select({ variantId: variantUnits.variantId, isBase: variantUnits.isBase, allowsFractions: variants.allowsFractions })
      .from(variantUnits).innerJoin(variants, eq(variants.id, variantUnits.variantId)).where(eq(variantUnits.id, input.unitId));
    if (!list || !unit) return fail('not_found');
    if (!validSaleQuantity(minQuantity, unit.isBase && unit.allowsFractions)) return fail('invalid_input');
    const key = and(eq(priceListItems.priceListId, input.priceListId), eq(priceListItems.unitId, input.unitId), eq(priceListItems.minQuantity, minQuantity));
    const [old] = await tx.select({ pricePesewas: priceListItems.pricePesewas }).from(priceListItems).where(key);
    const [row] = await tx.insert(priceListItems).values({
      tenantId: ctx.tenantId, priceListId: input.priceListId, variantId: unit.variantId, unitId: input.unitId, minQuantity, pricePesewas: input.pricePesewas,
    }).onConflictDoUpdate({
      target: [priceListItems.priceListId, priceListItems.unitId, priceListItems.minQuantity], set: { pricePesewas: input.pricePesewas },
    }).returning({ id: priceListItems.id });
    await audit(tx, ctx, 'price_list_item_saved', 'price_list_item', row.id, { pricePesewas: [old?.pricePesewas ?? null, input.pricePesewas] });
    return { ok: true, itemId: row.id } as const;
  });
}

export async function removePriceListItem(db: Db, ctx: Ctx, itemId: string): Promise<{ ok: true } | Fail<'not_found'>> {
  assertPermission(ctx, 'manage_products');
  if (!isUuid(itemId)) return fail('not_found');
  return withTenant(db, ctx.tenantId, async (tx) => {
    const [row] = await tx.delete(priceListItems).where(eq(priceListItems.id, itemId)).returning({ price: priceListItems.pricePesewas });
    if (!row) return fail('not_found');
    await audit(tx, ctx, 'price_list_item_removed', 'price_list_item', itemId, { pricePesewas: row.price });
    return { ok: true } as const;
  });
}

const listColumns = {
  id: priceLists.id, kind: priceLists.kind, branchId: priceLists.branchId, startsOn: priceLists.startsOn, endsOn: priceLists.endsOn,
  active: priceLists.active,
};

/** All of the shop's lists with their items; the caller's transaction decides the shop (row-level security). */
export async function loadPriceRules(tx: Tx): Promise<PriceRule[]> {
  const lists = await tx.select(listColumns).from(priceLists).orderBy(asc(priceLists.createdAt));
  const items = await tx.select({
    priceListId: priceListItems.priceListId, unitId: priceListItems.unitId, minQuantity: priceListItems.minQuantity, pricePesewas: priceListItems.pricePesewas,
  }).from(priceListItems);
  return lists.map((l) => ({ ...l, items: items.filter((i) => i.priceListId === l.id).map(({ priceListId: _, ...i }) => i) }));
}

export async function listPriceLists(db: Db, ctx: Ctx): Promise<PriceListView[]> {
  assertPermission(ctx, 'manage_products');
  return withTenant(db, ctx.tenantId, async (tx) => {
    const lists = await tx.select({ ...listColumns, name: priceLists.name, branchName: branches.name }).from(priceLists)
      .leftJoin(branches, eq(branches.id, priceLists.branchId)).orderBy(asc(priceLists.createdAt));
    const items = await tx.select({
      id: priceListItems.id, priceListId: priceListItems.priceListId, unitId: priceListItems.unitId, minQuantity: priceListItems.minQuantity,
      pricePesewas: priceListItems.pricePesewas, productName: products.name, variantName: variants.name, unitName: variantUnits.name,
    }).from(priceListItems)
      .innerJoin(variantUnits, eq(variantUnits.id, priceListItems.unitId))
      .innerJoin(variants, eq(variants.id, priceListItems.variantId))
      .innerJoin(products, eq(products.id, variants.productId))
      .orderBy(asc(products.name), asc(variantUnits.name), asc(priceListItems.minQuantity));
    return lists.map((l) => ({ ...l, items: items.filter((i) => i.priceListId === l.id).map(({ priceListId: _, ...i }) => i) }));
  });
}

/** The unit price for a quantity of one unit at a branch today (spec 6.21). Any signed-in member: the till prices lines with it. */
export async function quotePrice(
  db: Db, ctx: Ctx, input: { unitId: string; quantity: string; branchId: string; priceListId: string | null }, now: Date,
): Promise<{ ok: true; unitPricePesewas: number; priceListId: string | null } | Fail<'not_found' | 'invalid_quantity'>> {
  if (!isUuid(input.unitId)) return fail('not_found');
  const quantity = typeof input.quantity === 'string' ? parseQuantity(input.quantity) : null;
  return withTenant(db, ctx.tenantId, async (tx) => {
    const [unit] = await tx.select({
      factor: variantUnits.factor, pricePesewas: variantUnits.pricePesewas, isBase: variantUnits.isBase,
      allowsFractions: variants.allowsFractions, basePricePesewas: variants.basePricePesewas,
    }).from(variantUnits).innerJoin(variants, eq(variants.id, variantUnits.variantId)).where(eq(variantUnits.id, input.unitId));
    if (!unit) return fail('not_found');
    if (!validSaleQuantity(quantity, unit.isBase && unit.allowsFractions)) return fail('invalid_quantity');
    const list = choosePriceList(await loadPriceRules(tx), {
      cartListId: input.priceListId, customerListId: null, branchId: input.branchId, today: todayIn(ctx.timezone, now),
    });
    const unitPricePesewas = resolvePrice(list, {
      unitId: input.unitId, quantity: quantity!, unitPricePesewas: unit.pricePesewas, unitFactor: unit.factor, basePricePesewas: unit.basePricePesewas,
    });
    return { ok: true, unitPricePesewas, priceListId: list?.id ?? null } as const;
  });
}

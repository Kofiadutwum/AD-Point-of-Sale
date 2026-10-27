import 'server-only';
import { and, asc, eq, ne, sql } from 'drizzle-orm';
import { z } from 'zod';
import type { Db, Tx } from '@/db/client';
import { barcodes, type CatalogueStatus, components, products, variants, variantUnits } from '@/db/schema';
import { withTenant } from '@/db/tenant';
import { normaliseBarcode } from '@/lib/barcode';
import { parseQuantity, rollUpCost, toMilli, validSaleQuantity } from '@/lib/decimal';
import { writeAudit } from './audit';
import { assertPermission, type Ctx } from './context';
import { lockTenant } from './plan-limits';
import { variantsInUse } from './usage';
import {
  type CatalogueError, checkCodes, cleanVariant, type Fail, fail, insertVariant, isUuid, type NewVariantInput, normaliseSku,
  scaleCodeProblem, scaleLayoutOf, trackingAllowed,
} from './products';

export type VariantFields = {
  name: string; sku: string | null; basePricePesewas: number; costPesewas: number | null; reorderLevel: string | null; // cost null = keep the current average cost
  scaleItemCode?: number | null; sellable: boolean; allowsFractions: boolean; // scaleItemCode left out = keep the saved code
  needsPack?: boolean; // food takeaway packs (spec 6.56); left out = keep
};
export type UnitFields = { name: string; factor: string; pricePesewas: number | null; sellable: boolean; purchasable: boolean };

const audit = (tx: Tx, ctx: Ctx, action: string, recordType: string, recordId: string, changes?: Record<string, unknown>) =>
  writeAudit(tx, { tenantId: ctx.tenantId, actorType: 'user', actorId: ctx.userId, action, recordType, recordId, changes });

/** The variant, its product's tracking mode, and its base unit name; row-level security hides other shops' variants. */
async function loadVariant(tx: Tx, variantId: string) {
  const [row] = await tx.select({ variant: variants, tracking: products.tracking, baseUnit: variantUnits.name }).from(variants)
    .innerJoin(products, eq(products.id, variants.productId))
    .innerJoin(variantUnits, and(eq(variantUnits.variantId, variants.id), eq(variantUnits.isBase, true)))
    .where(eq(variants.id, variantId));
  return row;
}

export async function addVariant(
  db: Db, ctx: Ctx, productId: string, input: NewVariantInput,
): Promise<{ ok: true; variantId: string; baseUnitId: string } | Fail<CatalogueError | 'not_found'>> {
  assertPermission(ctx, 'manage_products');
  const v = cleanVariant(input);
  if (!v) return fail('invalid_input');
  if (!isUuid(productId)) return fail('not_found');
  return withTenant(db, ctx.tenantId, async (tx) => {
    await lockTenant(tx, ctx.tenantId);
    // a new variant takes its kind, fractions, and base unit from the product's first variant
    const [first] = await tx.select({ id: variants.id }).from(variants).where(eq(variants.productId, productId))
      .orderBy(asc(variants.createdAt), asc(variants.id)).limit(1);
    const model = first && await loadVariant(tx, first.id);
    if (!model) return fail('not_found');
    const shape = { kind: model.variant.kind, allowsFractions: model.variant.allowsFractions, baseUnit: model.baseUnit };
    if (!trackingAllowed(model.tracking, shape.kind, shape.allowsFractions, v.scaleItemCode !== null)) return fail('invalid_input');
    const layout = await scaleLayoutOf(tx, ctx.tenantId);
    const problem = v.scaleItemCode === null ? null
      : scaleCodeProblem(v.scaleItemCode, layout, { ...shape, tracking: model.tracking, basePricePesewas: v.basePricePesewas });
    if (problem) return fail(problem);
    const clash = await checkCodes(tx, ctx.tenantId, layout, {
      skus: v.sku ? [v.sku] : [], barcodes: v.barcodes, scaleCodes: v.scaleItemCode === null ? [] : [v.scaleItemCode],
    });
    if (clash) return clash;
    const made = await insertVariant(tx, ctx.tenantId, productId, shape, v);
    await audit(tx, ctx, 'variant_added', 'variant', made.variantId);
    return { ok: true, ...made } as const;
  });
}

const pesewas = z.number().int().min(0).max(2_000_000_000);
const variantFieldsSchema = z.object({
  name: z.string().trim().max(60),
  sku: z.string().nullable(),
  basePricePesewas: pesewas,
  costPesewas: pesewas.nullable(),
  reorderLevel: z.string().nullable(),
  scaleItemCode: z.number().int().nullable().optional(),
  sellable: z.boolean(),
  allowsFractions: z.boolean(),
  needsPack: z.boolean().optional(),
});

export async function updateVariant(db: Db, ctx: Ctx, variantId: string, input: VariantFields): Promise<{ ok: true } | Fail<CatalogueError | 'not_found' | 'in_use'>> {
  assertPermission(ctx, 'manage_products');
  const parsed = variantFieldsSchema.safeParse(input);
  if (!parsed.success) return fail('invalid_input');
  const f = parsed.data;
  const sku = normaliseSku(f.sku);
  const reorderText = f.reorderLevel?.trim() ?? '';
  const reorderLevel = reorderText ? parseQuantity(reorderText) : null;
  if (sku === undefined || (reorderText && reorderLevel === null)) return fail('invalid_input');
  if (!isUuid(variantId)) return fail('not_found');

  return withTenant(db, ctx.tenantId, async (tx) => {
    await lockTenant(tx, ctx.tenantId);
    const row = await loadVariant(tx, variantId);
    if (!row) return fail('not_found');
    const old = row.variant;
    const scaleItemCode = f.scaleItemCode === undefined ? old.scaleItemCode : f.scaleItemCode; // left out = keep (field hidden while labels are off)
    if (!trackingAllowed(row.tracking, old.kind, f.allowsFractions, scaleItemCode !== null)) return fail('invalid_input');
    if (f.allowsFractions !== old.allowsFractions && await variantsInUse(tx, [variantId])) return fail('in_use');
    const layout = await scaleLayoutOf(tx, ctx.tenantId);
    // a kept code is inert while scale labels are off; it is checked again when a layout is saved
    const checkScale = scaleItemCode !== null && (layout !== null || f.scaleItemCode !== undefined);
    const problem = checkScale ? scaleCodeProblem(scaleItemCode, layout, {
      kind: old.kind, tracking: row.tracking, allowsFractions: f.allowsFractions, baseUnit: row.baseUnit, basePricePesewas: f.basePricePesewas,
    }) : null;
    if (problem) return fail(problem);
    const clash = await checkCodes(tx, ctx.tenantId, layout,
      { skus: sku ? [sku] : [], barcodes: [], scaleCodes: scaleItemCode === null ? [] : [scaleItemCode] }, variantId);
    if (clash) return clash;
    await tx.update(variants).set({
      name: f.name, sku, basePricePesewas: f.basePricePesewas, ...(f.costPesewas === null ? {} : { averageCost: String(f.costPesewas) }), reorderLevel,
      scaleItemCode, sellable: f.sellable, allowsFractions: f.allowsFractions, ...(f.needsPack === undefined ? {} : { needsPack: f.needsPack }),
    }).where(eq(variants.id, variantId));
    // price and cost changes are sensitive (spec 6.0 AUDIT): record old and new values
    const changes: Record<string, [number, number]> = {};
    if (old.basePricePesewas !== f.basePricePesewas) changes.basePricePesewas = [old.basePricePesewas, f.basePricePesewas];
    if (f.costPesewas !== null && Number(old.averageCost) !== f.costPesewas) changes.costPesewas = [Number(old.averageCost), f.costPesewas];
    await audit(tx, ctx, 'variant_updated', 'variant', variantId, changes);
    return { ok: true } as const;
  });
}

export async function setVariantStatus(db: Db, ctx: Ctx, variantId: string, status: CatalogueStatus): Promise<{ ok: true } | Fail<'not_found' | 'last_variant'>> {
  assertPermission(ctx, 'manage_products');
  if (!isUuid(variantId)) return fail('not_found');
  return withTenant(db, ctx.tenantId, async (tx) => {
    await lockTenant(tx, ctx.tenantId);
    const [v] = await tx.select({ productId: variants.productId, status: variants.status }).from(variants).where(eq(variants.id, variantId));
    if (!v) return fail('not_found');
    if (v.status === status) return { ok: true } as const;
    if (status === 'archived') {
      const [other] = await tx.select({ id: variants.id }).from(variants)
        .where(and(eq(variants.productId, v.productId), eq(variants.status, 'active'), ne(variants.id, variantId))).limit(1);
      if (!other) return fail('last_variant');
    }
    await tx.update(variants).set({ status }).where(eq(variants.id, variantId));
    await audit(tx, ctx, status === 'archived' ? 'variant_archived' : 'variant_restored', 'variant', variantId);
    return { ok: true } as const;
  });
}

const MAX_FACTOR_MILLI = 99_999_000n; // 99999.000 base units
const unitSchema = z.object({
  name: z.string().trim().min(1).max(20),
  factor: z.string(),
  pricePesewas: pesewas.nullable(),
  sellable: z.boolean(),
  purchasable: z.boolean(),
});

function cleanUnit(input: UnitFields): (UnitFields & { factor: string }) | null {
  const parsed = unitSchema.safeParse(input);
  const factor = parsed.success ? parseQuantity(parsed.data.factor) : null;
  return parsed.success && factor ? { ...parsed.data, factor } : null;
}

/** Other units are whole multiples of the base unit's quantity: factor above 1 (spec 4.15). */
const validFactor = (factor: string) => toMilli(factor) > 1000n && toMilli(factor) <= MAX_FACTOR_MILLI;

async function nameTaken(tx: Tx, variantId: string, name: string, exceptUnitId?: string): Promise<boolean> {
  const [hit] = await tx.select({ id: variantUnits.id }).from(variantUnits).where(and(
    eq(variantUnits.variantId, variantId), sql`lower(${variantUnits.name}) = lower(${name})`, exceptUnitId ? ne(variantUnits.id, exceptUnitId) : undefined,
  ));
  return Boolean(hit);
}

export async function addUnit(
  db: Db, ctx: Ctx, variantId: string, input: UnitFields,
): Promise<{ ok: true; unitId: string } | Fail<'invalid_input' | 'duplicate_name' | 'not_found'>> {
  assertPermission(ctx, 'manage_products');
  const u = cleanUnit(input);
  if (!u || !validFactor(u.factor)) return fail('invalid_input');
  if (!isUuid(variantId)) return fail('not_found');
  return withTenant(db, ctx.tenantId, async (tx) => {
    await lockTenant(tx, ctx.tenantId);
    const [v] = await tx.select({ id: variants.id }).from(variants).where(eq(variants.id, variantId));
    if (!v) return fail('not_found');
    if (await nameTaken(tx, variantId, u.name)) return fail('duplicate_name');
    const [row] = await tx.insert(variantUnits).values({ tenantId: ctx.tenantId, variantId, ...u, isBase: false }).returning({ id: variantUnits.id });
    await audit(tx, ctx, 'unit_added', 'unit', row.id, { name: u.name, factor: u.factor, pricePesewas: u.pricePesewas });
    return { ok: true, unitId: row.id } as const;
  });
}

export async function updateUnit(
  db: Db, ctx: Ctx, unitId: string, input: UnitFields,
): Promise<{ ok: true } | Fail<'invalid_input' | 'duplicate_name' | 'not_found' | 'in_use'>> {
  assertPermission(ctx, 'manage_products');
  const u = cleanUnit(input);
  if (!u) return fail('invalid_input');
  if (!isUuid(unitId)) return fail('not_found');
  return withTenant(db, ctx.tenantId, async (tx) => {
    await lockTenant(tx, ctx.tenantId);
    const [old] = await tx.select().from(variantUnits).where(eq(variantUnits.id, unitId));
    if (!old) return fail('not_found');
    // the base unit is the stock unit: its factor stays 1 and its price is the variant's base price
    if (old.isBase ? u.factor !== '1.000' || u.pricePesewas !== null : !validFactor(u.factor)) return fail('invalid_input');
    if (u.factor !== old.factor && await variantsInUse(tx, [old.variantId])) return fail('in_use');
    if (old.isBase && u.name.toLowerCase() !== 'kg') {
      // weight labels give grams of a kg item; renaming its base unit would make the till misread them
      const [v] = await tx.select({ code: variants.scaleItemCode }).from(variants).where(eq(variants.id, old.variantId));
      if (v.code !== null && (await scaleLayoutOf(tx, ctx.tenantId))?.carries === 'weight') return fail('invalid_input');
    }
    if (await nameTaken(tx, old.variantId, u.name, unitId)) return fail('duplicate_name');
    await tx.update(variantUnits).set(u).where(eq(variantUnits.id, unitId));
    await audit(tx, ctx, 'unit_updated', 'unit', unitId, {
      factor: [old.factor, u.factor], pricePesewas: [old.pricePesewas, u.pricePesewas],
    });
    return { ok: true } as const;
  });
}

/** Its barcodes and price list items go with it (database cascade); the base unit stays. */
export async function removeUnit(db: Db, ctx: Ctx, unitId: string): Promise<{ ok: true } | Fail<'not_found' | 'base_unit'>> {
  assertPermission(ctx, 'manage_products');
  if (!isUuid(unitId)) return fail('not_found');
  return withTenant(db, ctx.tenantId, async (tx) => {
    await lockTenant(tx, ctx.tenantId);
    const [u] = await tx.select({ isBase: variantUnits.isBase, name: variantUnits.name }).from(variantUnits).where(eq(variantUnits.id, unitId));
    if (!u) return fail('not_found');
    if (u.isBase) return fail('base_unit');
    await tx.delete(variantUnits).where(eq(variantUnits.id, unitId));
    await audit(tx, ctx, 'unit_removed', 'unit', unitId, { name: u.name });
    return { ok: true } as const;
  });
}

export async function addBarcode(
  db: Db, ctx: Ctx, unitId: string, code: string,
): Promise<{ ok: true; barcodeId: string } | Fail<'invalid_input' | 'duplicate_barcode' | 'looks_like_scale_label' | 'not_found'>> {
  assertPermission(ctx, 'manage_products');
  const clean = typeof code === 'string' ? normaliseBarcode(code) : null;
  if (!clean) return fail('invalid_input');
  if (!isUuid(unitId)) return fail('not_found');
  return withTenant(db, ctx.tenantId, async (tx) => {
    await lockTenant(tx, ctx.tenantId);
    const [u] = await tx.select({ variantId: variantUnits.variantId }).from(variantUnits).where(eq(variantUnits.id, unitId));
    if (!u) return fail('not_found');
    const clash = await checkCodes(tx, ctx.tenantId, await scaleLayoutOf(tx, ctx.tenantId), { skus: [], barcodes: [clean], scaleCodes: [] });
    if (clash) return clash as Fail<'duplicate_barcode' | 'looks_like_scale_label'>;
    const [row] = await tx.insert(barcodes).values({ tenantId: ctx.tenantId, variantId: u.variantId, unitId, code: clean }).returning({ id: barcodes.id });
    await audit(tx, ctx, 'barcode_added', 'barcode', row.id, { code: clean });
    return { ok: true, barcodeId: row.id } as const;
  });
}

export async function removeBarcode(db: Db, ctx: Ctx, barcodeId: string): Promise<{ ok: true } | Fail<'not_found'>> {
  assertPermission(ctx, 'manage_products');
  if (!isUuid(barcodeId)) return fail('not_found');
  return withTenant(db, ctx.tenantId, async (tx) => {
    const [row] = await tx.delete(barcodes).where(eq(barcodes.id, barcodeId)).returning({ code: barcodes.code });
    if (!row) return fail('not_found');
    await audit(tx, ctx, 'barcode_removed', 'barcode', barcodeId, { code: row.code });
    return { ok: true } as const;
  });
}

/** A variant of this shop by SKU (any case) or by barcode in either UPC-A or EAN-13 form. */
export async function findVariantByCode(tx: Tx, code: string): Promise<{ productId: string; variantId: string } | null> {
  const sku = normaliseSku(code);
  if (sku) {
    const [v] = await tx.select({ productId: variants.productId, variantId: variants.id }).from(variants).where(eq(variants.sku, sku));
    if (v) return v;
  }
  const barcode = normaliseBarcode(code);
  if (!barcode) return null;
  const [b] = await tx.select({ productId: variants.productId, variantId: variants.id }).from(barcodes)
    .innerJoin(variants, eq(variants.id, barcodes.variantId)).where(eq(barcodes.code, barcode));
  return b ?? null;
}

/** True when `target` is `from` or can be reached from it through component links. */
function reaches(edges: Array<{ parent: string; part: string }>, from: string, target: string): boolean {
  const seen = new Set<string>();
  const stack = [from];
  while (stack.length) {
    const id = stack.pop()!;
    if (id === target) return true;
    if (seen.has(id)) continue;
    seen.add(id);
    for (const e of edges) if (e.parent === id) stack.push(e.part);
  }
  return false;
}

/** Spec 4.18: bundle parts or recipe ingredients, in the component's base units. Setup blocks bundles that contain themselves. */
export async function addComponent(
  db: Db, ctx: Ctx, parentVariantId: string, input: { code: string; quantity: string },
): Promise<{ ok: true; componentId: string }
  | Fail<'not_found' | 'not_a_bundle' | 'unknown_component' | 'contains_itself' | 'invalid_quantity' | 'duplicate_component'>> {
  assertPermission(ctx, 'manage_products');
  if (!isUuid(parentVariantId)) return fail('not_found');
  return withTenant(db, ctx.tenantId, async (tx) => {
    await lockTenant(tx, ctx.tenantId);
    const [parent] = await tx.select({ kind: variants.kind }).from(variants).where(eq(variants.id, parentVariantId));
    if (!parent) return fail('not_found');
    if (parent.kind === 'standard') return fail('not_a_bundle');
    const found = typeof input.code === 'string' ? await findVariantByCode(tx, input.code) : null;
    if (!found) return fail('unknown_component');
    const [part] = await tx.select({ allowsFractions: variants.allowsFractions }).from(variants).where(eq(variants.id, found.variantId));
    const quantity = typeof input.quantity === 'string' ? parseQuantity(input.quantity) : null;
    if (!validSaleQuantity(quantity, part.allowsFractions)) return fail('invalid_quantity');
    const edges = await tx.select({ parent: components.parentVariantId, part: components.componentVariantId }).from(components);
    if (reaches(edges, found.variantId, parentVariantId)) return fail('contains_itself');
    if (edges.some((e) => e.parent === parentVariantId && e.part === found.variantId)) return fail('duplicate_component');
    const [row] = await tx.insert(components)
      .values({ tenantId: ctx.tenantId, parentVariantId, componentVariantId: found.variantId, quantity: quantity! }).returning({ id: components.id });
    await audit(tx, ctx, 'component_added', 'component', row.id, { parentVariantId, componentVariantId: found.variantId, quantity });
    return { ok: true, componentId: row.id } as const;
  });
}

export async function removeComponent(db: Db, ctx: Ctx, componentId: string): Promise<{ ok: true } | Fail<'not_found'>> {
  assertPermission(ctx, 'manage_products');
  if (!isUuid(componentId)) return fail('not_found');
  return withTenant(db, ctx.tenantId, async (tx) => {
    const [row] = await tx.delete(components).where(eq(components.id, componentId)).returning({ parent: components.parentVariantId });
    if (!row) return fail('not_found');
    await audit(tx, ctx, 'component_removed', 'component', componentId, { parentVariantId: row.parent });
    return { ok: true } as const;
  });
}

/** Pesewas per base unit, 4 places: average cost, or the sum of component costs for bundles and recipes (spec 4.18). */
export async function costOf(tx: Tx, variantId: string, path: ReadonlySet<string> = new Set()): Promise<string> {
  const [v] = await tx.select({ kind: variants.kind, averageCost: variants.averageCost }).from(variants).where(eq(variants.id, variantId));
  if (!v) throw new Error(`unknown variant ${variantId}`);
  if (v.kind === 'standard') return v.averageCost;
  if (path.has(variantId)) throw new Error(`bundle ${variantId} contains itself`);
  const parts = await tx.select({ id: components.componentVariantId, quantity: components.quantity }).from(components)
    .where(eq(components.parentVariantId, variantId));
  const priced = [];
  for (const p of parts) priced.push({ quantity: p.quantity, cost: await costOf(tx, p.id, new Set([...path, variantId])) });
  return rollUpCost(priced);
}

export async function variantCost(db: Db, ctx: Ctx, variantId: string): Promise<string | null> {
  assertPermission(ctx, 'manage_products');
  if (!isUuid(variantId)) return null;
  return withTenant(db, ctx.tenantId, async (tx) => {
    const [v] = await tx.select({ id: variants.id }).from(variants).where(eq(variants.id, variantId));
    return v ? costOf(tx, variantId) : null;
  });
}

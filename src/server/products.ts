import 'server-only';
import { and, asc, desc, eq, ilike, inArray, ne, or, sql } from 'drizzle-orm';
import { z } from 'zod';
import type { Db, Tx } from '@/db/client';
import {
  barcodes, type CatalogueStatus, categories, components, productImages, products, taxRules, tenants, type Tracking,
  variants, type VariantKind, variantUnits,
} from '@/db/schema';
import { withTenant } from '@/db/tenant';
import { matchesScaleLayout, normaliseBarcode, type ScaleLayout } from '@/lib/barcode';
import { parseQuantity } from '@/lib/decimal';
import { writeAudit } from './audit';
import { assertPermission, type Ctx } from './context';
import { checkPlanLimit, lockTenant } from './plan-limits';
import { variantsInUse } from './usage';

export type PharmacyFields = { genericName?: string; strength?: string; dosageForm?: string; registrationNumber?: string; prescriptionOnly?: boolean };
export type ProductFields = {
  name: string; description?: string; categoryId?: string | null; brand?: string; taxRuleId?: string | null;
  tracking: Tracking; showOnStorefront?: boolean; featured?: boolean; pharmacy?: PharmacyFields;
};
export type NewVariantInput = {
  name?: string; sku?: string; barcodes?: string[]; basePricePesewas: number; costPesewas: number; reorderLevel?: string; scaleItemCode?: number;
};
export type NewProductInput = ProductFields & { kind: VariantKind; baseUnit: string; allowsFractions: boolean; variants: NewVariantInput[] };
export type CatalogueError = 'invalid_input' | 'duplicate_sku' | 'duplicate_barcode' | 'looks_like_scale_label' | 'duplicate_scale_code' | 'scale_not_set_up';
export type ProductError = CatalogueError | 'limit_reached' | 'unknown_category' | 'unknown_tax_rule';
export type Fail<E> = { ok: false; error: E; detail?: string }; // detail = the offending SKU, barcode, or scale code

export function fail<E extends string>(error: E, detail?: string): Fail<E> {
  return detail === undefined ? { ok: false, error } : { ok: false, error, detail };
}

export const isUuid = (value: unknown): value is string => z.uuid().safeParse(value).success;

const pesewas = z.number().int().min(0).max(2_000_000_000);
const optionalText = (max: number) => z.string().trim().max(max).optional().transform((v) => v || null);

const fieldsSchema = z.object({
  name: z.string().trim().min(1).max(120),
  description: optionalText(2000),
  categoryId: z.string().nullable().optional(),
  brand: optionalText(60),
  taxRuleId: z.string().nullable().optional(),
  tracking: z.enum(['none', 'batch', 'serial']),
  showOnStorefront: z.boolean().optional(),
  featured: z.boolean().optional(),
  pharmacy: z.object({
    genericName: optionalText(60), strength: optionalText(60), dosageForm: optionalText(60), registrationNumber: optionalText(60),
    prescriptionOnly: z.boolean().optional(),
  }).optional(),
});
type CleanFields = z.infer<typeof fieldsSchema>;

/** Column values in a fixed order; updateProduct reports changed fields in this order. */
function productColumns(f: CleanFields) {
  return {
    name: f.name,
    description: f.description,
    categoryId: f.categoryId || null,
    brand: f.brand,
    taxRuleId: f.taxRuleId || null,
    tracking: f.tracking,
    showOnStorefront: f.showOnStorefront ?? false,
    featured: f.featured ?? false,
    genericName: f.pharmacy?.genericName ?? null,
    strength: f.pharmacy?.strength ?? null,
    dosageForm: f.pharmacy?.dosageForm ?? null,
    registrationNumber: f.pharmacy?.registrationNumber ?? null,
    prescriptionOnly: f.pharmacy?.prescriptionOnly ?? false,
  };
}

const variantSchema = z.object({
  name: z.string().trim().max(60).optional(),
  sku: z.string().optional(),
  barcodes: z.array(z.string()).max(10).optional(),
  basePricePesewas: pesewas,
  costPesewas: pesewas,
  reorderLevel: z.string().optional(),
  scaleItemCode: z.number().int().optional(),
});

export type CleanVariant = {
  name: string; sku: string | null; barcodes: string[]; basePricePesewas: number; costPesewas: number;
  reorderLevel: string | null; scaleItemCode: number | null;
};

/** Trimmed and uppercased; null when empty; undefined when not a valid SKU. */
export function normaliseSku(input: string | null | undefined): string | null | undefined {
  const sku = input?.trim().toUpperCase() ?? '';
  if (!sku) return null;
  return /^[\x21-\x7E]{1,40}$/.test(sku) ? sku : undefined;
}

export function cleanVariant(input: NewVariantInput): CleanVariant | null {
  const parsed = variantSchema.safeParse(input);
  if (!parsed.success) return null;
  const v = parsed.data;
  const sku = normaliseSku(v.sku);
  const codes = (v.barcodes ?? []).map(normaliseBarcode);
  const reorderText = v.reorderLevel?.trim() ?? '';
  const reorderLevel = reorderText ? parseQuantity(reorderText) : null;
  if (sku === undefined || codes.some((c) => c === null) || (reorderText && reorderLevel === null)) return null;
  return {
    name: v.name ?? '', sku, barcodes: codes as string[], basePricePesewas: v.basePricePesewas, costPesewas: v.costPesewas,
    reorderLevel, scaleItemCode: v.scaleItemCode ?? null,
  };
}

/** Serial numbers need whole units; bundles and recipes hold no stock of their own, so they are never tracked or weighed. */
export function trackingAllowed(tracking: Tracking, kind: VariantKind, allowsFractions: boolean, hasScaleCode: boolean): boolean {
  if (kind !== 'standard') return tracking === 'none' && !hasScaleCode;
  return tracking !== 'serial' || (!allowsFractions && !hasScaleCode);
}

/** Spec 6.22: weight labels give grams of a kg item; price labels divide by the base price. Both give fractional quantities. */
export function scaleCodeProblem(
  code: number, layout: ScaleLayout | null,
  v: { kind: VariantKind; tracking: Tracking; allowsFractions: boolean; baseUnit: string; basePricePesewas: number },
): 'scale_not_set_up' | 'invalid_input' | null {
  if (!layout) return 'scale_not_set_up';
  if (code < 1 || code >= 10 ** layout.itemLength) return 'invalid_input';
  if (v.kind !== 'standard' || v.tracking === 'serial' || !v.allowsFractions) return 'invalid_input';
  if (layout.carries === 'weight' && v.baseUnit.toLowerCase() !== 'kg') return 'invalid_input';
  if (layout.carries === 'price' && v.basePricePesewas <= 0) return 'invalid_input';
  return null;
}

export async function scaleLayoutOf(tx: Tx, tenantId: string): Promise<ScaleLayout | null> {
  const [t] = await tx.select({ layout: tenants.scaleBarcode }).from(tenants).where(eq(tenants.id, tenantId));
  return t?.layout ?? null;
}

const firstRepeat = <T>(list: T[]) => list.find((x, i) => list.indexOf(x) !== i);

/** SKUs, barcodes, and scale codes are unique within the request and within the shop (spec 6.3, 4.16). */
export async function checkCodes(
  tx: Tx, tenantId: string, layout: ScaleLayout | null,
  codes: { skus: string[]; barcodes: string[]; scaleCodes: number[] }, exceptVariantId?: string,
): Promise<Fail<CatalogueError> | null> {
  const scaleLike = codes.barcodes.find((c) => matchesScaleLayout(c, layout));
  if (scaleLike) return fail('looks_like_scale_label', scaleLike);
  const repeatedSku = firstRepeat(codes.skus);
  if (repeatedSku) return fail('duplicate_sku', repeatedSku);
  const repeatedCode = firstRepeat(codes.barcodes);
  if (repeatedCode) return fail('duplicate_barcode', repeatedCode);
  const repeatedScale = firstRepeat(codes.scaleCodes);
  if (repeatedScale !== undefined) return fail('duplicate_scale_code', String(repeatedScale));
  const otherVariant = exceptVariantId ? ne(variants.id, exceptVariantId) : undefined;
  if (codes.skus.length) {
    const [hit] = await tx.select({ sku: variants.sku }).from(variants)
      .where(and(eq(variants.tenantId, tenantId), inArray(variants.sku, codes.skus), otherVariant)).limit(1);
    if (hit) return fail('duplicate_sku', hit.sku ?? '');
  }
  if (codes.barcodes.length) {
    const [hit] = await tx.select({ code: barcodes.code }).from(barcodes)
      .where(and(eq(barcodes.tenantId, tenantId), inArray(barcodes.code, codes.barcodes))).limit(1);
    if (hit) return fail('duplicate_barcode', hit.code);
  }
  if (codes.scaleCodes.length) {
    const [hit] = await tx.select({ code: variants.scaleItemCode }).from(variants)
      .where(and(eq(variants.tenantId, tenantId), inArray(variants.scaleItemCode, codes.scaleCodes), otherVariant)).limit(1);
    if (hit) return fail('duplicate_scale_code', String(hit.code));
  }
  return null;
}

/** Inserts a variant with its base unit (factor 1) and its barcodes on that unit. */
export async function insertVariant(
  tx: Tx, tenantId: string, productId: string, shape: { kind: VariantKind; allowsFractions: boolean; baseUnit: string }, v: CleanVariant,
): Promise<{ variantId: string; baseUnitId: string }> {
  const [variant] = await tx.insert(variants).values({
    tenantId, productId, kind: shape.kind, name: v.name, sku: v.sku, allowsFractions: shape.allowsFractions,
    basePricePesewas: v.basePricePesewas, averageCost: String(v.costPesewas), reorderLevel: v.reorderLevel, scaleItemCode: v.scaleItemCode,
  }).returning({ id: variants.id });
  const [unit] = await tx.insert(variantUnits)
    .values({ tenantId, variantId: variant.id, name: shape.baseUnit, factor: '1', isBase: true }).returning({ id: variantUnits.id });
  if (v.barcodes.length) await tx.insert(barcodes).values(v.barcodes.map((code) => ({ tenantId, variantId: variant.id, unitId: unit.id, code })));
  return { variantId: variant.id, baseUnitId: unit.id };
}

/** Row-level security hides other shops' rows, so their ids count as unknown. */
async function refProblem(tx: Tx, f: CleanFields): Promise<'unknown_category' | 'unknown_tax_rule' | null> {
  if (f.categoryId) {
    if (!isUuid(f.categoryId)) return 'unknown_category';
    const [c] = await tx.select({ id: categories.id }).from(categories).where(eq(categories.id, f.categoryId));
    if (!c) return 'unknown_category';
  }
  if (f.taxRuleId) {
    if (!isUuid(f.taxRuleId)) return 'unknown_tax_rule';
    const [r] = await tx.select({ id: taxRules.id }).from(taxRules).where(and(eq(taxRules.id, f.taxRuleId), eq(taxRules.active, true)));
    if (!r) return 'unknown_tax_rule';
  }
  return null;
}

const KINDS: readonly VariantKind[] = ['standard', 'bundle', 'recipe'];

/** Spec 6.3. Opening stock is a stock receipt (Plan 3); photos are added with uploadProductImage. */
export async function createProduct(
  db: Db, ctx: Ctx, input: NewProductInput,
): Promise<{ ok: true; productId: string; variants: Array<{ variantId: string; baseUnitId: string }> } | Fail<ProductError>> {
  assertPermission(ctx, 'manage_products');
  const f = fieldsSchema.safeParse(input);
  const baseUnit = typeof input.baseUnit === 'string' ? input.baseUnit.trim() : '';
  const list = Array.isArray(input.variants) && input.variants.length >= 1 && input.variants.length <= 50 ? input.variants.map(cleanVariant) : [null];
  if (!f.success || !baseUnit || baseUnit.length > 20 || !KINDS.includes(input.kind) || typeof input.allowsFractions !== 'boolean'
    || list.some((v) => v === null)) return fail('invalid_input');
  const clean = list as CleanVariant[];
  const shape = { kind: input.kind, allowsFractions: input.allowsFractions, baseUnit };
  if (!clean.every((v) => trackingAllowed(f.data.tracking, shape.kind, shape.allowsFractions, v.scaleItemCode !== null))) return fail('invalid_input');

  return withTenant(db, ctx.tenantId, async (tx) => {
    await lockTenant(tx, ctx.tenantId);
    if ((await checkPlanLimit(tx, ctx.tenantId, 'products')) === 'limit_reached') return fail('limit_reached');
    const ref = await refProblem(tx, f.data);
    if (ref) return fail(ref);
    const layout = await scaleLayoutOf(tx, ctx.tenantId);
    for (const v of clean) {
      const problem = v.scaleItemCode === null ? null
        : scaleCodeProblem(v.scaleItemCode, layout, { ...shape, tracking: f.data.tracking, basePricePesewas: v.basePricePesewas });
      if (problem) return fail(problem);
    }
    const clash = await checkCodes(tx, ctx.tenantId, layout, {
      skus: clean.flatMap((v) => (v.sku ? [v.sku] : [])),
      barcodes: clean.flatMap((v) => v.barcodes),
      scaleCodes: clean.flatMap((v) => (v.scaleItemCode === null ? [] : [v.scaleItemCode])),
    });
    if (clash) return clash;
    const [product] = await tx.insert(products).values({ tenantId: ctx.tenantId, ...productColumns(f.data) }).returning({ id: products.id });
    const made = [];
    for (const v of clean) made.push(await insertVariant(tx, ctx.tenantId, product.id, shape, v));
    await writeAudit(tx, { tenantId: ctx.tenantId, actorType: 'user', actorId: ctx.userId, action: 'product_created', recordType: 'product', recordId: product.id });
    return { ok: true, productId: product.id, variants: made } as const;
  });
}

export async function updateProduct(db: Db, ctx: Ctx, productId: string, input: ProductFields): Promise<{ ok: true } | Fail<ProductError | 'not_found' | 'in_use'>> {
  assertPermission(ctx, 'manage_products');
  const f = fieldsSchema.safeParse(input);
  if (!f.success) return fail('invalid_input');
  if (!isUuid(productId)) return fail('not_found');

  return withTenant(db, ctx.tenantId, async (tx) => {
    await lockTenant(tx, ctx.tenantId);
    const [old] = await tx.select().from(products).where(eq(products.id, productId));
    if (!old) return fail('not_found');
    const saved = await tx.select({ id: variants.id, kind: variants.kind, allowsFractions: variants.allowsFractions, scaleItemCode: variants.scaleItemCode })
      .from(variants).where(eq(variants.productId, productId));
    if (!saved.every((v) => trackingAllowed(f.data.tracking, v.kind, v.allowsFractions, v.scaleItemCode !== null))) return fail('invalid_input');
    // stock is held per batch or serial; switching the mode after stock or sales exist would orphan that history
    if (f.data.tracking !== old.tracking && await variantsInUse(tx, saved.map((v) => v.id))) return fail('in_use');
    const ref = await refProblem(tx, f.data);
    if (ref) return fail(ref);
    const next = productColumns(f.data);
    // a field the caller leaves out keeps its saved value: pages hide fields when a module is off, and hiding must never erase
    const keep = <K extends keyof typeof next>(...keys: K[]) => { for (const k of keys) next[k] = old[k] as (typeof next)[K]; };
    if (input.description === undefined) keep('description');
    if (input.categoryId === undefined) keep('categoryId');
    if (input.brand === undefined) keep('brand');
    if (input.taxRuleId === undefined) keep('taxRuleId');
    if (input.showOnStorefront === undefined) keep('showOnStorefront');
    if (input.featured === undefined) keep('featured');
    if (input.pharmacy === undefined) keep('genericName', 'strength', 'dosageForm', 'registrationNumber', 'prescriptionOnly');
    const changed = (Object.keys(next) as Array<keyof typeof next>).filter((k) => next[k] !== old[k]);
    if (changed.length) {
      await tx.update(products).set(next).where(eq(products.id, productId));
      await writeAudit(tx, {
        tenantId: ctx.tenantId, actorType: 'user', actorId: ctx.userId, action: 'product_updated', recordType: 'product', recordId: productId,
        changes: { fields: changed },
      });
    }
    return { ok: true } as const;
  });
}

/** Restoring counts against the plan limit, so archiving cannot be used to dodge it (spec 4.27). */
export async function setProductStatus(
  db: Db, ctx: Ctx, productId: string, status: CatalogueStatus,
): Promise<{ ok: true } | Fail<'not_found' | 'limit_reached'>> {
  assertPermission(ctx, 'manage_products');
  if (!isUuid(productId)) return fail('not_found');
  return withTenant(db, ctx.tenantId, async (tx) => {
    await lockTenant(tx, ctx.tenantId);
    const [p] = await tx.select({ status: products.status }).from(products).where(eq(products.id, productId));
    if (!p) return fail('not_found');
    if (p.status === status) return { ok: true } as const;
    if (status === 'active' && (await checkPlanLimit(tx, ctx.tenantId, 'products')) === 'limit_reached') return fail('limit_reached');
    await tx.update(products).set({ status }).where(eq(products.id, productId));
    await writeAudit(tx, {
      tenantId: ctx.tenantId, actorType: 'user', actorId: ctx.userId, action: status === 'archived' ? 'product_archived' : 'product_restored',
      recordType: 'product', recordId: productId,
    });
    return { ok: true } as const;
  });
}

export type ProductDetail = typeof products.$inferSelect & {
  categoryName: string | null;
  variants: Array<typeof variants.$inferSelect & {
    units: Array<typeof variantUnits.$inferSelect & { barcodes: Array<{ id: string; code: string }> }>;
    components: Array<{ id: string; variantId: string; name: string; quantity: string; baseUnit: string }>;
  }>;
  images: Array<{ id: string; sortOrder: number; bytes: number; width: number; height: number }>;
};

/** "Shirt – Red, Large", or just the product name for a single variant. */
export const itemLabel = (productName: string, variantName: string) => (variantName ? `${productName} – ${variantName}` : productName);

export async function getProduct(db: Db, ctx: Ctx, productId: string): Promise<ProductDetail | null> {
  assertPermission(ctx, 'manage_products');
  if (!isUuid(productId)) return null;
  return withTenant(db, ctx.tenantId, async (tx) => {
    const [row] = await tx.select({ product: products, categoryName: categories.name }).from(products)
      .leftJoin(categories, eq(categories.id, products.categoryId)).where(eq(products.id, productId));
    if (!row) return null;
    const vs = await tx.select().from(variants).where(eq(variants.productId, productId)).orderBy(asc(variants.createdAt), asc(variants.id));
    const ids = vs.map((v) => v.id);
    const units = await tx.select().from(variantUnits).where(inArray(variantUnits.variantId, ids))
      .orderBy(desc(variantUnits.isBase), asc(variantUnits.createdAt), asc(variantUnits.id));
    const codes = await tx.select({ id: barcodes.id, code: barcodes.code, unitId: barcodes.unitId }).from(barcodes)
      .where(inArray(barcodes.variantId, ids)).orderBy(asc(barcodes.createdAt), asc(barcodes.id));
    const partVariant = sql`${variants.id} = ${components.componentVariantId}`;
    const parts = await tx.select({
      id: components.id, parentVariantId: components.parentVariantId, variantId: components.componentVariantId, quantity: components.quantity,
      productName: products.name, variantName: variants.name, baseUnit: variantUnits.name,
    }).from(components)
      .innerJoin(variants, partVariant)
      .innerJoin(products, eq(products.id, variants.productId))
      .innerJoin(variantUnits, and(eq(variantUnits.variantId, variants.id), eq(variantUnits.isBase, true)))
      .where(inArray(components.parentVariantId, ids)).orderBy(asc(components.createdAt), asc(components.id));
    const images = await tx.select({
      id: productImages.id, sortOrder: productImages.sortOrder, bytes: productImages.bytes, width: productImages.width, height: productImages.height,
    }).from(productImages).where(eq(productImages.productId, productId)).orderBy(asc(productImages.sortOrder), asc(productImages.createdAt));
    return {
      ...row.product,
      categoryName: row.categoryName,
      variants: vs.map((v) => ({
        ...v,
        units: units.filter((u) => u.variantId === v.id)
          .map((u) => ({ ...u, barcodes: codes.filter((c) => c.unitId === u.id).map(({ id, code }) => ({ id, code })) })),
        components: parts.filter((p) => p.parentVariantId === v.id).map((p) => ({
          id: p.id, variantId: p.variantId, name: itemLabel(p.productName, p.variantName), quantity: p.quantity, baseUnit: p.baseUnit,
        })),
      })),
      images,
    };
  });
}

export type CatalogueHit = {
  productId: string; variantId: string; productName: string; variantName: string; sku: string | null;
  basePricePesewas: number; baseUnit: string; status: CatalogueStatus; mainImageId: string | null;
};

/** Readable by any signed-in member: the till searches the catalogue too (spec 4.1, 6.5). */
export async function searchCatalogue(
  db: Db, ctx: Ctx, opts: { query?: string; status?: CatalogueStatus; categoryId?: string; limit?: number; offset?: number },
): Promise<CatalogueHit[]> {
  const query = opts.query?.trim() ?? '';
  const limit = Math.min(Math.max(Math.trunc(opts.limit ?? 50), 1), 200);
  const offset = Math.max(Math.trunc(opts.offset ?? 0), 0);
  const archived = or(eq(products.status, 'archived'), eq(variants.status, 'archived'));
  const pattern = `%${query.replace(/[\\%_]/g, '\\$&')}%`;
  const code = query ? normaliseBarcode(query) : null;
  const matches = query ? or(
    ilike(products.name, pattern), ilike(products.genericName, pattern), ilike(products.brand, pattern),
    ilike(variants.name, pattern), ilike(variants.sku, pattern), ilike(categories.name, pattern),
    code ? sql`exists (select 1 from ${barcodes} where ${barcodes.variantId} = ${variants.id} and ${barcodes.code} = ${code})` : undefined,
  ) : undefined;
  if (opts.categoryId !== undefined && !isUuid(opts.categoryId)) return [];

  return withTenant(db, ctx.tenantId, (tx) => tx.select({
    productId: products.id, variantId: variants.id, productName: products.name, variantName: variants.name, sku: variants.sku,
    basePricePesewas: variants.basePricePesewas, baseUnit: variantUnits.name,
    status: sql<CatalogueStatus>`case when ${archived} then 'archived' else 'active' end`,
    mainImageId: sql<string | null>`(select ${productImages.id} from ${productImages} where ${productImages.productId} = ${products.id}
      order by ${productImages.sortOrder}, ${productImages.createdAt} limit 1)`,
  }).from(products)
    .innerJoin(variants, eq(variants.productId, products.id))
    .innerJoin(variantUnits, and(eq(variantUnits.variantId, variants.id), eq(variantUnits.isBase, true)))
    .leftJoin(categories, eq(categories.id, products.categoryId))
    .where(and(
      (opts.status ?? 'active') === 'archived' ? archived : and(eq(products.status, 'active'), eq(variants.status, 'active')),
      opts.categoryId ? eq(products.categoryId, opts.categoryId) : undefined,
      matches,
    ))
    .orderBy(asc(products.name), asc(variants.createdAt), asc(variants.id))
    .limit(limit).offset(offset));
}

/** Readable by any signed-in member. */
export async function listCategories(db: Db, ctx: Ctx): Promise<Array<{ id: string; name: string }>> {
  return withTenant(db, ctx.tenantId, (tx) => tx.select({ id: categories.id, name: categories.name }).from(categories)
    .orderBy(sql`lower(${categories.name})`));
}

export async function addCategory(db: Db, ctx: Ctx, name: string): Promise<{ ok: true; categoryId: string } | Fail<'invalid_input' | 'duplicate_name'>> {
  assertPermission(ctx, 'manage_products');
  const clean = typeof name === 'string' ? name.trim() : '';
  if (!clean || clean.length > 60) return fail('invalid_input');
  return withTenant(db, ctx.tenantId, async (tx) => {
    await lockTenant(tx, ctx.tenantId);
    const [dup] = await tx.select({ id: categories.id }).from(categories).where(sql`lower(${categories.name}) = lower(${clean})`);
    if (dup) return fail('duplicate_name');
    const [c] = await tx.insert(categories).values({ tenantId: ctx.tenantId, name: clean }).returning({ id: categories.id });
    await writeAudit(tx, { tenantId: ctx.tenantId, actorType: 'user', actorId: ctx.userId, action: 'category_added', recordType: 'category', recordId: c.id });
    return { ok: true, categoryId: c.id } as const;
  });
}

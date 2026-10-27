import 'server-only';
import { and, asc, eq, inArray, notInArray } from 'drizzle-orm';
import { z } from 'zod';
import type { Db } from '@/db/client';
import { addOnGroups, addOnOptions, variantAddOnGroups, variants } from '@/db/schema';
import { withTenant } from '@/db/tenant';
import { parseQuantity } from '@/lib/decimal';
import { writeAudit } from './audit';
import { assertPermission, type Ctx } from './context';
import { foodEnabled } from './food-settings';
import { type Fail, fail, isUuid } from './products';

export type AddOnOptionInput = { id?: string; name: string; pricePesewas: number; ingredientVariantId: string | null; ingredientQuantity: string | null };
export type AddOnGroup = {
  id: string; name: string; minChoices: number; maxChoices: number;
  options: Array<{ id: string; name: string; pricePesewas: number; ingredientVariantId: string | null; ingredientQuantity: string | null; active: boolean }>;
};

const groupSchema = z.object({
  id: z.uuid().optional(), name: z.string().trim().min(1).max(40), minChoices: z.number().int().min(0).max(20), maxChoices: z.number().int().min(1).max(20),
  options: z.array(z.object({
    id: z.uuid().optional(), name: z.string().trim().min(1).max(40), pricePesewas: z.number().int().min(0).max(2_000_000_000),
    ingredientVariantId: z.uuid().nullable(), ingredientQuantity: z.string().max(20).nullable(),
  })).min(1).max(30),
}).refine((g) => g.minChoices <= g.maxChoices);

/** Every add-on group with its options (active and inactive), in order (spec 4.24). */
export async function listAddOnGroups(db: Db, ctx: Ctx): Promise<AddOnGroup[]> {
  if (!ctx.permissions.includes('make_sale')) assertPermission(ctx, 'manage_products');
  return withTenant(db, ctx.tenantId, async (tx) => {
    const groups = await tx.select().from(addOnGroups).orderBy(asc(addOnGroups.name));
    const options = groups.length ? await tx.select().from(addOnOptions).orderBy(asc(addOnOptions.sortOrder)) : [];
    return groups.map((g) => ({
      id: g.id, name: g.name, minChoices: g.minChoices, maxChoices: g.maxChoices,
      options: options.filter((o) => o.groupId === g.id).map((o) => ({
        id: o.id, name: o.name, pricePesewas: o.pricePesewas, ingredientVariantId: o.ingredientVariantId, ingredientQuantity: o.ingredientQuantity, active: o.active,
      })),
    }));
  });
}

type SaveResult = { ok: true; groupId: string } | Fail<'invalid_input' | 'duplicate_name' | 'unknown_item' | 'not_found' | 'module_off'>;

/** Saves a group; options sent with an id are updated, new ones added, and those left out made inactive (never deleted: past sales name them). */
export async function saveAddOnGroup(db: Db, ctx: Ctx, input: {
  id?: string; name: string; minChoices: number; maxChoices: number; options: AddOnOptionInput[];
}): Promise<SaveResult> {
  assertPermission(ctx, 'manage_products');
  const parsed = groupSchema.safeParse(input);
  if (!parsed.success) return fail('invalid_input');
  const g = parsed.data;
  const options = g.options.map((o) => ({ ...o, ingredientQuantity: o.ingredientQuantity === null ? null : parseQuantity(o.ingredientQuantity) }));
  if (options.some((o) => (o.ingredientVariantId === null) !== (o.ingredientQuantity === null) || o.ingredientQuantity === '0.000')) return fail('invalid_input');
  return withTenant(db, ctx.tenantId, async (tx): Promise<SaveResult> => {
    if (!(await foodEnabled(tx))) return fail('module_off');
    const ingredientIds = [...new Set(options.flatMap((o) => (o.ingredientVariantId ? [o.ingredientVariantId] : [])))];
    const found = ingredientIds.length ? await tx.select({ id: variants.id }).from(variants)
      .where(and(inArray(variants.id, ingredientIds), inArray(variants.kind, ['standard', 'recipe']))) : [];
    if (found.length !== ingredientIds.length) return fail('unknown_item');
    const [clash] = await tx.select({ id: addOnGroups.id }).from(addOnGroups).where(eq(addOnGroups.name, g.name)); // exact name; the index catches other cases
    if (clash && clash.id !== g.id) return fail('duplicate_name');
    let groupId = g.id;
    const values = { name: g.name, minChoices: g.minChoices, maxChoices: g.maxChoices };
    try {
      if (groupId) {
        const [row] = await tx.update(addOnGroups).set(values).where(eq(addOnGroups.id, groupId)).returning({ id: addOnGroups.id });
        if (!row) return fail('not_found');
      } else {
        groupId = (await tx.insert(addOnGroups).values({ tenantId: ctx.tenantId, ...values }).returning({ id: addOnGroups.id }))[0].id;
      }
    } catch (e) {
      if ((e as { code?: string; cause?: { code?: string } }).code === '23505' || (e as { cause?: { code?: string } }).cause?.code === '23505') return fail('duplicate_name');
      throw e;
    }
    const kept: string[] = [];
    for (const [i, o] of options.entries()) {
      const row = { name: o.name, pricePesewas: o.pricePesewas, ingredientVariantId: o.ingredientVariantId, ingredientQuantity: o.ingredientQuantity, sortOrder: i, active: true };
      if (o.id) {
        const [updated] = await tx.update(addOnOptions).set(row).where(and(eq(addOnOptions.id, o.id), eq(addOnOptions.groupId, groupId))).returning({ id: addOnOptions.id });
        if (!updated) return fail('not_found');
        kept.push(updated.id);
      } else {
        kept.push((await tx.insert(addOnOptions).values({ tenantId: ctx.tenantId, groupId, ...row }).returning({ id: addOnOptions.id }))[0].id);
      }
    }
    await tx.update(addOnOptions).set({ active: false }).where(and(eq(addOnOptions.groupId, groupId), notInArray(addOnOptions.id, kept)));
    await writeAudit(tx, { tenantId: ctx.tenantId, actorType: 'user', actorId: ctx.userId, action: 'add_on_group_saved', recordType: 'add_on_group', recordId: groupId,
      changes: { name: g.name, options: options.length } });
    return { ok: true, groupId };
  });
}

/** The item's add-on group ids, in order. */
export async function getItemAddOnGroups(db: Db, ctx: Ctx, variantId: string): Promise<string[]> {
  if (!isUuid(variantId)) return [];
  return withTenant(db, ctx.tenantId, async (tx) => (await tx.select({ id: variantAddOnGroups.groupId }).from(variantAddOnGroups)
    .where(eq(variantAddOnGroups.variantId, variantId)).orderBy(asc(variantAddOnGroups.sortOrder))).map((r) => r.id));
}

type LinkResult = { ok: true } | Fail<'invalid_input' | 'unknown_item' | 'not_allowed' | 'module_off'>;

/** Replaces the item's add-on groups; combos and sell-by-amount items have none. */
export async function setItemAddOnGroups(db: Db, ctx: Ctx, variantId: string, groupIds: string[]): Promise<LinkResult> {
  assertPermission(ctx, 'manage_products');
  if (!isUuid(variantId) || !Array.isArray(groupIds) || groupIds.length > 10 || !groupIds.every(isUuid) || new Set(groupIds).size !== groupIds.length) return fail('invalid_input');
  return withTenant(db, ctx.tenantId, async (tx): Promise<LinkResult> => {
    if (!(await foodEnabled(tx))) return fail('module_off');
    const [v] = await tx.select({ kind: variants.kind, sellByAmount: variants.sellByAmount }).from(variants).where(eq(variants.id, variantId)).for('update');
    if (!v) return fail('unknown_item');
    if (v.kind === 'combo' || v.sellByAmount) return fail('not_allowed');
    const known = groupIds.length ? await tx.select({ id: addOnGroups.id }).from(addOnGroups).where(inArray(addOnGroups.id, groupIds)) : [];
    if (known.length !== groupIds.length) return fail('unknown_item');
    await tx.delete(variantAddOnGroups).where(eq(variantAddOnGroups.variantId, variantId));
    if (groupIds.length) await tx.insert(variantAddOnGroups).values(groupIds.map((groupId, i) => ({ tenantId: ctx.tenantId, variantId, groupId, sortOrder: i })));
    await writeAudit(tx, { tenantId: ctx.tenantId, actorType: 'user', actorId: ctx.userId, action: 'item_add_ons_saved', recordType: 'variant', recordId: variantId,
      changes: { groupIds } });
    return { ok: true };
  });
}

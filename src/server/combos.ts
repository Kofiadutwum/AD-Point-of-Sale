import 'server-only';
import { and, asc, eq, inArray, ne } from 'drizzle-orm';
import { z } from 'zod';
import type { Db } from '@/db/client';
import { comboChoices, comboSlots, products, variants } from '@/db/schema';
import { withTenant } from '@/db/tenant';
import { writeAudit } from './audit';
import { assertPermission, type Ctx } from './context';
import { type Fail, itemLabel } from './products';

export type ComboSlotInput = { name: string; minChoices: number; maxChoices: number; choices: Array<{ variantId: string; upgradePesewas: number }> };

const slotsSchema = z.array(z.object({
  name: z.string().trim().min(1).max(40),
  minChoices: z.number().int().min(0).max(30),
  maxChoices: z.number().int().min(1).max(30),
  choices: z.array(z.object({ variantId: z.uuid(), upgradePesewas: z.number().int().min(0).max(10_000_000) })).min(1).max(30),
}).refine((s) => s.minChoices <= s.maxChoices && new Set(s.choices.map((c) => c.variantId)).size === s.choices.length)).min(1).max(10);
const isUuid = (value: string) => z.uuid().safeParse(value).success;

/** A combo's choice slots in order, with the names of the items on offer (spec 6.52). */
export async function getComboSlots(db: Db, ctx: Ctx, comboVariantId: string): Promise<Array<ComboSlotInput & { id: string; choiceNames: Record<string, string> }>> {
  if (!isUuid(comboVariantId)) return [];
  return withTenant(db, ctx.tenantId, async (tx) => {
    const slots = await tx.select().from(comboSlots).where(eq(comboSlots.comboVariantId, comboVariantId)).orderBy(asc(comboSlots.sortOrder));
    if (slots.length === 0) return [];
    const choices = await tx.select({ id: comboChoices.id, slotId: comboChoices.slotId, variantId: comboChoices.variantId, upgradePesewas: comboChoices.upgradePesewas,
      productName: products.name, variantName: variants.name })
      .from(comboChoices).innerJoin(variants, eq(variants.id, comboChoices.variantId)).innerJoin(products, eq(products.id, variants.productId))
      .where(inArray(comboChoices.slotId, slots.map((s) => s.id))).orderBy(asc(comboChoices.upgradePesewas), asc(products.name));
    return slots.map((s) => {
      const mine = choices.filter((c) => c.slotId === s.id);
      return {
        id: s.id, name: s.name, minChoices: s.minChoices, maxChoices: s.maxChoices,
        choices: mine.map((c) => ({ variantId: c.variantId, upgradePesewas: c.upgradePesewas })),
        choiceNames: Object.fromEntries(mine.map((c) => [c.variantId, itemLabel(c.productName, c.variantName)])),
      };
    });
  });
}

/** Replaces every slot of the combo in one go; a choice must be an active standard or recipe item of this shop. */
export async function saveComboSlots(
  db: Db, ctx: Ctx, comboVariantId: string, slots: ComboSlotInput[],
): Promise<{ ok: true } | Fail<'invalid_input' | 'not_a_combo' | 'unknown_item' | 'nested_combo'>> {
  assertPermission(ctx, 'manage_products');
  const parsed = slotsSchema.safeParse(slots);
  if (!parsed.success || !isUuid(comboVariantId)) return { ok: false, error: 'invalid_input' };
  return withTenant(db, ctx.tenantId, async (tx) => {
    const [parent] = await tx.select({ kind: variants.kind }).from(variants).where(eq(variants.id, comboVariantId)).for('update');
    if (!parent || parent.kind !== 'combo') return { ok: false, error: 'not_a_combo' } as const;
    const ids = [...new Set(parsed.data.flatMap((s) => s.choices.map((c) => c.variantId)))];
    const found = await tx.select({ id: variants.id, kind: variants.kind, sellByAmount: variants.sellByAmount, tracking: products.tracking })
      .from(variants).innerJoin(products, eq(products.id, variants.productId)).where(and(inArray(variants.id, ids), eq(variants.status, 'active')));
    if (found.length !== ids.length) return { ok: false, error: 'unknown_item' } as const;
    if (found.some((v) => v.kind === 'combo')) return { ok: false, error: 'nested_combo' } as const;
    // a by-amount item is a pot, not a plate, and a serial item needs its serial at sale: neither can be a combo choice
    if (found.some((v) => (v.kind !== 'standard' && v.kind !== 'recipe') || v.sellByAmount || v.tracking === 'serial')) return { ok: false, error: 'unknown_item' } as const;
    await tx.delete(comboSlots).where(eq(comboSlots.comboVariantId, comboVariantId)); // choices go with their slots (cascade)
    for (const [i, s] of parsed.data.entries()) {
      const [slot] = await tx.insert(comboSlots).values({
        tenantId: ctx.tenantId, comboVariantId, name: s.name, minChoices: s.minChoices, maxChoices: s.maxChoices, sortOrder: i,
      }).returning({ id: comboSlots.id });
      await tx.insert(comboChoices).values(s.choices.map((c) => ({ tenantId: ctx.tenantId, slotId: slot.id, variantId: c.variantId, upgradePesewas: c.upgradePesewas })));
    }
    await writeAudit(tx, { tenantId: ctx.tenantId, actorType: 'user', actorId: ctx.userId, action: 'combo_slots_saved', recordType: 'variant', recordId: comboVariantId,
      changes: { slots: parsed.data.length } });
    return { ok: true } as const;
  });
}

/** Items a combo slot may offer: active, sellable standard or recipe items. */
export async function listChoosableItems(db: Db, ctx: Ctx): Promise<Array<{ variantId: string; label: string }>> {
  assertPermission(ctx, 'manage_products');
  return withTenant(db, ctx.tenantId, async (tx) => (await tx.select({ variantId: variants.id, productName: products.name, variantName: variants.name })
    .from(variants).innerJoin(products, eq(products.id, variants.productId))
    .where(and(eq(variants.status, 'active'), eq(products.status, 'active'), eq(variants.sellable, true), inArray(variants.kind, ['standard', 'recipe']),
      eq(variants.sellByAmount, false), ne(products.tracking, 'serial')))
    .orderBy(asc(products.name), asc(variants.name))).map((v) => ({ variantId: v.variantId, label: itemLabel(v.productName, v.variantName) })));
}

import 'server-only';
import { eq } from 'drizzle-orm';
import { z } from 'zod';
import type { Db } from '@/db/client';
import { tenants, users, variants, wastageEntries } from '@/db/schema';
import { withTenant } from '@/db/tenant';
import { businessDate } from '@/lib/dates';
import { parseQuantity, validSaleQuantity } from '@/lib/decimal';
import { writeAudit } from './audit';
import { assertPermission, type Ctx } from './context';
import { costFor } from './pots';
import type { Fail } from './products';
import { deductRecipe } from './stock';
import { costOf } from './variants';

export type WastageReason = 'spoiled' | 'dropped' | 'staff_meal';
const REASONS: readonly WastageReason[] = ['spoiled', 'dropped', 'staff_meal'];
const isUuid = (value: string) => z.uuid().safeParse(value).success;

/** Spec 4.24: food thrown away or eaten by staff leaves stock with its cost recorded; pot leftovers go through the closing count. */
export async function recordWastage(
  db: Db, ctx: Ctx, input: { branchId: string; variantId: string; quantity: string; reason: WastageReason; note?: string }, now: Date,
): Promise<{ ok: true; costPesewas: number } | Fail<'invalid_input' | 'not_assigned' | 'unknown_item' | 'use_pot_leftover' | 'not_wastable'>> {
  assertPermission(ctx, 'record_kitchen_stock');
  const quantity = typeof input.quantity === 'string' ? parseQuantity(input.quantity) : null;
  const note = typeof input.note === 'string' ? input.note.trim().slice(0, 200) || null : null;
  if (!quantity || !REASONS.includes(input.reason) || typeof input.variantId !== 'string' || typeof input.branchId !== 'string') return { ok: false, error: 'invalid_input' };
  return withTenant(db, ctx.tenantId, async (tx) => {
    const [me] = await tx.select({ branchIds: users.branchIds }).from(users).where(eq(users.id, ctx.userId));
    if (!isUuid(input.branchId) || !me?.branchIds.includes(input.branchId)) return { ok: false, error: 'not_assigned' } as const;
    const [item] = isUuid(input.variantId) ? await tx.select({ kind: variants.kind, sellByAmount: variants.sellByAmount, allowsFractions: variants.allowsFractions })
      .from(variants).where(eq(variants.id, input.variantId)) : [];
    if (!item) return { ok: false, error: 'unknown_item' } as const;
    if (item.kind === 'combo') return { ok: false, error: 'not_wastable' } as const; // its parts vary per sale
    if (item.sellByAmount) return { ok: false, error: 'use_pot_leftover' } as const;
    if (!validSaleQuantity(quantity, item.allowsFractions)) return { ok: false, error: 'invalid_input' } as const;
    const [shop] = await tx.select({ timezone: tenants.timezone, cutoff: tenants.businessDayCutoff }).from(tenants).where(eq(tenants.id, ctx.tenantId));
    const costPesewas = costFor(await costOf(tx, input.variantId), quantity);
    const [w] = await tx.insert(wastageEntries).values({
      tenantId: ctx.tenantId, branchId: input.branchId, variantId: input.variantId, businessDate: businessDate(shop.timezone, shop.cutoff, now),
      quantity, reason: input.reason, costPesewas, note, userId: ctx.userId,
    }).returning({ id: wastageEntries.id });
    await deductRecipe(tx, { tenantId: ctx.tenantId, branchId: input.branchId, userId: ctx.userId }, input.variantId, quantity, 'waste', { type: 'wastage', id: w.id });
    await writeAudit(tx, { tenantId: ctx.tenantId, actorType: 'user', actorId: ctx.userId, action: 'wastage_recorded', recordType: 'wastage', recordId: w.id,
      changes: { variantId: input.variantId, quantity, reason: input.reason, costPesewas } });
    return { ok: true, costPesewas } as const;
  });
}

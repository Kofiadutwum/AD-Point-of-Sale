import 'server-only';
import { and, asc, eq, inArray } from 'drizzle-orm';
import { z } from 'zod';
import type { Db, Tx } from '@/db/client';
import { products, soldOut, tenants, users, variants } from '@/db/schema';
import { withTenant } from '@/db/tenant';
import { businessDate } from '@/lib/dates';
import { writeAudit } from './audit';
import { assertPermission, type Ctx } from './context';
import type { Fail } from './products';

type Target = { branchId: string; variantId: string };
const isUuid = (value: string) => z.uuid().safeParse(value).success;

/** Today's business date for the shop, and whether the user works at `branchId`. */
async function dayAndBranch(tx: Tx, ctx: Ctx, branchId: string, now: Date): Promise<{ day: string; assigned: boolean }> {
  const [shop] = await tx.select({ timezone: tenants.timezone, cutoff: tenants.businessDayCutoff }).from(tenants).where(eq(tenants.id, ctx.tenantId));
  const [user] = await tx.select({ branchIds: users.branchIds }).from(users).where(eq(users.id, ctx.userId));
  return { day: businessDate(shop.timezone, shop.cutoff, now), assigned: isUuid(branchId) && (user?.branchIds.includes(branchId) ?? false) };
}

/** Spec 6.55: sold out for the rest of today at this branch; it clears itself on the next business date. */
export async function markSoldOut(
  db: Db, ctx: Ctx, input: Target, now: Date,
): Promise<{ ok: true } | Fail<'invalid_input' | 'unknown_item' | 'not_assigned'>> {
  assertPermission(ctx, 'mark_sold_out');
  if (typeof input.variantId !== 'string' || typeof input.branchId !== 'string') return { ok: false, error: 'invalid_input' };
  return withTenant(db, ctx.tenantId, async (tx) => {
    const { day, assigned } = await dayAndBranch(tx, ctx, input.branchId, now);
    if (!assigned) return { ok: false, error: 'not_assigned' } as const;
    const [item] = isUuid(input.variantId) ? await tx.select({ id: variants.id }).from(variants).where(eq(variants.id, input.variantId)) : [];
    if (!item) return { ok: false, error: 'unknown_item' } as const;
    const added = await tx.insert(soldOut).values({
      tenantId: ctx.tenantId, branchId: input.branchId, variantId: input.variantId, businessDate: day, setBy: ctx.userId, setAt: now,
    }).onConflictDoNothing().returning({ variantId: soldOut.variantId });
    if (added.length) {
      await writeAudit(tx, { tenantId: ctx.tenantId, actorType: 'user', actorId: ctx.userId, action: 'sold_out', recordType: 'variant', recordId: input.variantId, changes: { branchId: input.branchId, businessDate: day } });
    }
    return { ok: true } as const;
  });
}

export async function markAvailable(
  db: Db, ctx: Ctx, input: Target, now: Date,
): Promise<{ ok: true } | Fail<'invalid_input' | 'not_assigned'>> {
  assertPermission(ctx, 'mark_sold_out');
  if (typeof input.variantId !== 'string' || typeof input.branchId !== 'string') return { ok: false, error: 'invalid_input' };
  return withTenant(db, ctx.tenantId, async (tx) => {
    const { day, assigned } = await dayAndBranch(tx, ctx, input.branchId, now);
    if (!assigned) return { ok: false, error: 'not_assigned' } as const;
    if (!isUuid(input.variantId)) return { ok: true } as const;
    const removed = await tx.delete(soldOut).where(and(
      eq(soldOut.branchId, input.branchId), eq(soldOut.variantId, input.variantId), eq(soldOut.businessDate, day),
    )).returning({ variantId: soldOut.variantId });
    if (removed.length) {
      await writeAudit(tx, { tenantId: ctx.tenantId, actorType: 'user', actorId: ctx.userId, action: 'sold_out_cleared', recordType: 'variant', recordId: input.variantId, changes: { branchId: input.branchId, businessDate: day } });
    }
    return { ok: true } as const;
  });
}

/** Today's sold-out items at a branch, for the till and the kitchen; empty for a branch the user does not work at. */
export async function listSoldOut(db: Db, ctx: Ctx, branchId: string, now: Date): Promise<Array<{ variantId: string; name: string; setAt: Date }>> {
  return withTenant(db, ctx.tenantId, async (tx) => {
    const { day, assigned } = await dayAndBranch(tx, ctx, branchId, now);
    if (!assigned) return [];
    return tx.select({ variantId: soldOut.variantId, name: products.name, setAt: soldOut.setAt }).from(soldOut)
      .innerJoin(variants, eq(variants.id, soldOut.variantId)).innerJoin(products, eq(products.id, variants.productId))
      .where(and(eq(soldOut.branchId, branchId), eq(soldOut.businessDate, day))).orderBy(asc(products.name));
  });
}

/** Which of `variantIds` are sold out at the branch on `day`; for completeSale, the till cache, and the storefront. */
export async function isSoldOut(tx: Tx, branchId: string, variantIds: string[], day: string): Promise<Set<string>> {
  if (variantIds.length === 0) return new Set();
  const rows = await tx.select({ variantId: soldOut.variantId }).from(soldOut)
    .where(and(eq(soldOut.branchId, branchId), eq(soldOut.businessDate, day), inArray(soldOut.variantId, variantIds)));
  return new Set(rows.map((r) => r.variantId));
}

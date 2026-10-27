import 'server-only';
import { and, asc, desc, eq, gt } from 'drizzle-orm';
import { z } from 'zod';
import type { Db } from '@/db/client';
import { branches, kitchenOrders, tenants } from '@/db/schema';
import { asPlatform, withTenant } from '@/db/tenant';
import { businessDate } from '@/lib/dates';
import { writeAudit } from './audit';
import { assertPermission, type Ctx } from './context';
import { newToken, tokenHash } from './crypto';
import type { Fail } from './products';

const READY_SHOWN_MS = 10 * 60_000;
const isUuid = (value: string) => z.uuid().safeParse(value).success;

/** A secret link for a screen facing customers; making a new one stops the old one working. */
export async function createBoardLink(db: Db, ctx: Ctx, branchId: string): Promise<{ ok: true; token: string } | Fail<'unknown_branch'>> {
  assertPermission(ctx, 'manage_devices');
  const token = newToken();
  return withTenant(db, ctx.tenantId, async (tx) => {
    const updated = isUuid(branchId)
      ? await tx.update(branches).set({ boardTokenHash: tokenHash(token) }).where(eq(branches.id, branchId)).returning({ id: branches.id })
      : [];
    if (updated.length === 0) return { ok: false, error: 'unknown_branch' } as const;
    await writeAudit(tx, { tenantId: ctx.tenantId, actorType: 'user', actorId: ctx.userId, action: 'board_link_created', recordType: 'branch', recordId: branchId });
    return { ok: true, token } as const;
  });
}

/** Spec 6.51: order numbers only, never names, phones, or items; a ready number shows for 10 minutes or until collected. */
export async function readReadyBoard(db: Db, input: { slug: string; token: string }, now: Date): Promise<{ branchName: string; preparing: string[]; ready: string[] } | null> {
  if (typeof input.slug !== 'string' || typeof input.token !== 'string' || input.token.length > 100) return null;
  // pre-sign-in: the slug alone names the shop, then everything else runs under its row-level security
  const [shop] = await asPlatform(db, (tx) => tx.select({ id: tenants.id, status: tenants.status, timezone: tenants.timezone, cutoff: tenants.businessDayCutoff })
    .from(tenants).where(eq(tenants.slug, input.slug)));
  if (!shop || shop.status !== 'active') return null;
  return withTenant(db, shop.id, async (tx) => {
    const [branch] = await tx.select({ id: branches.id, name: branches.name }).from(branches).where(eq(branches.boardTokenHash, tokenHash(input.token)));
    if (!branch) return null;
    const today = and(eq(kitchenOrders.branchId, branch.id), eq(kitchenOrders.businessDate, businessDate(shop.timezone, shop.cutoff, now)));
    const preparing = await tx.select({ n: kitchenOrders.orderNumber }).from(kitchenOrders)
      .where(and(today, eq(kitchenOrders.status, 'preparing'))).orderBy(asc(kitchenOrders.sentAt), asc(kitchenOrders.orderNumber));
    const ready = await tx.select({ n: kitchenOrders.orderNumber }).from(kitchenOrders)
      .where(and(today, eq(kitchenOrders.status, 'ready'), gt(kitchenOrders.readyAt, new Date(now.getTime() - READY_SHOWN_MS))))
      .orderBy(desc(kitchenOrders.readyAt), desc(kitchenOrders.orderNumber));
    return { branchName: branch.name, preparing: preparing.map((r) => r.n), ready: ready.map((r) => r.n) };
  });
}

export async function handleBoardGet(db: Db, slug: string, token: string, now: Date): Promise<Response> {
  const board = await readReadyBoard(db, { slug, token }, now);
  return Response.json(board ?? { error: 'not_found' }, { status: board ? 200 : 404, headers: { 'Cache-Control': 'no-store' } });
}

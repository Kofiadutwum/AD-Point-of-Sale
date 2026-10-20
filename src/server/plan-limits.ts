import 'server-only';
import { and, count, eq, ne } from 'drizzle-orm';
import type { Tx } from '@/db/client';
import { branches, plans, products, registers, subscriptions, tenants, users } from '@/db/schema';

export type LimitedResource = 'branches' | 'registers' | 'staff' | 'products';

/** Locks the shop row so concurrent creates in one shop run one after another and cannot both pass a limit. */
export async function lockTenant(tx: Tx, tenantId: string): Promise<void> {
  await tx.select({ id: tenants.id }).from(tenants).where(eq(tenants.id, tenantId)).for('update');
}

async function used(tx: Tx, tenantId: string, resource: LimitedResource): Promise<number> {
  const query = resource === 'branches'
    ? tx.select({ n: count() }).from(branches).where(eq(branches.tenantId, tenantId))
    : resource === 'registers'
      ? tx.select({ n: count() }).from(registers).where(and(eq(registers.tenantId, tenantId), eq(registers.status, 'active')))
      : resource === 'staff'
        ? tx.select({ n: count() }).from(users).where(and(eq(users.tenantId, tenantId), ne(users.status, 'inactive')))
        : tx.select({ n: count() }).from(products).where(and(eq(products.tenantId, tenantId), eq(products.status, 'active')));
  const [{ n }] = await query;
  return n;
}

/** Spec 4.27: checked before a record is created; reaching a limit never deletes anything. */
export async function checkPlanLimit(tx: Tx, tenantId: string, resource: LimitedResource): Promise<'ok' | 'limit_reached'> {
  const [plan] = await tx.select({ limits: plans.limits }).from(subscriptions)
    .innerJoin(plans, eq(plans.id, subscriptions.planId)).where(eq(subscriptions.tenantId, tenantId));
  return (await used(tx, tenantId, resource)) >= plan.limits[resource] ? 'limit_reached' : 'ok';
}

import 'server-only';
import { and, asc, eq, ne, sql } from 'drizzle-orm';
import { z } from 'zod';
import type { Db } from '@/db/client';
import { diningTables, type TableStatus, tenants, tickets, users } from '@/db/schema';
import { withTenant } from '@/db/tenant';
import { writeAudit } from './audit';
import { assertPermission, type Ctx } from './context';
import { type Fail, fail, isUuid } from './products';

export type DiningTable = { id: string; name: string; status: TableStatus; active: boolean; openTicketId: string | null };

/** The branch's tables in order, with any open ticket (spec 4.24). */
export async function listTables(db: Db, ctx: Ctx, branchId: string): Promise<DiningTable[]> {
  if (!ctx.permissions.includes('take_orders')) assertPermission(ctx, 'manage_shop_settings');
  if (!isUuid(branchId)) return [];
  return withTenant(db, ctx.tenantId, async (tx) => tx.select({
    id: diningTables.id, name: diningTables.name, status: diningTables.status, active: diningTables.active, openTicketId: tickets.id,
  }).from(diningTables).leftJoin(tickets, and(eq(tickets.tableId, diningTables.id), eq(tickets.status, 'open')))
    .where(eq(diningTables.branchId, branchId)).orderBy(asc(diningTables.sortOrder), asc(diningTables.name)));
}

const tableSchema = z.object({ id: z.uuid().optional(), branchId: z.uuid(), name: z.string().trim().min(1).max(20), active: z.boolean() });
type SaveTableResult = { ok: true; tableId: string } | Fail<'invalid_input' | 'duplicate_name' | 'not_assigned' | 'not_found'>;

export async function saveTable(db: Db, ctx: Ctx, input: { id?: string; branchId: string; name: string; active: boolean }): Promise<SaveTableResult> {
  assertPermission(ctx, 'manage_shop_settings');
  const parsed = tableSchema.safeParse(input);
  if (!parsed.success) return fail('invalid_input');
  const v = parsed.data;
  return withTenant(db, ctx.tenantId, async (tx): Promise<SaveTableResult> => {
    const [me] = await tx.select({ branchIds: users.branchIds }).from(users).where(eq(users.id, ctx.userId));
    if (!me?.branchIds.includes(v.branchId)) return fail('not_assigned');
    const [clash] = await tx.select({ id: diningTables.id }).from(diningTables).where(and(
      eq(diningTables.branchId, v.branchId), sql`lower(${diningTables.name}) = lower(${v.name})`, v.id ? ne(diningTables.id, v.id) : undefined,
    ));
    if (clash) return fail('duplicate_name');
    const values = { name: v.name, active: v.active };
    const [row] = v.id
      ? await tx.update(diningTables).set(values).where(and(eq(diningTables.id, v.id), eq(diningTables.branchId, v.branchId))).returning({ id: diningTables.id })
      : await tx.insert(diningTables).values({ tenantId: ctx.tenantId, branchId: v.branchId, ...values }).returning({ id: diningTables.id });
    if (!row) return fail('not_found');
    await writeAudit(tx, { tenantId: ctx.tenantId, actorType: 'user', actorId: ctx.userId, action: 'table_saved', recordType: 'dining_table', recordId: row.id, changes: values });
    return { ok: true, tableId: row.id };
  });
}

export async function getServiceChargeBp(db: Db, ctx: Ctx): Promise<number> {
  return withTenant(db, ctx.tenantId, async (tx) => (await tx.select({ bp: tenants.serviceChargeBp }).from(tenants).where(eq(tenants.id, ctx.tenantId)))[0]?.bp ?? 0);
}

/** Spec 6.6: the shop's table service charge in basis points (1000 = 10%), 0 to turn it off. */
export async function saveServiceCharge(db: Db, ctx: Ctx, bp: number): Promise<{ ok: true } | Fail<'invalid_input'>> {
  assertPermission(ctx, 'manage_shop_settings');
  if (!Number.isInteger(bp) || bp < 0 || bp > 2500) return fail('invalid_input');
  return withTenant(db, ctx.tenantId, async (tx) => {
    await tx.update(tenants).set({ serviceChargeBp: bp }).where(eq(tenants.id, ctx.tenantId));
    await writeAudit(tx, { tenantId: ctx.tenantId, actorType: 'user', actorId: ctx.userId, action: 'service_charge_saved', recordType: 'tenant', recordId: ctx.tenantId, changes: { bp } });
    return { ok: true } as const;
  });
}

import 'server-only';
import { and, asc, eq, sql } from 'drizzle-orm';
import { z } from 'zod';
import type { Db } from '@/db/client';
import { branches, registers, users } from '@/db/schema';
import { withTenant } from '@/db/tenant';
import { normaliseGhanaPhone } from '@/lib/contact';
import { writeAudit } from './audit';
import { assertPermission, type Ctx } from './context';
import { checkPlanLimit, lockTenant } from './plan-limits';

const CODE = /^[A-Z0-9]{1,6}$/;

export type Till = Omit<typeof registers.$inferSelect, 'deviceTokenHash'>;
export type BranchWithTills = typeof branches.$inferSelect & { registers: Till[] };

/** Readable by any signed-in member (devices page and staff forms need it); no permission check. */
export async function listBranches(db: Db, ctx: Ctx): Promise<BranchWithTills[]> {
  return withTenant(db, ctx.tenantId, async (tx) => {
    const allBranches = await tx.select().from(branches).orderBy(asc(branches.branchCode));
    const allTills = await tx.select().from(registers).orderBy(asc(registers.registerCode));
    // device token hashes never leave the server module
    const tills: Till[] = allTills.map(({ deviceTokenHash: _hash, ...till }) => till);
    return allBranches.map((b) => ({ ...b, registers: tills.filter((r) => r.branchId === b.id) }));
  });
}

export async function addBranch(
  db: Db, ctx: Ctx, input: { name: string; branchCode: string; address?: string; phone?: string },
): Promise<{ ok: true; branchId: string } | { ok: false; error: 'limit_reached' | 'duplicate_code' | 'invalid_input' }> {
  assertPermission(ctx, 'manage_shop_settings');
  const name = input.name.trim();
  const branchCode = input.branchCode.trim().toUpperCase();
  const phone = input.phone?.trim() ? normaliseGhanaPhone(input.phone) : null;
  if (!name || !CODE.test(branchCode) || (input.phone?.trim() && !phone)) return { ok: false, error: 'invalid_input' };

  return withTenant(db, ctx.tenantId, async (tx) => {
    await lockTenant(tx, ctx.tenantId);
    if ((await checkPlanLimit(tx, ctx.tenantId, 'branches')) === 'limit_reached') return { ok: false, error: 'limit_reached' } as const;
    const [dup] = await tx.select({ id: branches.id }).from(branches)
      .where(and(eq(branches.tenantId, ctx.tenantId), eq(branches.branchCode, branchCode)));
    if (dup) return { ok: false, error: 'duplicate_code' } as const;
    const [branch] = await tx.insert(branches)
      .values({ tenantId: ctx.tenantId, name, branchCode, address: input.address?.trim() || null, phone })
      .returning({ id: branches.id });
    // owners work in every branch, so they can sell on the new branch's tills
    await tx.update(users).set({ branchIds: sql`array_append(${users.branchIds}, ${branch.id}::uuid)` })
      .where(and(eq(users.tenantId, ctx.tenantId), eq(users.rolePreset, 'owner')));
    await writeAudit(tx, { tenantId: ctx.tenantId, actorType: 'user', actorId: ctx.userId, action: 'branch_added', recordType: 'branch', recordId: branch.id });
    return { ok: true, branchId: branch.id } as const;
  });
}

export async function addRegister(
  db: Db, ctx: Ctx, input: { branchId: string; name: string; registerCode: string },
): Promise<{ ok: true; registerId: string } | { ok: false; error: 'limit_reached' | 'duplicate_code' | 'unknown_branch' | 'invalid_input' }> {
  assertPermission(ctx, 'manage_shop_settings');
  const name = input.name.trim();
  const registerCode = input.registerCode.trim().toUpperCase();
  if (!name || !CODE.test(registerCode)) return { ok: false, error: 'invalid_input' };
  if (!z.uuid().safeParse(input.branchId).success) return { ok: false, error: 'unknown_branch' };

  return withTenant(db, ctx.tenantId, async (tx) => {
    await lockTenant(tx, ctx.tenantId);
    // row-level security hides other shops' branches, so they count as unknown
    const [branch] = await tx.select({ id: branches.id }).from(branches).where(eq(branches.id, input.branchId));
    if (!branch) return { ok: false, error: 'unknown_branch' } as const;
    if ((await checkPlanLimit(tx, ctx.tenantId, 'registers')) === 'limit_reached') return { ok: false, error: 'limit_reached' } as const;
    const [dup] = await tx.select({ id: registers.id }).from(registers)
      .where(and(eq(registers.tenantId, ctx.tenantId), eq(registers.registerCode, registerCode)));
    if (dup) return { ok: false, error: 'duplicate_code' } as const;
    const [register] = await tx.insert(registers)
      .values({ tenantId: ctx.tenantId, branchId: branch.id, name, registerCode })
      .returning({ id: registers.id });
    await writeAudit(tx, { tenantId: ctx.tenantId, actorType: 'user', actorId: ctx.userId, action: 'register_added', recordType: 'register', recordId: register.id });
    return { ok: true, registerId: register.id } as const;
  });
}

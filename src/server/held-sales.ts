import 'server-only';
import { and, desc, eq, isNull, sql } from 'drizzle-orm';
import { z } from 'zod';
import type { Db } from '@/db/client';
import { heldSales, registers, users } from '@/db/schema';
import { withTenant } from '@/db/tenant';
import { writeAudit } from './audit';
import { assertPermission, type Ctx } from './context';
import { type DeviceInput, deviceFor } from './device-cache';
import { isUuid } from './products';

// Spec 6.10: an offline sale the server refuses is kept for a manager instead of being dropped.

const reportSchema = z.object({
  saleId: z.uuid(),
  receiptNumber: z.string().min(1).max(40),
  cashierId: z.uuid().nullable(),
  totalPesewas: z.number().int().min(0),
  error: z.string().min(1).max(100),
  sale: z.object({ lines: z.array(z.unknown()).max(200).optional() }).passthrough(),
  deviceCreatedAt: z.iso.datetime(),
  status: z.enum(['held', 'synced']),
});

export async function reportHeldSale(
  db: Db, input: DeviceInput & { report: unknown }, now: Date,
): Promise<{ ok: true } | { ok: false; error: 'device_not_registered' | 'invalid_input' }> {
  const parsed = reportSchema.safeParse(input.report);
  if (!parsed.success) return { ok: false, error: 'invalid_input' };
  const device = await deviceFor(db, input);
  if (!device) return { ok: false, error: 'device_not_registered' };
  const r = parsed.data;
  await withTenant(db, device.tenantId, async (tx) => {
    if (r.status === 'synced') {
      await tx.update(heldSales).set({ resolvedAt: now, resolution: 'synced' })
        .where(and(eq(heldSales.saleId, r.saleId), isNull(heldSales.resolvedAt)));
      return;
    }
    await tx.insert(heldSales).values({
      tenantId: device.tenantId, registerId: device.registerId, saleId: r.saleId, receiptNumber: r.receiptNumber, cashierId: r.cashierId,
      totalPesewas: r.totalPesewas, error: r.error, sale: r.sale, deviceCreatedAt: new Date(r.deviceCreatedAt), reportedAt: now,
    }).onConflictDoUpdate({
      target: [heldSales.tenantId, heldSales.saleId],
      set: { error: r.error, reportedAt: now },
      setWhere: isNull(heldSales.resolvedAt), // a resolved sale is never reopened
    });
  });
  return { ok: true };
}

export type HeldSaleView = {
  id: string; registerName: string; receiptNumber: string; cashierName: string | null; totalPesewas: number; error: string;
  deviceCreatedAt: Date; reportedAt: Date;
};

export async function listHeldSales(db: Db, ctx: Ctx): Promise<HeldSaleView[]> {
  assertPermission(ctx, 'view_dashboard', { allowReadOnly: true });
  return withTenant(db, ctx.tenantId, (tx) => tx.select({
    id: heldSales.id, registerName: registers.name, receiptNumber: heldSales.receiptNumber, cashierName: users.name,
    totalPesewas: heldSales.totalPesewas, error: heldSales.error, deviceCreatedAt: heldSales.deviceCreatedAt, reportedAt: heldSales.reportedAt,
  }).from(heldSales)
    .innerJoin(registers, eq(registers.id, heldSales.registerId))
    .leftJoin(users, sql`${users.id} = ${heldSales.cashierId}`)
    .where(isNull(heldSales.resolvedAt)).orderBy(desc(heldSales.deviceCreatedAt)));
}

export async function resolveHeldSale(
  db: Db, ctx: Ctx, heldSaleId: string, note: string, now: Date,
): Promise<{ ok: true } | { ok: false; error: 'not_found' }> {
  assertPermission(ctx, 'approve_actions');
  if (!isUuid(heldSaleId)) return { ok: false, error: 'not_found' };
  return withTenant(db, ctx.tenantId, async (tx) => {
    const done = await tx.update(heldSales).set({ resolvedAt: now, resolvedBy: ctx.userId, resolution: 'resolved', note: note.trim().slice(0, 500) || null })
      .where(and(eq(heldSales.id, heldSaleId), isNull(heldSales.resolvedAt))).returning({ saleId: heldSales.saleId });
    if (done.length === 0) return { ok: false, error: 'not_found' } as const;
    await writeAudit(tx, {
      tenantId: ctx.tenantId, actorType: 'user', actorId: ctx.userId, action: 'held_sale_resolved', recordType: 'sale', recordId: done[0].saleId, reason: note,
    });
    return { ok: true } as const;
  });
}

import 'server-only';
import { eq } from 'drizzle-orm';
import type { Db } from '@/db/client';
import { branches, registers } from '@/db/schema';
import { withTenant } from '@/db/tenant';
import type { Ctx } from './context';
import { findDeviceRegister } from './devices';

export type TillRegister = { registerId: string; registerCode: string; branchId: string; branchCode: string; lastCounter: number };

/** The till a request sells on: a PIN session's register, else the registered device in the cookie when it belongs to the same shop. */
export async function tillRegister(db: Db, ctx: Ctx, deviceToken: string | undefined): Promise<TillRegister | null> {
  let registerId = ctx.registerId;
  if (!registerId) {
    const device = await findDeviceRegister(db, deviceToken);
    registerId = device && device.tenantId === ctx.tenantId ? device.registerId : null;
  }
  if (!registerId) return null;
  return registerById(db, ctx.tenantId, registerId);
}

export async function registerById(db: Db, tenantId: string, registerId: string): Promise<TillRegister | null> {
  const [r] = await withTenant(db, tenantId, (tx) => tx.select({
    registerId: registers.id, registerCode: registers.registerCode, branchId: registers.branchId, branchCode: branches.branchCode,
    lastCounter: registers.receiptCounter, status: registers.status,
  }).from(registers).innerJoin(branches, eq(branches.id, registers.branchId)).where(eq(registers.id, registerId)));
  if (!r || r.status !== 'active') return null;
  const { status: _status, ...till } = r;
  return till;
}

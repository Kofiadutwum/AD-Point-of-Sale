import 'server-only';
import { and, arrayContains, asc, eq, isNotNull, sql } from 'drizzle-orm';
import { z } from 'zod';
import type { Db } from '@/db/client';
import { registers, sessions, tenants, users } from '@/db/schema';
import { asPlatform, withTenant } from '@/db/tenant';
import { writeAudit } from './audit';
import { assertPermission, type Ctx } from './context';
import { newToken, tokenHash, verifySecret } from './crypto';
import { createSession } from './sessions';

export const PIN_MAX_FAILURES = 5;
export const PIN_LOCK_MINUTES = 15;
export type PinError = 'device_not_registered' | 'not_assigned' | 'pin_locked' | 'wrong_pin';
export type DeviceRegister = { tenantId: string; slug: string; branchId: string; registerId: string; registerName: string };

const isUuid = (value: string) => z.uuid().safeParse(value).success;

/** Makes this device the till; any device registered to it before stops working. */
export async function registerDevice(
  db: Db, ctx: Ctx, registerId: string, now: Date,
): Promise<{ ok: true; deviceToken: string } | { ok: false; error: 'unknown_register' }> {
  assertPermission(ctx, 'manage_devices');
  if (!isUuid(registerId)) return { ok: false, error: 'unknown_register' };
  const deviceToken = newToken();
  return withTenant(db, ctx.tenantId, async (tx) => {
    const updated = await tx.update(registers)
      .set({ deviceTokenHash: tokenHash(deviceToken), deviceRegisteredAt: now })
      .where(and(eq(registers.id, registerId), eq(registers.status, 'active')))
      .returning({ id: registers.id });
    if (updated.length === 0) return { ok: false, error: 'unknown_register' } as const;
    await writeAudit(tx, { tenantId: ctx.tenantId, actorType: 'user', actorId: ctx.userId, action: 'device_registered', recordType: 'register', recordId: registerId });
    return { ok: true, deviceToken } as const;
  });
}

/** Spec 4.9: a lost device stops working; it wipes its cached PINs when it next connects and gets a 401. */
export async function deregisterDevice(
  db: Db, ctx: Ctx, registerId: string,
): Promise<{ ok: true } | { ok: false; error: 'unknown_register' }> {
  assertPermission(ctx, 'manage_devices', { allowReadOnly: true });
  if (!isUuid(registerId)) return { ok: false, error: 'unknown_register' };
  return withTenant(db, ctx.tenantId, async (tx) => {
    const updated = await tx.update(registers).set({ deviceTokenHash: null, deviceRegisteredAt: null })
      .where(eq(registers.id, registerId)).returning({ id: registers.id });
    if (updated.length === 0) return { ok: false, error: 'unknown_register' } as const;
    await tx.delete(sessions).where(eq(sessions.registerId, registerId)); // PIN sessions opened on that till
    await writeAudit(tx, { tenantId: ctx.tenantId, actorType: 'user', actorId: ctx.userId, action: 'device_deregistered', recordType: 'register', recordId: registerId });
    return { ok: true } as const;
  });
}

/** The till a device cookie belongs to; null when unknown, retired, or the shop is not active. */
export async function findDeviceRegister(db: Db, deviceToken: string | undefined): Promise<DeviceRegister | null> {
  if (!deviceToken) return null;
  const [row] = await asPlatform(db, (tx) => tx.select({
    tenantId: registers.tenantId, slug: tenants.slug, branchId: registers.branchId, registerId: registers.id,
    registerName: registers.name, shopStatus: tenants.status,
  }).from(registers).innerJoin(tenants, eq(tenants.id, registers.tenantId))
    .where(and(eq(registers.deviceTokenHash, tokenHash(deviceToken)), eq(registers.status, 'active'))));
  if (!row || row.shopStatus !== 'active') return null;
  const { shopStatus: _status, ...device } = row;
  return device;
}

/** Staff who can switch in on this till: active, on its branch, allowed to sell, with a PIN. */
export async function listTillStaff(db: Db, deviceToken: string | undefined): Promise<Array<{ id: string; name: string }> | null> {
  const device = await findDeviceRegister(db, deviceToken);
  if (!device) return null;
  return withTenant(db, device.tenantId, (tx) => tx.select({ id: users.id, name: users.name }).from(users).where(and(
    eq(users.status, 'active'), isNotNull(users.pinHash),
    arrayContains(users.permissions, ['make_sale']), arrayContains(users.branchIds, [device.branchId]),
  )).orderBy(asc(users.name)));
}

/** Spec 6.1: 5 wrong PINs lock it for 15 minutes; the lock is audited so managers see it. */
export async function switchCashierWithPin(
  db: Db, input: { deviceToken: string | undefined; staffId: string; pin: string }, now: Date,
): Promise<{ ok: true; token: string; expiresAt: Date } | { ok: false; error: PinError }> {
  const device = await findDeviceRegister(db, input.deviceToken);
  if (!device) return { ok: false, error: 'device_not_registered' };
  if (!isUuid(input.staffId)) return { ok: false, error: 'not_assigned' };

  const outcome = await withTenant(db, device.tenantId, async (tx): Promise<{ error: PinError } | { userId: string }> => {
    const [staff] = await tx.select().from(users).where(eq(users.id, input.staffId)).for('update');
    if (!staff || staff.status !== 'active' || !staff.pinHash || !staff.permissions.includes('make_sale')
      || !staff.branchIds.includes(device.branchId)) return { error: 'not_assigned' };
    if (staff.pinLockedUntil && staff.pinLockedUntil.getTime() > now.getTime()) return { error: 'pin_locked' };

    if (!(await verifySecret(staff.pinHash, input.pin))) {
      const [{ failed }] = await tx.update(users).set({ failedPinCount: sql`${users.failedPinCount} + 1` })
        .where(eq(users.id, staff.id)).returning({ failed: users.failedPinCount });
      if (failed >= PIN_MAX_FAILURES) {
        // a fresh 5 tries once the lock ends
        await tx.update(users).set({ pinLockedUntil: new Date(now.getTime() + PIN_LOCK_MINUTES * 60_000), failedPinCount: 0 })
          .where(eq(users.id, staff.id));
        await writeAudit(tx, {
          tenantId: device.tenantId, actorType: 'system', actorId: null, action: 'pin_locked',
          recordType: 'user', recordId: staff.id, changes: { registerId: device.registerId },
        });
      }
      return { error: 'wrong_pin' };
    }
    await tx.update(users).set({ failedPinCount: 0, pinLockedUntil: null }).where(eq(users.id, staff.id));
    await writeAudit(tx, {
      tenantId: device.tenantId, actorType: 'user', actorId: staff.id, action: 'pin_sign_in', changes: { registerId: device.registerId },
    });
    return { userId: staff.id };
  });

  if ('error' in outcome) return { ok: false, error: outcome.error };
  const session = await createSession(db, { tenantId: device.tenantId, userId: outcome.userId, kind: 'pin', registerId: device.registerId }, now);
  return { ok: true, ...session };
}

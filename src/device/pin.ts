import { argon2Verify } from 'hash-wasm';
import type { DeviceCache } from '@/lib/device-contract';
import type { DeviceStore } from './store';

// Spec 6.1 on the device: same limits as src/server/devices.ts (5 wrong PINs lock it for 15 minutes).
export const PIN_MAX_FAILURES = 5;
export const PIN_LOCK_MS = 15 * 60_000;

export type ActiveCashier = { staffId: string; name: string; serverSession: boolean };
type PinResult = { ok: true; cashier: ActiveCashier } | { ok: false; error: 'not_assigned' | 'pin_locked' | 'wrong_pin' | 'offline_off' };

const MESSAGES: Record<string, string> = {
  not_assigned: 'You are not set up to sell on this till.',
  pin_locked: 'PIN locked for 15 minutes.',
  wrong_pin: 'Wrong PIN.',
  offline_off: 'Connect to the internet to continue',
  device_not_registered: 'This device is not registered as a till. Ask a manager to register it.',
};

/** Checks a PIN against the cached argon2id hash; used only when the server cannot be reached. */
export async function verifyPinOffline(store: DeviceStore, cache: DeviceCache, staffId: string, pin: string, now: number): Promise<PinResult> {
  if (!cache.shop.offlineEnabled) return { ok: false, error: 'offline_off' };
  const staff = cache.staff.find((s) => s.id === staffId);
  if (!staff || !staff.permissions.includes('make_sale')) return { ok: false, error: 'not_assigned' };
  if (!staff.pinHash) return { ok: false, error: 'offline_off' };
  const lock = await store.getPinLock(staffId);
  const serverLock = staff.pinLockedUntil ? Date.parse(staff.pinLockedUntil) : 0;
  if ((lock.lockedUntil ?? 0) > now || serverLock > now) return { ok: false, error: 'pin_locked' };
  const valid = /^\d{4,6}$/.test(pin) && await argon2Verify({ password: pin, hash: staff.pinHash }).catch(() => false);
  if (!valid) {
    const failures = (lock.lockedUntil !== null && lock.lockedUntil <= now ? 0 : lock.failures) + 1;
    await store.setPinLock(staffId, failures >= PIN_MAX_FAILURES ? { failures: 0, lockedUntil: now + PIN_LOCK_MS } : { failures, lockedUntil: null });
    return { ok: false, error: 'wrong_pin' };
  }
  await store.setPinLock(staffId, { failures: 0, lockedUntil: null });
  return { ok: true, cashier: { staffId, name: staff.name, serverSession: false } };
}

/** Online first (that also gives the session cookie sync needs); the cached hash only when the server cannot be reached. */
export async function switchCashier(
  deps: { store: DeviceStore; fetch: typeof fetch; slug: string; now: () => number }, staffId: string, pin: string,
): Promise<{ ok: true; cashier: ActiveCashier } | { ok: false; error: string }> {
  let reply: { ok?: boolean; error?: string } | null;
  try {
    const res = await deps.fetch(`/api/${deps.slug}/device/pin`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ staffId, pin }),
    });
    // only a network failure may use the cached hash; an error page from the server or a proxy is not one
    reply = res.ok ? await res.json().catch(() => ({ ok: false })) : { ok: false };
  } catch {
    reply = null; // network failure: fall through to the cached hash
  }
  const cache = await deps.store.getCache();
  if (reply) {
    if (reply.error === 'device_not_registered') { // spec 4.9: a removed device wipes its saved PINs
      await deps.store.wipeCache();
      await deps.store.patchMeta({ deregistered: true });
    }
    if (!reply.ok) return { ok: false, error: MESSAGES[reply.error ?? ''] ?? 'Could not switch cashier. Try again.' };
    const name = cache?.staff.find((s) => s.id === staffId)?.name ?? 'Cashier';
    return { ok: true, cashier: { staffId, name, serverSession: true } };
  }
  if (!cache) return { ok: false, error: 'Connect to the internet to set up this till.' };
  const r = await verifyPinOffline(deps.store, cache, staffId, pin, deps.now());
  return r.ok ? r : { ok: false, error: MESSAGES[r.error] };
}

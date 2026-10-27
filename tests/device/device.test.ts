import 'fake-indexeddb/auto';
import { expect, it } from 'vitest';
import { switchCashier, verifyPinOffline } from '@/device/pin';
import { checkTenders, formatReceiptNumber, OFFLINE_LIMIT_MS, offlineBlock } from '@/device/sale';
import { type DeviceMeta, type OutboxEntry, openDeviceStore } from '@/device/store';
import type { DeviceCache } from '@/lib/device-contract';
import { offlineOrderNumber } from '@/lib/food';
import { hashSecret } from '@/server/crypto';

let n = 0;
const store = () => openDeviceStore(`test-${++n}`);
const now = Date.parse('2026-10-20T10:00:00Z');
const meta: DeviceMeta = { lastSyncAt: now, counter: 0, cacheVersion: 1, deregistered: false, orderCounter: 0, orderCounterDate: null };

async function cacheWith(pin: string | null, extra: Partial<DeviceCache['shop']> = {}): Promise<DeviceCache> {
  return {
    version: 1, generatedAt: new Date(now).toISOString(),
    shop: { name: 'A', timezone: 'Africa/Accra', taxMode: 'inclusive', taxEnabled: false, scaleLayout: null, offlineEnabled: true, canSell: true, businessDayCutoff: '00:00', ...extra },
    register: { id: 'r', name: 'Till 1', registerCode: 'T1', branchId: 'b', branchCode: 'B1', branchName: 'Main' },
    staff: [{ id: 'kofi', name: 'Kofi', permissions: ['make_sale'], pinHash: pin && (await hashSecret(pin)), pinLockedUntil: null }],
    taxRules: [], priceRules: [], products: [], variants: [], units: [], barcodes: [], resolvedHeldSaleIds: [], food: null,
  };
}
const entry = (saleId: string, seq: number): OutboxEntry => ({
  saleId, seq, request: { saleId, receiptNumber: 'x', lines: [], tenders: [], deviceCreatedAt: '' }, totalPesewas: 1,
  status: 'queued', attempts: 0, nextAttemptAt: 0, lastError: null, reported: false,
});

it('hands out receipt counters in order and never lowers them', async () => {
  const s = store();
  expect([await s.takeReceiptCounter(), await s.takeReceiptCounter()]).toEqual([1, 2]);
  await s.raiseCounter(50);
  expect(await s.takeReceiptCounter()).toBe(51);
  await s.raiseCounter(10);
  expect(await s.takeReceiptCounter()).toBe(52);
});

it('lists the outbox oldest first; wiping keeps outbox and counter', async () => {
  const s = store();
  await s.addSale(entry('b', 2));
  await s.addSale(entry('a', 1));
  await s.setCache(await cacheWith('5678'));
  await s.setPinLock('kofi', { failures: 2, lockedUntil: null });
  await s.takeReceiptCounter();
  await s.wipeCache();
  expect((await s.listOutbox()).map((e) => e.saleId)).toEqual(['a', 'b']);
  expect(await s.getCache()).toBeNull();
  expect(await s.getPinLock('kofi')).toEqual({ failures: 0, lockedUntil: null });
  expect((await s.getMeta()).counter).toBe(1);
});

it('blocks offline selling when switched off, read-only, never synced, or last synced over 72 hours ago', async () => {
  const c = await cacheWith(null);
  expect(offlineBlock(c, { ...meta, lastSyncAt: now - OFFLINE_LIMIT_MS }, now)).toBeNull();
  expect(offlineBlock(c, { ...meta, lastSyncAt: now - OFFLINE_LIMIT_MS - 1 }, now)).toBe('Connect to the internet to continue');
  expect(offlineBlock(c, { ...meta, lastSyncAt: null }, now)).toBe('Connect to the internet to continue');
  expect(offlineBlock(await cacheWith(null, { offlineEnabled: false }), meta, now)).toBe('Connect to the internet to continue');
  expect(offlineBlock(await cacheWith(null, { canSell: false }), meta, now)).toMatch(/subscription/);
  expect(offlineBlock(null, meta, now)).toBe('Connect to the internet to continue');
});

it('only cash gives change, and manual payments need a reference', () => {
  expect(checkTenders([{ method: 'cash', amountPesewas: 2000, reference: '' }], 1725)).toEqual({ ok: true, changeDuePesewas: 275 });
  expect(checkTenders([{ method: 'momo_manual', amountPesewas: 2000, reference: 'MP123' }], 1725).ok).toBe(false);
  expect(checkTenders([{ method: 'momo_manual', amountPesewas: 1725, reference: ' ' }], 1725).ok).toBe(false);
  expect(checkTenders([{ method: 'cash', amountPesewas: 1000, reference: '' }], 1725).ok).toBe(false);
  expect(checkTenders([{ method: 'cash', amountPesewas: 1.5, reference: '' }], 1).ok).toBe(false);
  expect(checkTenders([{ method: 'card_terminal', amountPesewas: 725, reference: 'S1' }, { method: 'cash', amountPesewas: 1000, reference: '' }], 1725))
    .toEqual({ ok: true, changeDuePesewas: 0 });
});

it('formats receipt numbers', () => {
  expect(formatReceiptNumber('ACC1', 'T2', 123)).toBe('ACC1-T2-000123');
});

it('verifies a cached argon2id PIN hash and locks after 5 wrong tries for 15 minutes', async () => {
  const s = store();
  const c = await cacheWith('5678');
  expect(await verifyPinOffline(s, c, 'kofi', '5678', now)).toEqual({ ok: true, cashier: { staffId: 'kofi', name: 'Kofi', serverSession: false } });
  for (let i = 0; i < 5; i++) expect(await verifyPinOffline(s, c, 'kofi', '0000', now)).toEqual({ ok: false, error: 'wrong_pin' });
  expect(await verifyPinOffline(s, c, 'kofi', '5678', now + 60_000)).toEqual({ ok: false, error: 'pin_locked' });
  expect((await verifyPinOffline(s, c, 'kofi', '5678', now + 15 * 60_000)).ok).toBe(true);
  const locked = { ...c, staff: [{ ...c.staff[0], pinLockedUntil: new Date(now + 60_000).toISOString() }] };
  expect(await verifyPinOffline(store(), locked, 'kofi', '5678', now)).toEqual({ ok: false, error: 'pin_locked' });
  expect(await verifyPinOffline(s, await cacheWith(null), 'kofi', '5678', now)).toEqual({ ok: false, error: 'offline_off' });
  expect(await verifyPinOffline(s, c, 'nobody', '5678', now)).toEqual({ ok: false, error: 'not_assigned' });
}, 60_000);

it('uses the cached hash only when the server cannot be reached', async () => {
  const s = store();
  await s.setCache(await cacheWith('5678'));
  const deps = (fetch: typeof globalThis.fetch) => ({ store: s, fetch, slug: 'shop-a', now: () => now });
  const reply = (body: unknown) => (async () => Response.json(body)) as typeof fetch;
  expect(await switchCashier(deps(reply({ ok: false, error: 'pin_locked' })), 'kofi', '5678')).toEqual({ ok: false, error: 'PIN locked for 15 minutes.' });
  expect(await switchCashier(deps(reply({ ok: true, staffId: 'kofi' })), 'kofi', '5678'))
    .toEqual({ ok: true, cashier: { staffId: 'kofi', name: 'Kofi', serverSession: true } });
  const down = (async () => { throw new TypeError('Failed to fetch'); }) as typeof fetch;
  expect(await switchCashier(deps(down), 'kofi', '5678')).toEqual({ ok: true, cashier: { staffId: 'kofi', name: 'Kofi', serverSession: false } });
  expect(await switchCashier(deps(down), 'kofi', '1111')).toEqual({ ok: false, error: 'Wrong PIN.' });
}, 60_000);

it('never checks the cached hash when the server answers with an error page', async () => {
  const s = store();
  await s.setCache(await cacheWith('5678'));
  const deps = { store: s, fetch: (async () => new Response('<html>', { status: 503 })) as typeof fetch, slug: 'shop-a', now: () => now };
  expect(await switchCashier(deps, 'kofi', '5678')).toEqual({ ok: false, error: 'Could not switch cashier. Try again.' });
  const proxy = { ...deps, fetch: (async () => new Response('<html>', { status: 404 })) as typeof fetch };
  expect((await switchCashier(proxy, 'kofi', '5678')).ok).toBe(false);
}, 60_000);

it('wipes saved PINs when the server says the device was removed', async () => {
  const s = store();
  await s.setCache(await cacheWith('5678'));
  const deps = { store: s, fetch: (async () => Response.json({ ok: false, error: 'device_not_registered' })) as typeof fetch, slug: 'shop-a', now: () => now };
  expect((await switchCashier(deps, 'kofi', '5678')).ok).toBe(false);
  expect(await s.getCache()).toBeNull();
  expect((await s.getMeta()).deregistered).toBe(true);
}, 60_000);

it('order numbers restart on a new business date', async () => {
  const s = store();
  expect([await s.takeOrderNumber('2026-10-26'), await s.takeOrderNumber('2026-10-26'), await s.takeOrderNumber('2026-10-27')]).toEqual([1, 2, 1]);
});

it('two device stores give different numbers on the same day', async () => {
  const [t1, t2] = [store(), store()];
  const n1 = await t1.takeOrderNumber('2026-10-26');
  const n2 = await t2.takeOrderNumber('2026-10-26');
  expect([offlineOrderNumber('T1', n1), offlineOrderNumber('T2', n2)]).toEqual(['T1-001', 'T2-001']);
});

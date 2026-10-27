import 'fake-indexeddb/auto';
import { expect, it } from 'vitest';
import { refreshCache } from '@/device/refresh';
import { type OutboxEntry, openDeviceStore } from '@/device/store';
import { retryHeld, sendSaleNow, syncOutbox } from '@/device/sync';
import type { DeviceCache } from '@/lib/device-contract';

let n = 0;
const now = Date.parse('2026-10-20T10:00:00Z');
type Handler = (url: string, init?: RequestInit) => Response | Promise<Response>;

/** A fake of Plan 3's sales API and the device routes; records every call. */
function fakeFetch(handler: Handler) {
  const calls: Array<{ url: string; body: unknown }> = [];
  const fetch = (async (url: string, init?: RequestInit) => {
    calls.push({ url, body: init?.body ? JSON.parse(String(init.body)) : null });
    return handler(url, init);
  }) as unknown as typeof globalThis.fetch;
  return { fetch, calls };
}
const ok = (saleId: string, alreadyExisted = false) => Response.json({ ok: true, saleId, status: 'completed', changeDuePesewas: 0, alreadyExisted });
const setup = async (saleIds: string[]) => {
  const store = openDeviceStore(`sync-${++n}`);
  for (const [i, saleId] of saleIds.entries()) {
    const e: OutboxEntry = {
      saleId, seq: i + 1, totalPesewas: 500, status: 'queued', attempts: 0, nextAttemptAt: 0, lastError: null, reported: false,
      request: { saleId, receiptNumber: `B1-T1-00000${i + 1}`, cashierId: 'kofi', lines: [], tenders: [], deviceCreatedAt: new Date(now).toISOString() },
    };
    await store.addSale(e);
  }
  return store;
};
const deps = (store: ReturnType<typeof openDeviceStore>, fetch: typeof globalThis.fetch) => ({ store, fetch, slug: 'shop-a', now: () => now });
const sales = (calls: Array<{ url: string; body: unknown }>) => calls.filter((c) => c.url === '/api/shop-a/sales');

it('sends queued sales oldest first and empties the outbox', async () => {
  const store = await setup(['a', 'b']);
  const f = fakeFetch((_u, init) => ok(JSON.parse(String(init!.body)).saleId));
  expect(await syncOutbox(deps(store, f.fetch))).toMatchObject({ sent: 2, waiting: 0, reachable: true });
  expect(sales(f.calls).map((c) => (c.body as { saleId: string; fromOfflineOutbox: boolean })))
    .toEqual([expect.objectContaining({ saleId: 'a', fromOfflineOutbox: true }), expect.objectContaining({ saleId: 'b' })]);
  expect(await store.listOutbox()).toEqual([]);
});

it('removes a sale the server already has', async () => {
  const store = await setup(['a']);
  expect(await syncOutbox(deps(store, fakeFetch(() => ok('a', true)).fetch))).toMatchObject({ sent: 1 });
  expect(await store.listOutbox()).toEqual([]);
});

it('holds a refused sale for review and keeps syncing the rest', async () => {
  const store = await setup(['a', 'b']);
  const f = fakeFetch((url, init) => {
    if (url.endsWith('/held-sales')) return Response.json({ ok: true });
    const id = JSON.parse(String(init!.body)).saleId;
    return id === 'a' ? Response.json({ ok: false, error: 'cashier_not_allowed' }, { status: 409 }) : ok(id);
  });
  expect(await syncOutbox(deps(store, f.fetch))).toMatchObject({ sent: 1, held: 1 });
  expect(await store.listOutbox()).toEqual([expect.objectContaining({ saleId: 'a', status: 'needs_review', lastError: 'cashier_not_allowed', reported: true })]);
  expect(f.calls.find((c) => c.url.endsWith('/held-sales'))!.body).toMatchObject({ saleId: 'a', status: 'held', error: 'cashier_not_allowed', totalPesewas: 500 });
});

it('keeps everything and backs off when the server is unreachable, down, or missing the route', async () => {
  for (const reply of [() => { throw new TypeError('Failed to fetch'); }, () => new Response('', { status: 503 }), () => new Response('', { status: 404 })]) {
    const store = await setup(['a', 'b']);
    const r = await syncOutbox(deps(store, fakeFetch(reply).fetch));
    expect(r).toMatchObject({ sent: 0, waiting: 2 });
    const [a, b] = await store.listOutbox();
    expect(a).toMatchObject({ status: 'queued', attempts: 1, nextAttemptAt: now + 5000 });
    expect(b).toMatchObject({ attempts: 0 });
  }
});

it('stops and asks for a PIN on 401 or 403', async () => {
  const store = await setup(['a', 'b']);
  const f = fakeFetch(() => Response.json({ ok: false, error: 'forbidden' }, { status: 403 }));
  expect(await syncOutbox(deps(store, f.fetch))).toMatchObject({ needsPin: true, waiting: 2 });
  expect(sales(f.calls)).toHaveLength(1);
});

it('sends each sale once when two syncs run at the same time', async () => {
  const store = await setup(['a', 'b']);
  const f = fakeFetch(async (_u, init) => ok(JSON.parse(String(init!.body)).saleId));
  await Promise.all([syncOutbox(deps(store, f.fetch)), syncOutbox(deps(store, f.fetch))]);
  expect(sales(f.calls)).toHaveLength(2);
});

it('first online attempt: rejected sales leave the outbox, unreachable ones stay as outbox sales', async () => {
  const s1 = await setup(['a']);
  expect(await sendSaleNow(deps(s1, fakeFetch(() => Response.json({ ok: false, error: 'price_changed' }, { status: 409 })).fetch), 'a'))
    .toEqual({ result: 'rejected', error: 'price_changed' });
  expect(await s1.listOutbox()).toEqual([]);
  const s2 = await setup(['a']);
  const f = fakeFetch(() => { throw new TypeError('offline'); });
  expect(await sendSaleNow(deps(s2, f.fetch), 'a')).toEqual({ result: 'queued', needsPin: false });
  expect((f.calls[0].body as { fromOfflineOutbox: boolean }).fromOfflineOutbox).toBe(false);
  expect((await s2.listOutbox())[0]).toMatchObject({ attempts: 1, request: { fromOfflineOutbox: true } });
  const s3 = await setup(['a']);
  expect(await sendSaleNow(deps(s3, fakeFetch(() => ok('a')).fetch), 'a')).toMatchObject({ result: 'sent' });
});

it('lets a held sale be tried again', async () => {
  const store = await setup(['a']);
  await store.putOutbox({ ...(await store.listOutbox())[0], status: 'needs_review', attempts: 3, nextAttemptAt: now + 1e6 });
  await retryHeld(store, 'a');
  expect((await store.listOutbox())[0]).toMatchObject({ status: 'queued', attempts: 0, nextAttemptAt: 0 });
});

const cache = (version: number, resolved: string[] = []): DeviceCache => ({
  version, generatedAt: '', shop: { name: 'A', timezone: 'Africa/Accra', taxMode: 'inclusive', taxEnabled: false, scaleLayout: null, offlineEnabled: true, canSell: true, businessDayCutoff: '00:00' },
  register: { id: 'r', name: 'Till 1', registerCode: 'T1', branchId: 'b', branchCode: 'B1', branchName: 'Main' },
  staff: [{ id: 'kofi', name: 'Kofi', permissions: ['make_sale'], pinHash: 'h', pinLockedUntil: null }],
  taxRules: [], priceRules: [], products: [], variants: [], units: [], barcodes: [], resolvedHeldSaleIds: resolved, food: null, comboSlots: [],
});
const device = (version: number, counter: number | null, resolved: string[] = []) => fakeFetch((url) => {
  if (url.endsWith('/device/cache/version')) return Response.json({ version });
  if (url.endsWith('/device/cache')) return Response.json(cache(version, resolved));
  if (url.endsWith('/register/counter')) return counter === null ? new Response('', { status: 404 }) : Response.json({ registerCode: 'T1', lastCounter: counter });
  return new Response('', { status: 404 });
});

it('restores the receipt counter to the larger of local and server', async () => {
  const store = await setup([]);
  expect(await refreshCache({ ...deps(store, device(1, 40).fetch), force: true })).toBe('updated');
  expect((await store.getMeta()).counter).toBe(40);
  await store.raiseCounter(55);
  await refreshCache({ ...deps(store, device(1, 40).fetch), force: true });
  expect((await store.getMeta()).counter).toBe(55);
  expect(await refreshCache({ ...deps(store, device(1, null).fetch), force: true })).toBe('updated'); // route missing until Plan 3 merges
});

it('wipes PINs but keeps the outbox when the device was removed', async () => {
  const store = await setup(['a']);
  await store.setCache(cache(1));
  const gone = fakeFetch(() => Response.json({ error: 'device_not_registered' }, { status: 401 }));
  expect(await refreshCache({ ...deps(store, gone.fetch), force: true })).toBe('deregistered');
  expect(await store.getCache()).toBeNull();
  expect((await store.getMeta()).deregistered).toBe(true);
  expect(await store.listOutbox()).toHaveLength(1);
});

it('checks only the version within 15 minutes and refetches when it changed', async () => {
  const store = await setup([]);
  await refreshCache({ ...deps(store, device(1, 0).fetch), force: true });
  const same = device(1, 0);
  expect(await refreshCache({ store, fetch: same.fetch, slug: 'shop-a', now: () => now + 60_000 })).toBe('unchanged');
  expect(same.calls.map((c) => c.url)).toEqual(['/api/shop-a/device/cache/version']);
  expect((await store.getMeta()).lastSyncAt).toBe(now + 60_000);
  const changed = device(2, 0);
  expect(await refreshCache({ store, fetch: changed.fetch, slug: 'shop-a', now: () => now + 120_000 })).toBe('updated');
  expect((await store.getCache())!.version).toBe(2);
  expect(await refreshCache({ store, fetch: fakeFetch(() => { throw new TypeError('x'); }).fetch, slug: 'shop-a', now: () => now })).toBe('offline');
});

it('drops held sales a manager resolved', async () => {
  const store = await setup(['a', 'b']);
  await store.putOutbox({ ...(await store.listOutbox())[0], status: 'needs_review' });
  await refreshCache({ ...deps(store, device(3, 0, ['a']).fetch), force: true });
  expect((await store.listOutbox()).map((e) => e.saleId)).toEqual(['b']);
});

it('raises the counter when the first online send hits a duplicate receipt number', async () => {
  const store = await setup(['a']);
  const f = fakeFetch((url) => url.endsWith('/register/counter')
    ? Response.json({ registerCode: 'T1', lastCounter: 70 })
    : Response.json({ ok: false, error: 'duplicate_receipt_number' }, { status: 409 }));
  expect(await sendSaleNow(deps(store, f.fetch), 'a')).toEqual({ result: 'rejected', error: 'duplicate_receipt_number' });
  expect((await store.getMeta()).counter).toBe(70);
});

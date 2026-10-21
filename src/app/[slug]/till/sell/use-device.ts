'use client';
import { useCallback, useEffect, useMemo, useState } from 'react';
import type { PricedLine } from '@/device/catalogue';
import { type ActiveCashier, switchCashier as switchCashierOnDevice } from '@/device/pin';
import { refreshCache, REFRESH_EVERY_MS } from '@/device/refresh';
import { buildSaleRequest, checkTenders, formatReceiptNumber, offlineBlock, type TenderInput } from '@/device/sale';
import { type DeviceMeta, type OutboxEntry, openDeviceStore } from '@/device/store';
import { retryHeld as retryHeldOnDevice, sendSaleNow, type SyncDeps, syncOutbox } from '@/device/sync';
import type { CartTotals } from '@/lib/cart-totals';
import type { DeviceCache } from '@/lib/device-contract';

export type Receipt = {
  saleId: string; receiptNumber: string; at: Date; cashier: string; lines: PricedLine[]; totals: CartTotals;
  tenders: TenderInput[]; changeDuePesewas: number; pending: boolean;
};

const TICK_MS = 60_000;

/** The till's local state: cache, outbox, active cashier, and the refresh/sync loop (spec 6.10). */
export function useDevice(slug: string) {
  const store = useMemo(() => openDeviceStore(slug), [slug]);
  const deps: SyncDeps = useMemo(() => ({ store, fetch: (input, init) => fetch(input, init), slug, now: () => Date.now() }), [store, slug]);
  const [cache, setCache] = useState<DeviceCache | null>(null);
  const [meta, setMeta] = useState<DeviceMeta | null>(null);
  const [outbox, setOutbox] = useState<OutboxEntry[]>([]);
  const [reachable, setReachable] = useState(true);
  const [needsPin, setNeedsPin] = useState(false);
  const [loaded, setLoaded] = useState(false);
  const [cashier, setCashierState] = useState<ActiveCashier | null>(null);

  const setCashier = useCallback((c: ActiveCashier | null) => {
    setCashierState(c);
    try {
      if (c) sessionStorage.setItem(`pos-cashier-${slug}`, JSON.stringify(c));
      else sessionStorage.removeItem(`pos-cashier-${slug}`);
    } catch { /* private mode: the cashier just switches in again after a reload */ }
  }, [slug]);

  const reload = useCallback(async () => {
    const [c, m, o] = await Promise.all([store.getCache(), store.getMeta(), store.listOutbox()]);
    setCache(c);
    setMeta(m);
    setOutbox(o);
    setLoaded(true);
  }, [store]);

  const tick = useCallback(async (force: boolean) => {
    const run = async () => {
      const r = await refreshCache({ ...deps, force });
      if (r === 'updated') void keepPhotos(slug, await store.getCache());
      const s = await syncOutbox(deps);
      setReachable(r !== 'offline' && s.reachable);
      setNeedsPin(s.needsPin);
    };
    if (navigator.locks) await navigator.locks.request(`pos-sync-${slug}`, run); // one tab at a time
    else await run();
    await reload();
  }, [deps, reload, slug, store]);

  useEffect(() => {
    try {
      const saved = sessionStorage.getItem(`pos-cashier-${slug}`);
      if (saved) setCashierState(JSON.parse(saved));
    } catch { /* ignore */ }
    navigator.serviceWorker?.register('/sw.js', { scope: `/${slug}/till/` }).catch(() => {});
    let lastFull = Date.now();
    void reload().then(() => tick(true));
    const timer = setInterval(() => {
      const full = Date.now() - lastFull >= REFRESH_EVERY_MS;
      if (full) lastFull = Date.now();
      void tick(full);
    }, TICK_MS);
    const online = () => void tick(false);
    window.addEventListener('online', online);
    return () => { clearInterval(timer); window.removeEventListener('online', online); };
  }, [reload, slug, tick]);

  const switchCashier = useCallback(async (staffId: string, pin: string) => {
    const r = await switchCashierOnDevice(deps, staffId, pin);
    if (r.ok) {
      setCashier(r.cashier);
      if (r.cashier.serverSession) void tick(false); // a fresh session can send waiting sales
    }
    return r;
  }, [deps, setCashier, tick]);

  const completeSale = useCallback(async (lines: PricedLine[], totals: CartTotals, tenders: TenderInput[]):
    Promise<{ ok: true; receipt: Receipt } | { ok: false; error: string }> => {
    if (!cache || !meta || !cashier) return { ok: false, error: 'Switch in with your PIN first.' };
    if (!cache.staff.find((s) => s.id === cashier.staffId)?.permissions.includes('make_sale')) return { ok: false, error: 'You are not set up to sell on this till.' };
    if (!cache.shop.canSell) return { ok: false, error: 'Your subscription has ended. Renew to sell again.' };
    if (lines.length === 0) return { ok: false, error: 'The cart is empty.' };
    if (!reachable) {
      const block = offlineBlock(cache, meta, Date.now());
      if (block) return { ok: false, error: block };
    }
    const paid = checkTenders(tenders, totals.totalPesewas);
    if (!paid.ok) return paid;
    const now = new Date();
    const counter = await store.takeReceiptCounter();
    const receiptNumber = formatReceiptNumber(cache.register.branchCode, cache.register.registerCode, counter);
    const saleId = crypto.randomUUID();
    const online = reachable && cashier.serverSession;
    const request = buildSaleRequest({
      saleId, receiptNumber, cashierId: cashier.staffId, lines, tenders, tenderIds: tenders.map(() => crypto.randomUUID()), now, fromOfflineOutbox: !online,
    });
    await store.addSale({ saleId, seq: counter, request, totalPesewas: totals.totalPesewas, status: 'queued', attempts: 0, nextAttemptAt: 0, lastError: null, reported: false });
    const receipt: Receipt = { saleId, receiptNumber, at: now, cashier: cashier.name, lines, totals, tenders, changeDuePesewas: paid.changeDuePesewas, pending: true };
    if (online) {
      const r = await sendSaleNow(deps, saleId);
      await reload();
      if (r.result === 'rejected') return { ok: false, error: `The server refused this sale (${r.error.replaceAll('_', ' ')}). Check the cart and try again.` };
      if (r.result === 'sent') return { ok: true, receipt: { ...receipt, pending: false, changeDuePesewas: r.response.changeDuePesewas } };
      setReachable(false);
      setNeedsPin(r.needsPin);
      return { ok: true, receipt };
    }
    await reload();
    void tick(false);
    return { ok: true, receipt };
  }, [cache, cashier, deps, meta, reachable, reload, store, tick]);

  const retryHeld = useCallback(async (saleId: string) => {
    await retryHeldOnDevice(store, saleId);
    await tick(false);
  }, [store, tick]);

  return { loaded, cache, meta, outbox, reachable, needsPin, cashier, setCashier, switchCashier, completeSale, retryHeld };
}

/** Puts every main product photo in the service worker's image cache so the till shows them offline. */
async function keepPhotos(slug: string, cache: DeviceCache | null): Promise<void> {
  if (!cache || !('caches' in window)) return;
  const box = await caches.open('pos-images');
  for (const p of cache.products) {
    if (!p.imageId) continue;
    const url = `/api/${slug}/device/images/${p.imageId}`;
    if (!(await box.match(url))) await box.add(url).catch(() => {});
  }
}
